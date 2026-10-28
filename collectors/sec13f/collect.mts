// Imports original 13F-HR filings from SEC EDGAR into Supabase: the latest, or selected quarters.
// Usage: npm run collect:13f -- [--cik 1067983] [--quarter 2026-03-31 | 2026Q1]... [--dry-run]
import { parseArgs } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFullSubmission, valueMultiplier } from "./parse.mts";
import { createSecClient, findFiling, fullSubmissionUrl, normalizeCik, normalizeQuarter, type SecClient } from "./sec.mts";
import { connect, importFiling } from "./store.mts";

const BERKSHIRE_HATHAWAY_CIK = "1067983"; // Pilot default.

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

// Downloads, checks and (unless db is null) imports one filing. quarter undefined means the latest.
async function collect(sec: SecClient, cik: string, quarter: string | undefined, db: SupabaseClient | null) {
  const selected = await findFiling(sec, cik, "13F-HR", quarter);
  const document = await sec.get(fullSubmissionUrl(cik, selected.accessionNumber));
  const parsed = parseFullSubmission(document.text);
  if (parsed.accessionNumber !== selected.accessionNumber || parsed.cik !== cik || parsed.reportPeriod !== selected.reportDate) {
    throw new Error("Downloaded filing does not match SEC's filing index");
  }
  const source = {
    ...parsed,
    filedAt: selected.acceptedAt,
    valueMultiplier: valueMultiplier(selected.acceptedAt),
    sourceUrl: document.url,
    sourceChecksum: document.sha256,
  };
  const totalUsd = Number(source.valueTotal) * source.valueMultiplier;
  console.log(`${source.managerName} ${source.formType} ${source.accessionNumber}`);
  console.log(`  Quarter ${source.reportPeriod}, filed ${source.filedAt}`);
  console.log(`  ${source.holdings.length} holdings rows, $${totalUsd.toLocaleString("en-US")}: matches the filing's summary page`);
  if (selected.amendments.length > 0) {
    console.log(`  Note: SEC also lists amendments for this quarter (${selected.amendments.join(", ")}), which are not imported yet.`);
  }
  if (!db) {
    console.log("  Dry run: database not changed.");
    return;
  }

  const result = await importFiling(db, source);
  console.log(
    result.action === "imported"
      ? `  Imported ${result.rowsInserted} holdings (filing ${result.filingId}).`
      : `  Already imported (filing ${result.filingId}); no rows added.`,
  );
  console.log(`  Verified ${result.rowsVerified} stored rows against the SEC filing.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      cik: { type: "string", default: BERKSHIRE_HATHAWAY_CIK },
      quarter: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const cik = normalizeCik(values.cik);
  const quarters = values.quarter ? [...new Set(values.quarter.map(normalizeQuarter))] : [undefined];
  const sec = createSecClient(requireEnv("SEC_USER_AGENT"));
  let db: SupabaseClient | null = null;
  if (!values["dry-run"]) {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    if (new URL(supabaseUrl).protocol !== "https:") throw new Error("SUPABASE_URL must use https");
    db = connect(supabaseUrl, requireEnv("SUPABASE_SECRET_KEY"));
  }
  // One quarter at a time; stops at the first failure. Completed quarters are skipped on re-runs.
  for (const quarter of quarters) await collect(sec, cik, quarter, db);
}

main().catch((error: unknown) => {
  console.error(`13F collector failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
