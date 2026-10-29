// One investor's reported holdings of one stock, quarter by quarter, and how they changed. Kept free
// of imports so Node's test runner can load it directly.

// held: the investor's 13F report lists shares of the stock. not-held: the investor filed a report
// for the quarter that does not list the stock, a confirmed zero. no-report: there is no report for
// the quarter in our data, so the holding is unknown.
export type HoldingState = "held" | "not-held" | "no-report";

export type QuarterHolding = {
  reportPeriod: string;
  state: HoldingState;
  shares: number; // Shares held long; 0 unless held.
  valueUsd: number;
  confidentialOmissions: boolean; // The report omitted some holdings, so "not held" is not certain.
};

export type ChangeKind = "increased" | "decreased" | "unchanged" | "opened" | "closed" | "not-held" | "not-comparable";

export type Change = {
  kind: ChangeKind;
  previousPeriod: string;
  shares: number; // Change in shares held.
  fraction: number | null; // Relative to the previous quarter's shares, when it held some.
};

// Exchange MICs and their names.
export const EXCHANGE_NAMES: Record<string, string> = { XNAS: "Nasdaq", XNYS: "NYSE" };

// The quarter-end date before a quarter-end date: "2026-03-31" → "2025-12-31".
export function previousQuarter(reportPeriod: string): string {
  const year = Number(reportPeriod.slice(0, 4));
  const month = Number(reportPeriod.slice(5, 7));
  return month === 3 ? `${year - 1}-12-31` : `${year}-${["03-31", "06-30", "09-30"][month / 3 - 2]}`;
}

export type CusipPeriod = { cusip: string; validFrom: string; validTo: string | null };

// Whether a row reported under this CUSIP for this quarter belongs to the stock: the CUSIP must be one
// of the stock's own (each share class has its own) and identify it at the quarter end.
export function identifiesStock(cusips: CusipPeriod[], cusip: string | null, reportPeriod: string): boolean {
  return cusips.some((period) => period.cusip === cusip && period.validFrom <= reportPeriod
    && (period.validTo === null || reportPeriod < period.validTo));
}

// The investor's holding in each quarter, from the quarters it reported and its share positions.
export function holdingSeries(
  reportPeriods: string[],
  reports: Map<string, { confidentialOmissions: boolean }>,
  positions: Map<string, { shares: number; valueUsd: number }>,
): QuarterHolding[] {
  return reportPeriods.map((reportPeriod) => {
    const report = reports.get(reportPeriod);
    const position = positions.get(reportPeriod);
    const held = report !== undefined && position !== undefined && position.shares > 0;
    return {
      reportPeriod,
      state: report === undefined ? "no-report" : held ? "held" : "not-held",
      shares: held ? position.shares : 0,
      valueUsd: held ? position.valueUsd : 0,
      confidentialOmissions: report?.confidentialOmissions ?? false,
    };
  });
}

// The change from the previous quarter. It is known only when the investor reported both quarters;
// a missing report is not a zero.
export function quarterChange(current: QuarterHolding, previous: QuarterHolding | undefined): Change {
  const previousPeriod = previousQuarter(current.reportPeriod);
  if (!previous || previous.reportPeriod !== previousPeriod || previous.state === "no-report" || current.state === "no-report") {
    return { kind: "not-comparable", previousPeriod, shares: 0, fraction: null };
  }
  const shares = current.shares - previous.shares;
  const fraction = previous.shares > 0 ? shares / previous.shares : null;
  const kind: ChangeKind = previous.state === "held"
    ? current.state === "held" ? (shares > 0 ? "increased" : shares < 0 ? "decreased" : "unchanged") : "closed"
    : current.state === "held" ? "opened" : "not-held";
  return { kind, previousPeriod, shares, fraction };
}
