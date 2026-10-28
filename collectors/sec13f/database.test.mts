import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { reportedPortfolio } from "./amendments.mts";
import { newRows, sampleRows, variant } from "./fixtures/filings.mts";
import {
  comparePortfolio, compareStored, FILING_COLUMNS, filingRow, HOLDING_COLUMNS, holdingRow, type FilingIds, type SourceFiling,
} from "./store.mts";

// Runs the collector's rows through the real migration in a disposable database: written the way
// the Supabase API writes JSON (jsonb_populate_record) and read back as API JSON, so amendment
// handling is checked against the actual constraints, triggers and research views.
type Row = Record<string, unknown>;
let db: PGlite;

before(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  // Supabase provides these roles. Reproduce them only inside this disposable database.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261028000000_initial_research_schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await db.exec("begin; set local role service_role;");
});
afterEach(async () => {
  await db.exec("rollback;");
});
after(async () => {
  await db?.close();
});

async function insert(table: string, row: Row): Promise<string> {
  const columns = Object.keys(row);
  assert.ok([table, ...columns].every((name) => /^[a-z_]+$/.test(name)));
  const result = await db.query<{ id: string }>(
    `insert into public.${table} (${columns}) select ${columns} from jsonb_populate_record(null::public.${table}, $1::jsonb) returning id::text`,
    [JSON.stringify(row)],
  );
  return result.rows[0].id;
}

async function selectJson(sql: string, params: unknown[]): Promise<Row[]> {
  const result = await db.query<{ rows: Row[] }>(`select coalesce(jsonb_agg(api), '[]'::jsonb) as rows from (${sql}) api`, params);
  return result.rows[0].rows;
}

// Imports a quarter in the same order and with the same links as importQuarter, verifies each
// stored filing, and returns what the research views report for the quarter.
async function importQuarter(filings: SourceFiling[]) {
  const runId = await insert("collection_runs", { collector: "sec13f", provider: "sec" });
  const investorId = await insert("investors", { name: filings[0].managerName, cik: filings[0].cik });
  const filingIds = new Map<string, string>();
  let originalFilingId: string | null = null;
  for (const filing of filings) {
    const ids: FilingIds = { investorId, runId, originalFilingId };
    const filingId = await insert("filings", filingRow(filing, ids));
    for (const holding of filing.holdings) await insert("holdings", holdingRow(filingId, holding));
    await db.query("update public.filings set import_status = 'complete' where id = $1", [filingId]);
    const stored = {
      filing: (await selectJson(`select ${FILING_COLUMNS} from public.filings where id = $1`, [filingId]))[0],
      holdings: await selectJson(`select ${HOLDING_COLUMNS} from public.holdings where filing_id = $1 order by source_row`, [filingId]),
    };
    assert.deepEqual(compareStored(filing, stored, ids), []);
    if (filing.amendmentType === "none") originalFilingId = filingId;
    filingIds.set(filing.accessionNumber, filingId);
  }
  const quarter = [investorId, filings[0].reportPeriod];
  const views = {
    filingIds: (await selectJson("select filing_id from public.portfolio_filings where investor_id = $1 and report_period = $2", quarter))
      .map((row) => row.filing_id),
    summary: (await selectJson(
      "select holding_row_count, value_usd::text from public.quarterly_portfolios where investor_id = $1 and report_period = $2",
      quarter,
    ))[0] ?? null,
  };
  return { filingIds, views };
}

test("collector rows fit the schema, and the views add new-holdings amendments to the original", async () => {
  const filings = [
    variant("0000000000-26-000001", "2026-08-14T20:05:04.000Z", "none", 0, sampleRows),
    variant("0000000000-26-000002", "2026-11-14T21:00:00.000Z", "new_holdings", 1, newRows),
  ];
  const { filingIds, views } = await importQuarter(filings);
  assert.deepEqual(comparePortfolio(reportedPortfolio(filings), filingIds, views), []);
  assert.equal(views.filingIds.length, 2);
  assert.equal(views.summary?.holding_row_count, 6);
});

test("the views use the latest restatement plus later new holdings, as the collector expects", async () => {
  const filings = [
    variant("0000000000-26-000001", "2026-08-14T20:05:04.000Z", "none", 0, sampleRows),
    variant("0000000000-26-000002", "2026-08-15T20:00:00.000Z", "new_holdings", 1, [newRows[0]]),
    variant("0000000000-26-000003", "2026-08-16T20:00:00.000Z", "restatement", 2, sampleRows),
    variant("0000000000-26-000004", "2027-05-15T20:00:00.000Z", "new_holdings", 3, [newRows[1]]),
  ];
  const { filingIds, views } = await importQuarter(filings);
  assert.deepEqual(comparePortfolio(reportedPortfolio(filings), filingIds, views), []);
  assert.deepEqual(
    views.filingIds.sort(),
    [filingIds.get("0000000000-26-000003"), filingIds.get("0000000000-26-000004")].sort(),
  );
  assert.equal(views.summary?.holding_row_count, 5);
  // Replaced filings remain stored as amendment history.
  assert.equal((await selectJson("select id from public.filings", [])).length, 4);
});
