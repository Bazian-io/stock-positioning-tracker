import "server-only";
import { secFilingUrl, type HoldingRow } from "./portfolio";
import { readOnlySupabase } from "./supabase";

export const BERKSHIRE_HATHAWAY_CIK = "0001067983";

export type Investor = { id: string; name: string; cik: string };

export type QuarterSummary = {
  reportPeriod: string;
  valueUsd: number;
  holdingRowCount: number;
  filingCount: number;
  amended: boolean; // The quarter has at least one 13F-HR/A amendment.
  confidentialOmissions: boolean;
};

export type QuarterFiling = {
  accessionNumber: string;
  formType: string;
  amendmentType: "none" | "restatement" | "new_holdings";
  amendmentNumber: number;
  filedAt: string;
  counted: boolean; // Part of the reported holdings; false when a later restatement replaced it.
  secUrl: string;
};

const PAGE_SIZE = 1000; // Supabase's default maximum rows per response.

// supabase-js reports failures in the result instead of throwing.
async function load<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string) {
  const { data, error } = await request;
  if (error) throw new Error(`Could not load ${what}: ${error.message}`);
  return data as T;
}

export async function getInvestor(cik: string): Promise<Investor | null> {
  return load<Investor | null>(
    readOnlySupabase().from("investors").select("id, name, cik").eq("cik", cik).maybeSingle(),
    "investor",
  );
}

export type InvestorSummary = Investor & {
  quarterCount: number;
  firstQuarter: string | null; // Report periods; null when no quarter has been imported yet.
  latestQuarter: string | null;
  latestValueUsd: number | null;
};

// Every investor in the database, by name, with the quarters it has reported (quarterly_portfolios).
export async function getInvestorSummaries(): Promise<InvestorSummary[]> {
  const db = readOnlySupabase();
  const investors = await load<Investor[]>(db.from("investors").select("id, name, cik").order("name"), "investors");
  const quarters: { investor_id: string; report_period: string; value_usd: string }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await load<typeof quarters>(
      db.from("quarterly_portfolios")
        .select("investor_id, report_period, value_usd::text")
        .order("investor_id")
        .order("report_period")
        .range(from, from + PAGE_SIZE - 1),
      "quarterly portfolios",
    );
    quarters.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return investors.map((investor) => {
    const reported = quarters.filter((quarter) => quarter.investor_id === investor.id); // Oldest first.
    const latest = reported.at(-1);
    return {
      ...investor,
      quarterCount: reported.length,
      firstQuarter: reported[0]?.report_period ?? null,
      latestQuarter: latest?.report_period ?? null,
      latestValueUsd: latest ? Number(latest.value_usd) : null,
    };
  });
}

// One row per quarter from the quarterly_portfolios research view, oldest first. Each value
// already applies amendments: the latest original or restatement plus later new holdings.
export async function getQuarterSummaries(investorId: string): Promise<QuarterSummary[]> {
  const db = readOnlySupabase();
  const [rows, amendments] = await Promise.all([
    load<{
      report_period: string;
      value_usd: string;
      holding_row_count: number;
      source_filing_count: number;
      has_confidential_omissions: boolean;
    }[]>(
      db.from("quarterly_portfolios")
        .select("report_period, value_usd::text, holding_row_count, source_filing_count, has_confidential_omissions")
        .eq("investor_id", investorId)
        .order("report_period"),
      "quarterly portfolios",
    ),
    load<{ report_period: string }[]>(
      db.from("filings").select("report_period").eq("investor_id", investorId).eq("form_type", "13F-HR/A"),
      "amendments",
    ),
  ]);
  const amendedPeriods = new Set(amendments.map((row) => row.report_period));
  return rows.map((row) => ({
    reportPeriod: row.report_period,
    valueUsd: Number(row.value_usd),
    holdingRowCount: Number(row.holding_row_count),
    filingCount: Number(row.source_filing_count),
    amended: amendedPeriods.has(row.report_period),
    confidentialOmissions: row.has_confidential_omissions,
  }));
}

// Every reported holding row for one quarter, from the portfolio_holdings research view.
export async function getHoldingRows(investorId: string, reportPeriod: string): Promise<HoldingRow[]> {
  const rows: HoldingRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await load<{
      reported_cusip: string | null;
      reported_issuer: string;
      reported_class: string | null;
      quantity: string;
      quantity_type: string;
      position_type: string;
      value_usd: string;
    }[]>(
      readOnlySupabase()
        .from("portfolio_holdings")
        .select("reported_cusip, reported_issuer, reported_class, quantity::text, quantity_type, position_type, value_usd::text")
        .eq("investor_id", investorId)
        .eq("report_period", reportPeriod)
        .order("filing_id")
        .order("source_row")
        .range(from, from + PAGE_SIZE - 1),
      "holdings",
    );
    rows.push(...page.map((row) => ({
      cusip: row.reported_cusip,
      issuer: row.reported_issuer,
      titleOfClass: row.reported_class,
      shares: Number(row.quantity),
      quantityType: row.quantity_type,
      positionType: row.position_type,
      valueUsd: Number(row.value_usd),
    })));
    if (page.length < PAGE_SIZE) return rows;
  }
}

// The SEC filings stored for one quarter, marking which ones the reported holdings use.
export async function getQuarterFilings(investor: Investor, reportPeriod: string): Promise<QuarterFiling[]> {
  const db = readOnlySupabase();
  const [filings, counted] = await Promise.all([
    load<{
      id: string;
      accession_number: string;
      form_type: string;
      amendment_type: QuarterFiling["amendmentType"];
      amendment_number: number;
      filed_at: string;
    }[]>(
      db.from("filings")
        .select("id, accession_number, form_type, amendment_type, amendment_number, filed_at")
        .eq("investor_id", investor.id)
        .eq("report_period", reportPeriod)
        .order("filed_at"),
      "filings",
    ),
    load<{ filing_id: string }[]>(
      db.from("portfolio_filings").select("filing_id").eq("investor_id", investor.id).eq("report_period", reportPeriod),
      "portfolio filings",
    ),
  ]);
  const countedIds = new Set(counted.map((row) => row.filing_id));
  return filings.map((filing) => ({
    accessionNumber: filing.accession_number,
    formType: filing.form_type,
    amendmentType: filing.amendment_type,
    amendmentNumber: filing.amendment_number,
    filedAt: filing.filed_at,
    counted: countedIds.has(filing.id),
    secUrl: secFilingUrl(investor.cik, filing.accession_number),
  }));
}
