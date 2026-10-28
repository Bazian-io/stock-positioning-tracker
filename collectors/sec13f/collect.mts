// Imports a manager's latest original 13F-HR filing from SEC EDGAR into Supabase.
// Usage: npm run collect:13f -- [--cik 1067983] [--dry-run]
import { parseArgs } from "node:util";
import { parseFullSubmission, valueMultiplier } from "./parse.mts";
import { createSecClient, findLatestFiling, fullSubmissionUrl, normalizeCik } from "./sec.mts";
import { connect, importFiling } from "./store.mts";

const BERKSHIRE_HATHAWAY_CIK = "1067983"; // Pilot default.

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      cik: { type: "string", default: BERKSHIRE_HATHAWAY_CIK },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const cik = normalizeCik(values.cik);
  const sec = createSecClient(requireEnv("SEC_USER_AGENT"));

  const latest = await findLatestFiling(sec, cik, "13F-HR");
  const document = await sec.get(fullSubmissionUrl(cik, latest.accessionNumber));
  const parsed = parseFullSubmission(document.text);
  if (parsed.accessionNumber !== latest.accessionNumber || parsed.cik !== cik || parsed.reportPeriod !== latest.reportDate) {
    throw new Error("Downloaded filing does not match SEC's filing index");
  }
  const source = {
    ...parsed,
    filedAt: latest.acceptedAt,
    valueMultiplier: valueMultiplier(latest.acceptedAt),
    sourceUrl: document.url,
    sourceChecksum: document.sha256,
  };
  const totalUsd = Number(source.valueTotal) * source.valueMultiplier;
  console.log(`${source.managerName} ${source.formType} ${source.accessionNumber}`);
  console.log(`  Quarter ${source.reportPeriod}, filed ${source.filedAt}`);
  console.log(`  ${source.holdings.length} holdings rows, $${totalUsd.toLocaleString("en-US")}: matches the filing's summary page`);
  if (values["dry-run"]) {
    console.log("Dry run: database not changed.");
    return;
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  if (new URL(supabaseUrl).protocol !== "https:") throw new Error("SUPABASE_URL must use https");
  const result = await importFiling(connect(supabaseUrl, requireEnv("SUPABASE_SECRET_KEY")), source);
  console.log(
    result.action === "imported"
      ? `Imported ${result.rowsInserted} holdings (filing ${result.filingId}).`
      : `Already imported (filing ${result.filingId}); no rows added.`,
  );
  console.log(`Verified ${result.rowsVerified} stored rows against the SEC filing.`);
}

main().catch((error: unknown) => {
  console.error(`13F collector failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
