// Read-only backup of every row in the research tables, via the Supabase CLI (logged in, and linked to
// this project with `npx supabase link`). Rows are saved as PostgreSQL's own jsonb text, so numbers stay
// exact, with the list of applied migrations. The backup is then restored into a local in-memory
// database built from those migrations and compared table by table with the live database.
// Usage: npm run backup:db [-- --label before-some-change]
// Saves to ~/Backups/stock-positioning-tracker/<date>-<time>[-label]/.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const PROJECT = new URL("..", import.meta.url).pathname;
// Each table and the column that orders its rows.
const TABLES: [string, string][] = [
  ["investors", "id"], ["investor_ciks", "cik"], ["securities", "id"], ["security_identifiers", "id"],
  ["collection_runs", "id"], ["filings", "id"], ["holdings", "id"], ["short_interest", "id"],
];
const PAGE = 4000; // Holdings rows per query, to keep each CLI response small.
const FINGERPRINTS = `select jsonb_build_object(${TABLES.map(([table, key]) =>
  `'${table}', (select jsonb_build_array(count(*), md5(coalesce(string_agg(to_jsonb(x)::text, E'\\n' order by ${key}), ''))) from public.${table} x)`).join(",\n")}) as f`;

const scratch = mkdtempSync(join(tmpdir(), "backup-"));

function query<T>(sql: string): T[] {
  const file = join(scratch, "query.sql");
  writeFileSync(file, `set timezone = 'UTC'; ${sql}`);
  const out = execFileSync("npx", ["supabase", "db", "query", "--linked", "-f", file], {
    cwd: PROJECT, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  }).toString();
  return JSON.parse(out.slice(out.indexOf("{"))).rows;
}

async function main() {
  const { values } = parseArgs({ options: { label: { type: "string" } } });
  // The CLI account can hold other projects: back up only the one this app uses.
  const linked = readFileSync(join(PROJECT, "supabase/.temp/project-ref"), "utf8").trim();
  const configured = new URL(process.env.SUPABASE_URL?.trim() || "https://unset").hostname.split(".")[0];
  if (linked !== configured) throw new Error("The Supabase CLI is linked to a different project than SUPABASE_URL; run npx supabase link first.");

  const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const label = values.label?.replace(/[^a-z0-9-]+/gi, "-");
  const out = join(homedir(), "Backups", "stock-positioning-tracker", label ? `${stamp}-${label}` : stamp);
  mkdirSync(out, { recursive: true });

  const live = query<{ f: Record<string, [number, string]> }>(`${FINGERPRINTS};`)[0].f;
  const backup: Record<string, string[]> = {};
  for (const [table, key] of TABLES) {
    backup[table] = [];
    // Holdings are read in pages, ordered by their numeric id.
    for (let after: string | null = null; ;) {
      const where = table === "holdings" && after !== null ? `where id > ${after}` : "";
      const limit = table === "holdings" ? `limit ${PAGE}` : "";
      const rows: { k: string; j: string }[] = query(`select ${key}::text as k, to_jsonb(x)::text as j from public.${table} x ${where} order by ${key} ${limit};`);
      backup[table].push(...rows.map((row) => row.j));
      if (table !== "holdings" || rows.length < PAGE) break;
      after = rows[rows.length - 1].k;
    }
    console.log(`  ${table.padEnd(22)} ${backup[table].length} rows`);
  }
  const migrations = query<{ version: string; name: string }>("select version, name from supabase_migrations.schema_migrations order by version;");
  writeFileSync(join(out, "data.json"), JSON.stringify({ created: new Date().toISOString(), tables: backup, schema_migrations: migrations }));
  writeFileSync(join(out, "live-fingerprints.json"), JSON.stringify(live, null, 2));

  // Restore check: the backup must load into the same schema and reproduce every table exactly.
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;`);
    const dir = join(PROJECT, "supabase/migrations");
    for (const migration of migrations) {
      const file = readdirSync(dir).find((name) => name.startsWith(migration.version));
      if (!file) throw new Error(`Migration ${migration.version} is applied live but missing from supabase/migrations`);
      await db.exec(readFileSync(join(dir, file), "utf8"));
    }
    // Triggers are off while loading, so stored values (such as investor slugs) are kept as they are.
    await db.exec("set session_replication_role = replica; set timezone = 'UTC';");
    for (const [table] of TABLES) {
      const identity = table === "holdings" || table === "short_interest" ? "overriding system value" : "";
      for (let i = 0; i < backup[table].length; i += 5000) {
        await db.query(`insert into public.${table} ${identity} select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
          [`[${backup[table].slice(i, i + 5000).join(",")}]`]);
      }
    }
    const restored = (await db.query<{ f: Record<string, [number, string]> }>(FINGERPRINTS)).rows[0].f;
    const different = TABLES.filter(([table]) => JSON.stringify(restored[table]) !== JSON.stringify(live[table])).map(([table]) => table);
    if (different.length > 0) throw new Error(`The backup does not restore exactly: ${different.join(", ")} differ. Keep it, but do not rely on it.`);
    console.log(`Backup verified: it restores to an exact copy of all ${TABLES.length} tables. Saved in ${out}`);
  } finally {
    await db.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => rmSync(scratch, { recursive: true, force: true }));
