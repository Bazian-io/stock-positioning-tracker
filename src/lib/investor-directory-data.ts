import "server-only";
import { getInvestorSummaries, load, type InvestorSummary } from "./portfolio-data";
import { getStockLinks, type StockLink } from "./stock-data";
import { readOnlySupabase } from "./supabase";
import { cacheResearch } from "./research-cache";

type DirectoryPosition = { cusip: string | null; issuer: string; valueUsd: number; portfolioShare: number };
export type InvestorDirectoryRow = {
  investor: InvestorSummary;
  period: string | null;
  valueUsd: number | null;
  positions: { total: number; largest: DirectoryPosition | null } | null;
  largestStock: StockLink | null;
};
type SummaryTuple = [string, string, string, string | null, string | null, string | null];

// Cache only the directory's complete display data. Dashboard holdings keep their existing loader.
export const getInvestorDirectory = cacheResearch("investor-directory", async (quarter: string | null): Promise<InvestorDirectoryRow[]> => {
  const investors = await getInvestorSummaries();
  const rows: InvestorDirectoryRow[] = investors.map((investor) => {
    const period = quarter ?? investor.latestQuarter;
    const valueUsd = investor.values.find((summary) => summary.reportPeriod === period)?.valueUsd ?? null;
    return { investor, period, valueUsd, positions: null, largestStock: null };
  });
  // A missing report stays unavailable; a verified empty report has zero positions.
  const reported = rows.filter((row) => row.period !== null && row.valueUsd !== null);
  for (let start = 0; start < reported.length; start += 100) {
    const batch = reported.slice(start, start + 100);
    const summaries = await load<SummaryTuple[]>(readOnlySupabase().rpc("directory_portfolio_summaries", {
      p_investor_ids: batch.map((row) => row.investor.id), p_report_periods: batch.map((row) => row.period),
    }), "directory portfolio summaries");
    const byInvestor = new Map(batch.map((row) => [row.investor.id, row]));
    if (!Array.isArray(summaries) || summaries.length !== batch.length) throw new Error("Incomplete directory portfolio summaries");
    for (const summary of summaries) {
      if (!Array.isArray(summary) || summary.length !== 6) throw new Error("Invalid directory portfolio summary");
      const [id, period, count, cusip, issuer, value] = summary;
      const row = byInvestor.get(id);
      const total = Number(count);
      const valueUsd = Number(value);
      if (!row || period !== row.period || typeof count !== "string" || !/^\d+$/.test(count) || !Number.isSafeInteger(total)
        || (cusip !== null && typeof cusip !== "string")
        || (total > 0 && (typeof issuer !== "string" || typeof value !== "string" || value.trim() === "" || !Number.isFinite(valueUsd) || valueUsd < 0))
        || (total === 0 && (cusip !== null || issuer !== null || value !== null))) {
        throw new Error("Invalid directory portfolio summary");
      }
      row.positions = { total, largest: total === 0 ? null : {
        cusip, issuer: issuer!, valueUsd, portfolioShare: row.valueUsd! > 0 ? valueUsd / row.valueUsd! : 0,
      } };
      byInvestor.delete(id);
    }
  }
  // Reuse the existing validity-window and current-ticker rules, including historical CUSIPs.
  const periods = [...new Set(reported.map((row) => row.period!))];
  for (const period of periods) {
    const inPeriod = reported.filter((row) => row.period === period);
    const links = await getStockLinks(inPeriod.flatMap((row) => row.positions?.largest?.cusip ? [row.positions.largest.cusip] : []), period);
    for (const row of inPeriod) row.largestStock = links[row.positions?.largest?.cusip ?? ""] ?? null;
  }
  return rows;
});
