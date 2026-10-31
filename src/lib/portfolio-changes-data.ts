import "server-only";
import { portfolioChanges, type ComparisonConversion, type ComparisonPosition, type ComparisonQuarter } from "./portfolio-changes";
import { getComparisonSecurities, loadAll, loadInBatches } from "./stock-data";
import { exactShareRatio, likelySplit, previousQuarter } from "./stock";
import { readOnlySupabase } from "./supabase";

type PositionRow = {
  investor_id: string; report_period: string; reported_cusip: string | null; reported_issuer: string; reported_class: string | null;
  quantity: string; value_usd: string;
};
const COLUMNS = "investor_id, report_period, reported_cusip, reported_issuer, reported_class, quantity::text, value_usd::text";
const toPosition = (row: PositionRow): ComparisonPosition => ({
  investorId: row.investor_id, reportPeriod: row.report_period, cusip: row.reported_cusip,
  issuer: row.reported_issuer, titleOfClass: row.reported_class, shares: Number(row.quantity), valueUsd: Number(row.value_usd),
  positionType: "long", quantityType: "SH",
});

// Only two quarters of combined share positions are read. Source filings and stored values stay untouched.
export async function getPortfolioChanges(investorId: string, current: ComparisonQuarter, previous: ComparisonQuarter) {
  const db = readOnlySupabase();
  const priorPeriod = previousQuarter(current.reportPeriod);
  const query = () => db.from("portfolio_positions").select(COLUMNS)
    .in("report_period", [priorPeriod, current.reportPeriod]).eq("position_type", "long").eq("quantity_type", "SH")
    .order("investor_id").order("report_period").order("reported_cusip").order("reported_issuer").order("reported_class");
  const [rows, actions] = await Promise.all([
    loadAll<PositionRow>((from, to) => query().eq("investor_id", investorId).range(from, to), "positions for quarter comparison"),
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
}
