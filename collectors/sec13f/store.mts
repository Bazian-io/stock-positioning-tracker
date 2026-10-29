import { isDeepStrictEqual } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { reportedPortfolio, type ReportedPortfolio } from "./amendments.mts";
import { toUnits, type Filing13F, type Holding } from "./parse.mts";
import type { CikLink } from "./sec.mts";
import { sourceRow, unreportedFields, type HoldingColumns } from "./source-row.mts";

// A parsed filing plus its SEC index metadata and download provenance.
export type SourceFiling = Filing13F & {
  filedAt: string;
  valueMultiplier: 1 | 1000;
  sourceUrl: string;
  sourceChecksum: string;
};

export type FilingResult = {
  accessionNumber: string;
  filingId: string;
  action: "imported" | "already_imported";
  rowsInserted: number;
};

export type QuarterResult = { filings: FilingResult[]; portfolio: ReportedPortfolio<SourceFiling> };

export type FilingIds = { investorId: string; runId: string; originalFilingId: string | null };

type Row = Record<string, unknown>;
type StoredFiling = { filing: Row; holdings: Row[] };
type StoredPortfolio = { filingIds: unknown[]; summary: Row | null };

const INSERT_BATCH_SIZE = 500;
const PAGE_SIZE = 1000; // Supabase's default maximum rows per API response.
const AMOUNT_COLUMNS = new Set(["quantity", "reported_value", "voting_sole", "voting_shared", "voting_none"]);
// Amounts are read as text so large values keep full precision.
export const FILING_COLUMNS =
  "import_status, investor_id, accession_number, report_period, filed_at, form_type, report_type, amendment_type, amendment_number, original_filing_id, reported_entry_count, reported_total_value::text, value_multiplier, has_confidential_omissions, other_managers, source_url, source_checksum";
export const HOLDING_COLUMNS =
  "source_row, reported_cusip, reported_issuer, reported_class, quantity::text, quantity_type, position_type, reported_value::text, investment_discretion, voting_sole::text, voting_shared::text, voting_none::text, other_manager_numbers, raw_row";

export function connect(url: string, secretKey: string): SupabaseClient {
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// supabase-js reports failures in the result instead of throwing.
async function must<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, action: string) {
  const { data, error } = await request;
  if (error) throw new Error(`${action}: ${error.message}`);
  return data as T;
}

export function filingRow(source: SourceFiling, ids: FilingIds) {
  return {
    investor_id: ids.investorId,
    collection_run_id: ids.runId,
    accession_number: source.accessionNumber,
    report_period: source.reportPeriod,
    filed_at: source.filedAt,
    form_type: source.formType,
    report_type: source.reportType,
    amendment_type: source.amendmentType,
    amendment_number: source.amendmentNumber,
    original_filing_id: ids.originalFilingId,
    reported_entry_count: source.entryTotal,
    reported_total_value: source.valueTotal,
    value_multiplier: source.valueMultiplier,
    has_confidential_omissions: source.confidentialOmitted,
    other_managers: source.otherManagers.map((manager) => ({
      relation: manager.relation,
      sequence_number: manager.sequenceNumber,
      cik: manager.cik,
      file_number: manager.fileNumber,
      name: manager.name,
    })),
    source_url: source.sourceUrl,
    source_checksum: source.sourceChecksum,
  };
}

export function holdingRow(filingId: string, holding: Holding) {
  return {
    filing_id: filingId,
    source_row: holding.sourceRow,
    reported_cusip: holding.cusip,
    reported_issuer: holding.issuer,
    reported_class: holding.titleOfClass,
    quantity: holding.quantity,
    quantity_type: holding.quantityType,
    position_type: holding.positionType,
    reported_value: holding.value,
    investment_discretion: holding.investmentDiscretion,
    voting_sole: holding.votingSole,
    voting_shared: holding.votingShared,
    voting_none: holding.votingNone,
    other_manager_numbers: holding.otherManagers,
    raw_row: unreportedFields(holding), // Only what the columns above cannot reproduce.
  };
}

