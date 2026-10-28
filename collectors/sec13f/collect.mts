// Imports 13F-HR filings and their amendments from SEC EDGAR into Supabase, one quarter at a time:
// the latest quarter, or selected ones. An investor linked to several CIKs (npm run link:cik) is
// searched under all of them.
// Usage: npm run collect:13f -- [--cik 1067983] [--quarter 2026-03-31 | 2026Q1]... [--from 2021Q3 --to 2026Q2] [--dry-run]
import { parseArgs } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportedPortfolio } from "./amendments.mts";
import { parseFullSubmission, toUnits, valueMultiplier } from "./parse.mts";
import {
  createSecClient, findQuarterFilings, fullSubmissionUrl, normalizeCik, normalizeQuarter, quarterRange,
  type FilingIndexEntry, type SecClient,
} from "./sec.mts";
import { connect, findInvestor, importQuarter, type SourceFiling } from "./store.mts";

const BERKSHIRE_HATHAWAY_CIK = "1067983"; // Pilot default.

const FILING_ROLES: Record<SourceFiling["amendmentType"], string> = {
  none: "original",
  restatement: "restatement, replaces the report",
  new_holdings: "new holdings, adds to the report",
};

const formatUsd = (units: bigint) => `$${(units / BigInt(10_000)).toLocaleString("en-US")}`;
const formatRows = (count: number) => `${count} row${count === 1 ? "" : "s"}`;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

async function download(sec: SecClient, entry: FilingIndexEntry): Promise<SourceFiling> {
  const document = await sec.get(fullSubmissionUrl(entry.cik, entry.accessionNumber));
  const parsed = parseFullSubmission(document.text);
  if (parsed.accessionNumber !== entry.accessionNumber || parsed.formType !== entry.form
    || parsed.cik !== entry.cik || parsed.reportPeriod !== entry.reportDate) {
    throw new Error(`Downloaded filing ${entry.accessionNumber} does not match SEC's filing index`);
  }
  return {
    ...parsed,
    filedAt: entry.acceptedAt,
    valueMultiplier: valueMultiplier(entry.acceptedAt),
    sourceUrl: document.url,
    sourceChecksum: document.sha256,
  };
}

// Downloads, checks and (unless db is null) imports one quarter's original filing and its
// amendments, filed under any of the investor's CIKs. quarter undefined means the latest quarter.
async function collect(sec: SecClient, ciks: string[], quarter: string | undefined, db: SupabaseClient | null) {
  const selected = await findQuarterFilings(sec, ciks, quarter);
  const filings: SourceFiling[] = [];
  for (const entry of [selected.original, ...selected.amendments]) filings.push(await download(sec, entry));
  const portfolio = reportedPortfolio(filings);

  console.log(`${filings[0].managerName}, quarter ${selected.reportDate}: ${filings.length} SEC filing(s), each matching its summary page`);
  for (const filing of filings) {
    const role = (filing.amendmentType === "none" ? "original" : `amendment ${filing.amendmentNumber}, ${FILING_ROLES[filing.amendmentType]}`)
      + (ciks.length > 1 ? `, filed under CIK ${filing.cik}` : "");
    const value = formatUsd(toUnits(filing.valueTotal) * BigInt(filing.valueMultiplier));
    console.log(`  ${filing.formType.padEnd(8)} ${filing.accessionNumber} filed ${filing.filedAt.slice(0, 10)} (${role}): ${formatRows(filing.holdings.length)}, ${value}`);
  }
  console.log(`  Reported holdings: ${formatRows(portfolio.rows)}, ${formatUsd(portfolio.valueUnits)} (${portfolio.filings.map((filing) => filing.accessionNumber).join(" + ")})`);
  for (const warning of portfolio.warnings) console.log(`  Warning: ${warning}`);
  if (!db) {
    console.log("  Dry run: database not changed.");
    return;
  }

  const result = await importQuarter(db, filings);
  for (const filing of result.filings) {
    const action = filing.action === "imported" ? `imported ${formatRows(filing.rowsInserted)}` : "already imported, no rows added";
    console.log(`  ${filing.accessionNumber}: ${action}; verified against the SEC filing`);
  }
  console.log("  Research views show exactly the reported holdings.");
}

async function main() {
  const { values } = parseArgs({
    options: {
      cik: { type: "string", default: BERKSHIRE_HATHAWAY_CIK },
      quarter: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const cik = normalizeCik(values.cik);
  if ((values.from === undefined) !== (values.to === undefined)) {
    throw new Error("Use --from and --to together, e.g. --from 2021Q3 --to 2026Q2");
  }
  const selected = [
    ...(values.from && values.to ? quarterRange(values.from, values.to) : []),
    ...(values.quarter ?? []).map(normalizeQuarter),
  ];
  // Selected quarters run oldest first; with none selected, the latest quarter.
  const quarters = selected.length > 0 ? [...new Set(selected)].sort() : [undefined];
  const sec = createSecClient(requireEnv("SEC_USER_AGENT"));
  // Dry runs also read the investor's CIKs when the database is configured; they never write.
  let db: SupabaseClient | null = null;
  if (!values["dry-run"] || (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SECRET_KEY?.trim())) {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    if (new URL(supabaseUrl).protocol !== "https:") throw new Error("SUPABASE_URL must use https");
    db = connect(supabaseUrl, requireEnv("SUPABASE_SECRET_KEY"));
  }
  const investor = db ? await findInvestor(db, cik) : null;
  const ciks = investor?.ciks ?? [cik];
  if (investor && ciks.length > 1) console.log(`${investor.name} has filed under CIKs ${ciks.join(" and ")}.`);
  // One quarter at a time; stops at the first failure. Completed filings are skipped on re-runs.
  for (const quarter of quarters) await collect(sec, ciks, quarter, values["dry-run"] ? null : db);
  if (quarters.length > 1) console.log(`Finished all ${quarters.length} quarters.`);
}

main().catch((error: unknown) => {
  console.error(`13F collector failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
