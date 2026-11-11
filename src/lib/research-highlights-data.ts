import "server-only";
import { getInvestorSummaries } from "./portfolio-data";
import { getPortfolioChanges } from "./portfolio-changes-data";
import type { ComparisonQuarter } from "./portfolio-changes";
import { notableChanges, type ManagerChanges } from "./research";
import { previousQuarter } from "./stock";
import { loadAll } from "./stock-data";
import { readOnlySupabase } from "./supabase";
import { cacheResearch } from "./research-cache";

export const getHighlights = cacheResearch("research-highlights", async (requested?: string) => {
  const investors = await getInvestorSummaries();
  const periods = [...new Set(investors.flatMap((investor) => investor.values.map((quarter) => quarter.reportPeriod)))].sort().toReversed();
  const period = requested ?? periods[0];
  const managers = investors.filter((investor) => investor.segment === "active_manager");
  if (!period || managers.length === 0) return { period, periods, total: managers.length, eligible: 0, compared: 0, highlights: [], failed: 0 };
  const prior = previousQuarter(period);
  const quarters = await loadAll<{ investor_id: string; report_period: string; value_usd: string; has_confidential_omissions: boolean }>(
    (from, to) => readOnlySupabase().from("quarterly_portfolios")
      .select("investor_id, report_period, value_usd::text, has_confidential_omissions")
      .in("investor_id", managers.map((investor) => investor.id)).in("report_period", [prior, period])
      .order("investor_id").order("report_period").range(from, to), "homepage reporting coverage",
  );
  const summary = (id: string, reportPeriod: string): ComparisonQuarter | undefined => {
    const row = quarters.find((quarter) => quarter.investor_id === id && quarter.report_period === reportPeriod);
    return row ? { reportPeriod, valueUsd: Number(row.value_usd), confidentialOmissions: row.has_confidential_omissions } : undefined;
  };
  const eligible = managers.flatMap((investor) => {
    const current = summary(investor.id, period);
    const previous = summary(investor.id, prior);
    return current && previous ? [{ investor, current, previous }] : [];
  });
  const comparisons: ManagerChanges[] = [];
  let failed = 0;
  // Concentrated active-manager portfolios keep this preview bounded. Use the same comparison
  // and corporate-action rules as the dashboards, with at most three managers loading at once.
  for (let start = 0; start < eligible.length; start += 3) {
    const results = await Promise.allSettled(eligible.slice(start, start + 3).map(async ({ investor, current, previous }) => ({
      investor: { id: investor.id, name: investor.name, slug: investor.slug }, changes: await getPortfolioChanges(investor.id, current, previous),
    })));
    for (const result of results) {
      if (result.status === "fulfilled") comparisons.push(result.value);
      else failed += 1;
    }
  }
  return { period, periods, total: managers.length, eligible: eligible.length, compared: comparisons.length, highlights: notableChanges(comparisons), failed };
}, { cacheable: (overview) => overview.failed === 0 });