// A stored holding row (HOLDING_COLUMNS) in the shape sourceRow() rebuilds the SEC row from.
function storedColumns(row: Row): HoldingColumns {
  return {
    issuer: row.reported_issuer as string,
    titleOfClass: row.reported_class as string | null,
    cusip: row.reported_cusip as string | null,
    value: row.reported_value as string,
    quantity: row.quantity as string,
    quantityType: row.quantity_type as string,
    positionType: row.position_type as string,
    investmentDiscretion: row.investment_discretion as string | null,
    otherManagers: row.other_manager_numbers as string[],
    votingSole: row.voting_sole as string | null,
    votingShared: row.voting_shared as string | null,
    votingNone: row.voting_none as string | null,
  };
}

function sameAmount(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && toUnits(a) === toUnits(b);
}

// Compares what the database holds with the SEC filing, field by field.
export function compareStored(source: SourceFiling, stored: StoredFiling, ids: FilingIds): string[] {
  const problems: string[] = [];
  if (stored.filing.import_status !== "complete") {
    problems.push(`Filing import_status: expected "complete", database ${JSON.stringify(stored.filing.import_status)}`);
  }
  for (const [column, expected] of Object.entries(filingRow(source, ids))) {
    if (column === "collection_run_id") continue; // The run that first imported the filing.
    const actual = stored.filing[column];
    const same = column === "reported_total_value" ? sameAmount(expected, actual)
      : column === "filed_at" ? Date.parse(String(expected)) === Date.parse(String(actual))
      : isDeepStrictEqual(expected, actual);
    if (!same) problems.push(`Filing ${column}: SEC ${JSON.stringify(expected)}, database ${JSON.stringify(actual)}`);
  }
  if (stored.holdings.length !== source.holdings.length) {
    problems.push(`SEC filing has ${source.holdings.length} rows; database has ${stored.holdings.length}`);
  }
  source.holdings.forEach((holding, index) => {
    const actual = stored.holdings[index] ?? {};
    for (const [column, expected] of Object.entries(holdingRow("", holding))) {
      if (column === "filing_id") continue;
      const same = AMOUNT_COLUMNS.has(column) ? sameAmount(expected, actual[column]) : isDeepStrictEqual(expected, actual[column]);
      if (!same) {
        problems.push(`Row ${holding.sourceRow} ${column}: SEC ${JSON.stringify(expected)}, database ${JSON.stringify(actual[column])}`);
      }
    }
    if (index < stored.holdings.length && !isDeepStrictEqual(sourceRow(storedColumns(actual), (actual.raw_row ?? {}) as Row), holding.raw)) {
      problems.push(`Row ${holding.sourceRow}: the stored columns and raw_row do not rebuild the SEC row`);
    }
  });
  const storedTotal = stored.holdings.reduce(
    (sum, row) => sum + (typeof row.reported_value === "string" ? toUnits(row.reported_value) : BigInt(0)),
    BigInt(0),
  );
  const sourceTotal = source.holdings.reduce((sum, holding) => sum + toUnits(holding.value), BigInt(0));
  if (storedTotal !== sourceTotal) {
    problems.push(`Stored rows sum to ${storedTotal / BigInt(10_000)}; the SEC rows sum to ${sourceTotal / BigInt(10_000)}`);
  }
  return problems;
}

// Checks that the research views use exactly the reported holdings: no replaced filing, no double counting.
export function comparePortfolio(
  expected: ReportedPortfolio<SourceFiling>,
  filingIds: Map<string, string>,
  stored: StoredPortfolio,
): string[] {
  const problems: string[] = [];
  const expectedIds = expected.filings.map((filing) => filingIds.get(filing.accessionNumber)).sort();
  if (!isDeepStrictEqual(expectedIds, [...stored.filingIds].sort())) {
    problems.push(`portfolio_filings uses ${stored.filingIds.length} filing(s); expected ${expected.filings.map((filing) => filing.accessionNumber).join(" + ")}`);
  }
  if (!stored.summary) return [...problems, "quarterly_portfolios has no row for this quarter"];
  if (Number(stored.summary.holding_row_count) !== expected.rows) {
    problems.push(`quarterly_portfolios rows: expected ${expected.rows}, database ${stored.summary.holding_row_count}`);
  }
  if (typeof stored.summary.value_usd !== "string" || toUnits(stored.summary.value_usd) !== expected.valueUnits) {
    problems.push(`quarterly_portfolios value: expected ${expected.valueUnits / BigInt(10_000)}, database ${stored.summary.value_usd}`);
  }
  return problems;
}

