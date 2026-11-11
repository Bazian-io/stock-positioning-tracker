import "server-only";
import { portfolioChanges, type ComparisonConversion, type ComparisonPosition, type ComparisonQuarter } from "./portfolio-changes";
import { getComparisonSecurities, loadAll, loadInBatches } from "./stock-data";
import { exactShareRatio, likelySplit, previousQuarter } from "./stock";
import { readOnlySupabase } from "./supabase";
import { compareInvestors } from "./investor-comparison";
import { load } from "./portfolio-data";
import { cacheResearch } from "./research-cache";

type PositionRow = {
  investor_id: string; report_period: string; reported_cusip: string | null; reported_issuer: string; reported_class: string | null;
  quantity: string; value_usd: string;
};
const COLUMNS = "investor_id, report_period, reported_cusip, reported_issuer, reported_class, quantity::text, value_usd::text";
type PositionTuple = [string, string, string | null, string, string | null, string, string];
const toPosition = (row: PositionRow | PositionTuple): ComparisonPosition => {
  const [investorId, reportPeriod, cusip, issuer, titleOfClass, quantity, value] = Array.isArray(row) ? row : [
    row.investor_id, row.report_period, row.reported_cusip, row.reported_issuer, row.reported_class, row.quantity, row.value_usd,
  ];
  return { investorId, reportPeriod, cusip, issuer, titleOfClass, shares: Number(quantity), valueUsd: Number(value), positionType: "long", quantityType: "SH" };
};

function comparisonPositions(investorIds: string[], periods: string[]) {
  return load<PositionTuple[]>(readOnlySupabase().rpc("comparison_positions", {
    p_investor_ids: investorIds, p_report_periods: periods,
  }), "complete comparison positions");
}

function sharePositionsQuery(periods: string[]) {
  return readOnlySupabase().from("portfolio_positions").select(COLUMNS)
    .in("report_period", periods).eq("position_type", "long").eq("quantity_type", "SH")
    .order("investor_id").order("report_period").order("reported_cusip").order("reported_issuer").order("reported_class");
}

export const getInvestorComparison = cacheResearch("investor-comparison", async (leftId: string, rightId: string, period: string) => {
  const [reports, rows] = await Promise.all([
    load<{ investor_id: string; value_usd: string; has_confidential_omissions: boolean }[]>(
      readOnlySupabase().from("quarterly_portfolios").select("investor_id, value_usd::text, has_confidential_omissions")
        .in("investor_id", [leftId, rightId]).eq("report_period", period), "comparison reports",
    ),
    comparisonPositions([leftId, rightId], [period]),
  ]);
  const positions = rows.map(toPosition);
  const securities = await getComparisonSecurities(positions.flatMap((position) => position.cusip ? [position.cusip] : []));
  const report = (id: string): ComparisonQuarter | undefined => {
    const row = reports.find((report) => report.investor_id === id);
    return row ? { reportPeriod: period, valueUsd: Number(row.value_usd), confidentialOmissions: row.has_confidential_omissions } : undefined;
  };
  const leftReport = report(leftId);
  const rightReport = report(rightId);
  return { leftReport, rightReport, rows: compareInvestors({ period, leftId, rightId, leftReport, rightReport, positions, securities }) };
}, { compress: true });

// Only two quarters of combined share positions are read. Source filings and stored values stay untouched.
const cachedPortfolioChanges = cacheResearch("portfolio-changes", async (investorId: string, current: ComparisonQuarter, previous: ComparisonQuarter) => {
  const db = readOnlySupabase();
  const priorPeriod = previousQuarter(current.reportPeriod);
  const query = () => sharePositionsQuery([priorPeriod, current.reportPeriod]);
  const [rows, actions] = await Promise.all([
    comparisonPositions([investorId], [priorPeriod, current.reportPeriod]),
    loadAll<{ security_id: string; from_cusip: string; shares_per_share: string; effective_date: string; description: string }>(
      (from, to) => db.from("security_conversions").select("security_id, from_cusip, shares_per_share::text, effective_date, description")
        .gt("effective_date", priorPeriod).lte("effective_date", current.reportPeriod).order("id").range(from, to), "quarter corporate actions",
    ),
  ]);
  const positions = rows.map(toPosition);
  const heldCusips = new Set(positions.flatMap((position) => position.cusip ? [position.cusip] : []));
  const conversions: ComparisonConversion[] = actions.filter((action) => heldCusips.has(action.from_cusip)).map((action) => ({
    securityId: action.security_id, fromCusip: action.from_cusip, sharesPerShare: Number(action.shares_per_share),
    effectiveDate: action.effective_date, description: action.description,
  }));
  const securities = await getComparisonSecurities([...heldCusips], conversions.map((conversion) => conversion.securityId));
  const input = { current, previous, positions, securities, conversions };
  const changes = portfolioChanges(input);
  const reverseCandidates = changes.filter((row) => {
    if (row.change.received) return false;
    const ratio = exactShareRatio(row.previous, row.current);
    return ratio !== null && ratio < 1 && likelySplit(row.previous, row.current, [ratio]) !== null;
  });
  if (reverseCandidates.length === 0) return changes;
  // Preserve stock pages' rule: another tracked investor must corroborate an unrecorded reverse split.
  const peers = await loadInBatches(reverseCandidates.flatMap((row) => row.cusips), (batch) => loadAll<PositionRow>(
    (from, to) => query().neq("investor_id", investorId).in("reported_cusip", batch).range(from, to), "reverse split comparisons",
  ));
  return portfolioChanges({ ...input, peers: peers.map(toPosition) });
}, { compress: true });

export function getPortfolioChanges(investorId: string, current: ComparisonQuarter, previous: ComparisonQuarter) {
  // Dashboard summaries carry extra fields; only financial inputs belong in this shared key.
  const quarter = (value: ComparisonQuarter): ComparisonQuarter => ({
    reportPeriod: value.reportPeriod, valueUsd: value.valueUsd, confidentialOmissions: value.confidentialOmissions,
  });
  return cachedPortfolioChanges(investorId, quarter(current), quarter(previous));
}
