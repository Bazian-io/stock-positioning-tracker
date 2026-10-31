import { uncertainZero, type Change, type QuarterHolding } from "./stock.ts";

export const STOCK_FILTERS = [
  { value: "all", label: "All tracked investors", primary: false },
  { value: "holding", label: "Holding", primary: true },
  { value: "increased", label: "Increased", primary: true },
  { value: "decreased", label: "Reduced", primary: true },
  { value: "opened", label: "New positions", primary: true },
  { value: "closed", label: "Closed", primary: true },
  { value: "unchanged", label: "Unchanged", primary: false },
  { value: "corporate-action", label: "Corporate actions", primary: false },
  { value: "not-held", label: "Reported without it", primary: false },
  { value: "unclear", label: "Unclear", primary: false },
  { value: "not-comparable", label: "No comparison", primary: false },
  { value: "no-report", label: "No report", primary: false },
] as const;

export type StockFilter = (typeof STOCK_FILTERS)[number]["value"];
type OverviewRow = { current: QuarterHolding; change: Change };

// Holding is a current-quarter fact; direction requires a comparable previous report.
// A holder can therefore also belong to an uncertainty or missing-comparison group.
export function matchesStockFilter(row: OverviewRow, filter: StockFilter): boolean {
  const { current, change } = row;
  switch (filter) {
    case "all": return true;
    case "holding": return current.state === "held";
    case "not-held": return current.state === "not-held" && !uncertainZero(current);
    case "no-report": return current.state === "no-report";
    case "unclear": return current.state === "unclear" || uncertainZero(current)
      || (change.kind === "not-comparable" && change.blocker?.reason === "unclear");
    case "not-comparable": return current.state !== "no-report" && change.kind === "not-comparable"
      && change.blocker?.reason === "no-report";
    case "corporate-action": return change.kind === "split" || change.kind === "received";
    default: return change.kind === filter;
  }
}

export function stockOverview(rows: OverviewRow[]): Record<StockFilter, number> {
  return Object.fromEntries(STOCK_FILTERS.map((filter) => [filter.value, rows.filter((row) => matchesStockFilter(row, filter.value)).length])) as Record<StockFilter, number>;
}