async function readStored(db: SupabaseClient, filingId: string): Promise<StoredFiling> {
  const filing = await must<Row>(db.from("filings").select(FILING_COLUMNS).eq("id", filingId).single(), "Read stored filing");
  const holdings: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await must<Row[]>(
      db.from("holdings").select(HOLDING_COLUMNS).eq("filing_id", filingId).order("source_row").range(from, from + PAGE_SIZE - 1),
      "Read stored holdings",
    );
    holdings.push(...page);
    if (page.length < PAGE_SIZE) return { filing, holdings };
  }
}

async function readPortfolio(db: SupabaseClient, investorId: string, reportPeriod: string): Promise<StoredPortfolio> {
  const filings = await must<Row[]>(
    db.from("portfolio_filings").select("filing_id").eq("investor_id", investorId).eq("report_period", reportPeriod),
    "Read portfolio filings",
  );
  const summary = await must<Row | null>(
    db.from("quarterly_portfolios")
      .select("holding_row_count, value_usd::text")
      .eq("investor_id", investorId)
      .eq("report_period", reportPeriod)
      .maybeSingle(),
    "Read quarterly portfolio",
  );
  return { filingIds: filings.map((row) => row.filing_id), summary };
}

export type InvestorRecord = { id: string; name: string; ciks: string[]; links: CikLink[] };

// The investor that has filed under this CIK, with every CIK it has filed under (investor_ciks).
export async function findInvestor(db: SupabaseClient, cik: string): Promise<InvestorRecord | null> {
  const link = await must<{ investor_id: string } | null>(
    db.from("investor_ciks").select("investor_id").eq("cik", cik).maybeSingle(),
    "Look up CIK",
  );
  if (!link) return null;
  const [investor, links] = await Promise.all([
    must<{ id: string; name: string }>(db.from("investors").select("id, name").eq("id", link.investor_id).single(), "Read investor"),
    must<{ cik: string; first_report_period: string | null }[]>(
      db.from("investor_ciks").select("cik, first_report_period").eq("investor_id", link.investor_id).order("cik"),
      "Read investor CIKs",
    ),
  ]);
  return {
    ...investor,
    ciks: links.map((row) => row.cik),
    links: links.map((row) => ({ cik: row.cik, firstReportPeriod: row.first_report_period })),
  };
}

// Records another CIK an investor has filed under. A CIK can belong to one investor only.
export async function linkCik(
  db: SupabaseClient,
  investorId: string,
  cik: string,
  entityName: string,
  sourceReference: string,
  firstReportPeriod: string | null = null, // The CIK counts for the investor from this quarter end on.
): Promise<"linked" | "already_linked"> {
  const existing = await must<{ investor_id: string } | null>(
    db.from("investor_ciks").select("investor_id").eq("cik", cik).maybeSingle(),
    "Look up CIK",
  );
  if (existing && existing.investor_id !== investorId) throw new Error(`CIK ${cik} already belongs to another investor`);
  if (existing) return "already_linked";
  await must(
    db.from("investor_ciks").insert({
      cik, investor_id: investorId, entity_name: entityName, source_reference: sourceReference, first_report_period: firstReportPeriod,
    }),
    "Link CIK",
  );
  return "linked";
}

// A new investor is added under the filing's CIK; the database also records it in investor_ciks.
async function addInvestor(db: SupabaseClient, source: SourceFiling): Promise<InvestorRecord> {
  const created = await must<{ id: string; name: string }>(
    db.from("investors").insert({ name: source.managerName, cik: source.cik }).select("id, name").single(),
    "Add investor",
  );
  return { ...created, ciks: [source.cik], links: [{ cik: source.cik, firstReportPeriod: null }] };
}

