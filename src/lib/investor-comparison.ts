import { groupPositions, portfolioWeight, type ComparisonPosition, type ComparisonQuarter, type ComparisonSecurity } from "./portfolio-changes.ts";
import { holdingSeries, uncertainZero, type QuarterHolding } from "./stock.ts";

export const COMPARISON_FILTERS = ["all", "shared", "left-only", "right-only", "unclear"] as const;
export type ComparisonFilter = (typeof COMPARISON_FILTERS)[number];
export const COMPARISON_SORTS = [
  { value: "weight", label: "Largest portfolio weight" },
  { value: "gap", label: "Largest weight gap" },
  { value: "name", label: "Security name: A–Z" },
] as const;
export type ComparisonSort = (typeof COMPARISON_SORTS)[number]["value"];

export type InvestorComparisonRow = {
  id: string; name: string; ticker: string | null; cusips: string[];
  left: QuarterHolding; right: QuarterHolding;
  leftWeight: number | null; rightWeight: number | null; weightGap: number | null;
  category: Exclude<ComparisonFilter, "all">;
};

export function comparisonPeriods(left: string[], right: string[], requested?: string) {
  const periods = [...new Set([...left, ...right])].sort().toReversed();
  const latestCommon = periods.find((period) => left.includes(period) && right.includes(period));
  return { periods, latestCommon, selected: requested ?? latestCommon ?? periods[0] };
}

// Same-quarter portfolios, joined with the dashboards' verified-identifier rules. Missing
// reports and confidential zeros cannot establish that a position is unique to one investor.
export function compareInvestors({ period, leftId, rightId, leftReport, rightReport, positions, securities = [] }: {
  period: string; leftId: string; rightId: string;
  leftReport?: ComparisonQuarter; rightReport?: ComparisonQuarter;
  positions: ComparisonPosition[]; securities?: ComparisonSecurity[];
}): InvestorComparisonRow[] {
  const reportForPeriod = (report?: ComparisonQuarter) => report?.reportPeriod === period ? report : undefined;
  const leftQuarter = reportForPeriod(leftReport);
  const rightQuarter = reportForPeriod(rightReport);
  const groups = (investorId: string) => new Map(groupPositions(positions.filter((row) => row.investorId === investorId), securities, [period])
    .map((group) => [group.id, group]));
  const leftGroups = groups(leftId);
  const rightGroups = groups(rightId);
  type Group = ReturnType<typeof groupPositions>[number];
  const holding = (group: Group | undefined, report?: ComparisonQuarter) => holdingSeries(
    [period], report ? new Map([[period, report]]) : new Map(), group?.held ?? new Map(), group?.unclear ?? new Map(),
  )[0];
  const known = (value: QuarterHolding) => value.state === "held" || (value.state === "not-held" && !uncertainZero(value));
  return [...new Set([...leftGroups.keys(), ...rightGroups.keys()])].flatMap((id): InvestorComparisonRow[] => {
    const leftGroup = leftGroups.get(id);
    const rightGroup = rightGroups.get(id);
    const left = holding(leftGroup, leftQuarter);
    const right = holding(rightGroup, rightQuarter);
    if (known(left) && known(right) && left.state === "not-held" && right.state === "not-held") return [];
    const category = !known(left) || !known(right) ? "unclear"
      : left.state === "held" && right.state === "held" ? "shared" : left.state === "held" ? "left-only" : "right-only";
    const leftWeight = portfolioWeight(left, leftQuarter);
    const rightWeight = portfolioWeight(right, rightQuarter);
    const identified = left.state === "held" ? leftGroup : right.state === "held" ? rightGroup : undefined;
    return [{
      id, name: identified?.security?.name ?? leftGroup?.name ?? rightGroup!.name,
      ticker: identified?.security?.ticker ?? null,
      cusips: [...new Set([...(leftGroup?.cusips ?? []), ...(rightGroup?.cusips ?? [])])],
      left, right, leftWeight, rightWeight,
      weightGap: leftWeight === null || rightWeight === null ? null : leftWeight - rightWeight,
      category,
    }];
  });
}

export function comparisonCounts(rows: InvestorComparisonRow[]) {
  return Object.fromEntries(COMPARISON_FILTERS.map((filter) => [filter, filter === "all" ? rows.length : rows.filter((row) => row.category === filter).length])) as Record<ComparisonFilter, number>;
}

export function comparisonRows(rows: InvestorComparisonRow[], filter: ComparisonFilter, query: string, sort: ComparisonSort) {
  const text = query.toLowerCase();
  return rows.filter((row) => (filter === "all" || row.category === filter)
    && (!text || [row.name, ...row.cusips].some((value) => value.toLowerCase().includes(text))
      || (row.ticker ?? "").toLowerCase().includes(text.replace(/[./]/g, "-"))))
    .sort((a, b) => {
      if (sort === "gap") {
        if (a.weightGap === null && b.weightGap !== null) return 1;
        if (b.weightGap === null && a.weightGap !== null) return -1;
      }
      const difference = sort === "weight" ? Math.max(b.leftWeight ?? 0, b.rightWeight ?? 0) - Math.max(a.leftWeight ?? 0, a.rightWeight ?? 0)
        : sort === "gap" ? Math.abs(b.weightGap ?? 0) - Math.abs(a.weightGap ?? 0) : 0;
      return difference || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
}
