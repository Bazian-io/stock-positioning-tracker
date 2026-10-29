// Presentation helpers for reported 13F data: formatting values, dates and quarters. Kept free of
// imports so Node's test runner can load it directly.

// A reported position: a quarter's filing rows for the same security (CUSIP), position type and
// quantity type, combined by the portfolio_positions database view. A filer can report one
// position in several rows, for example one per subsidiary; share classes have their own CUSIPs.
export type Position = {
  cusip: string | null;
  issuer: string;
  titleOfClass: string | null;
  shares: number;
  quantityType: string; // "SH" for shares, "PRN" for principal amount.
  positionType: string; // "long", "put" or "call".
  valueUsd: number;
  rowCount: number; // Filing rows combined into this position.
  portfolioShare: number; // Fraction of the quarter's total reported value.
};


// Evenly spaced axis ticks from zero to the first round number at or above the maximum.
export function axisTicks(max: number, targetCount = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough) ?? rough;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
}

// Two decimals throughout, so values line up in columns; axis ticks are round numbers.
const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const axisUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const calendarDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
// EDGAR dates filings in US Eastern time.
const secDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/New_York",
});

export const formatUsdCompact = (value: number) => compactUsd.format(value); // $299.25B, $7.80B
export const formatUsdAxis = (value: number) => axisUsd.format(value); // $0, $100B, $2.5B
export const formatUsd = (value: number) => wholeUsd.format(value); // $299,253,556,246
export const formatNumber = (value: number) => wholeNumber.format(value);
export const formatPercent = (fraction: number) => (fraction > 0 && fraction < 0.0005 ? "<0.1%" : percent.format(fraction));
export const formatDate = (isoDate: string) => calendarDate.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
export const formatFilingDate = (timestamp: string) => secDate.format(new Date(timestamp));

export function quarterParts(reportPeriod: string): { year: number; quarter: number } {
  return { year: Number(reportPeriod.slice(0, 4)), quarter: Math.ceil(Number(reportPeriod.slice(5, 7)) / 3) };
}

export function quarterLabel(reportPeriod: string): string {
  const { year, quarter } = quarterParts(reportPeriod);
  return `Q${quarter} ${year}`;
}

// The filing's index page on SEC EDGAR, listing all of its documents.
export function secFilingUrl(cik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}/${accessionNumber}-index.htm`;
}