// Follows the import protocol in supabase/README.md: pending filing, all source rows, then a
// checked transition to complete. A completed filing is verified, never imported again.
async function importFiling(db: SupabaseClient, source: SourceFiling, ids: FilingIds): Promise<FilingResult> {
  const existing = await must<{ id: string; import_status: string } | null>(
    db.from("filings").select("id, import_status").eq("accession_number", source.accessionNumber).maybeSingle(),
    "Look up filing",
  );
  let filingId: string;
  let action: FilingResult["action"] = "already_imported";
  if (existing?.import_status === "complete") {
    filingId = existing.id;
  } else {
    if (existing) {
      // Left behind by an interrupted or failed run; incomplete data is never public.
      await must(db.from("holdings").delete().eq("filing_id", existing.id), "Remove incomplete holdings");
      await must(db.from("filings").delete().eq("id", existing.id).neq("import_status", "complete"), "Remove incomplete filing");
    }
    const filing = await must<{ id: string }>(
      db.from("filings").insert(filingRow(source, ids)).select("id").single(),
      `Add pending filing ${source.accessionNumber}`,
    );
    filingId = filing.id;
    try {
      for (let start = 0; start < source.holdings.length; start += INSERT_BATCH_SIZE) {
        const batch = source.holdings.slice(start, start + INSERT_BATCH_SIZE).map((holding) => holdingRow(filingId, holding));
        await must(db.from("holdings").insert(batch), `Add holdings for ${source.accessionNumber}`);
      }
      // The database trigger re-checks row count, row numbering and value total before accepting.
      await must(db.from("filings").update({ import_status: "complete" }).eq("id", filingId), `Complete filing ${source.accessionNumber}`);
    } catch (error) {
      // Best effort: keep the original error even if recording the failure also fails.
      await must(db.from("filings").update({ import_status: "failed" }).eq("id", filingId), "Mark filing failed")
        .catch(() => undefined);
      throw error;
    }
    action = "imported";
  }

  const problems = compareStored(source, await readStored(db, filingId), ids);
  if (problems.length > 0) {
    throw new Error(`Stored filing ${source.accessionNumber} does not match the SEC filing:\n- ${problems.slice(0, 10).join("\n- ")}`);
  }
  return { accessionNumber: source.accessionNumber, filingId, action, rowsInserted: action === "imported" ? source.holdings.length : 0 };
}

// Imports one quarter: the original filing, then its amendments in filing order, each linked to the
// original. Re-runs only add amendments filed since, then check the research views again.
export async function importQuarter(db: SupabaseClient, filings: SourceFiling[]): Promise<QuarterResult> {
  const [original, ...amendments] = filings;
  if (!original || original.amendmentType !== "none" || amendments.some((filing) => filing.amendmentType === "none")) {
    throw new Error("Expected one original filing followed by its amendments");
  }
  const portfolio = reportedPortfolio(filings);
  const run = await must<{ id: string }>(
    db.from("collection_runs")
      .insert({
        collector: "sec13f",
        provider: "sec",
        started_at: new Date().toISOString(),
        checkpoint: { report_period: original.reportPeriod, accession_numbers: filings.map((filing) => filing.accessionNumber) },
      })
      .select("id")
      .single(),
    "Start collection run",
  );
  const finishRun = (fields: Row) =>
    must(
      db.from("collection_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run.id),
      "Finish collection run",
    );

  try {
    const investor = (await findInvestor(db, original.cik)) ?? (await addInvestor(db, original));
    const unlinked = [...new Set(filings.map((filing) => filing.cik))].filter((cik) => !investor.ciks.includes(cik));
    if (unlinked.length > 0) {
      throw new Error(`Filed under CIK ${unlinked.join(", ")}, which is not linked to ${investor.name}; link it first with npm run link:cik`);
    }
    const investorId = investor.id;
    const results: FilingResult[] = [];
    let originalFilingId: string | null = null;
    for (const filing of filings) {
      const result = await importFiling(db, filing, { investorId, runId: run.id, originalFilingId });
      if (filing.amendmentType === "none") originalFilingId = result.filingId;
      results.push(result);
    }
    const filingIds = new Map(results.map((result) => [result.accessionNumber, result.filingId]));
    const problems = comparePortfolio(portfolio, filingIds, await readPortfolio(db, investorId, original.reportPeriod));
    if (problems.length > 0) {
      throw new Error(`Research views do not match the reported holdings:\n- ${problems.join("\n- ")}`);
    }
    await finishRun({
      status: "succeeded",
      records_processed: results.reduce((sum, result) => sum + result.rowsInserted, 0),
      checkpoint: {
        report_period: original.reportPeriod,
        filings: results.map((result) => ({ accession_number: result.accessionNumber, action: result.action })),
        reported_rows: portfolio.rows,
        warnings: portfolio.warnings,
      },
    });
    return { filings: results, portfolio };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun({ status: "failed", error_message: message.slice(0, 1000) }).catch(() => undefined);
    throw error;
  }
}
