// One investor's reported holdings of one stock, quarter by quarter, and how they changed. Kept free
// of imports so Node's test runner can load it directly.

// held: the investor's 13F report lists shares of the stock. not-held: the investor filed a report
// for the quarter that does not list the stock, a confirmed zero. unclear: the report lists shares under
// one of the stock's CUSIPs outside the dates that CUSIP is recorded for, so the holding is not
// confirmed either way. no-report: there is no report for the quarter in our data, so the holding is
// unknown.
export type HoldingState = "held" | "not-held" | "unclear" | "no-report";

export type QuarterHolding = {
  reportPeriod: string;
  state: HoldingState;
  shares: number; // Shares held long; 0 unless held.
  valueUsd: number;
  confidentialOmissions: boolean; // The report omitted some holdings, so "not held" is not certain.
  unconfirmed: Unconfirmed | null; // What made the quarter unclear.
};

// Shares reported under a CUSIP that is not confirmed to identify the stock in that quarter.
export type Unconfirmed = { cusip: string; shares: number };

export type ChangeKind = "increased" | "decreased" | "unchanged" | "split" | "opened" | "closed" | "not-held" | "not-comparable";

export type Change = {
  kind: ChangeKind;
  previousPeriod: string;
  shares: number; // Change in shares held.
  fraction: number | null; // Relative to the previous quarter's shares, when it held some.
  splitRatio: number | null; // For "split": new shares per old share (20 for 20-for-1, 0.1 for 1-for-10).
  // For "not-comparable": the quarter without a report or with an unclear holding.
  blocker: { reportPeriod: string; reason: "no-report" | "unclear" } | null;
};

// Exchange MICs and their names.
export const EXCHANGE_NAMES: Record<string, string> = { XNAS: "Nasdaq", XNYS: "NYSE" };

// The quarter-end date before a quarter-end date: "2026-03-31" → "2025-12-31".
export function previousQuarter(reportPeriod: string): string {
  const year = Number(reportPeriod.slice(0, 4));
  const month = Number(reportPeriod.slice(5, 7));
  return month === 3 ? `${year - 1}-12-31` : `${year}-${["03-31", "06-30", "09-30"][month / 3 - 2]}`;
}

// The quarter-end date after a quarter-end date: "2025-12-31" → "2026-03-31".
export function nextQuarter(reportPeriod: string): string {
  const year = Number(reportPeriod.slice(0, 4));
  const month = Number(reportPeriod.slice(5, 7));
  return month === 12 ? `${year + 1}-03-31` : `${year}-${["06-30", "09-30", "12-31"][month / 3 - 1]}`;
}

// The last quarter-end date before a date: "2025-12-15" → "2025-09-30", "2022-10-01" → "2022-09-30".
export function lastQuarterBefore(date: string): string {
  const year = Number(date.slice(0, 4));
  const ends = [`${year - 1}-12-31`, ...["03-31", "06-30", "09-30", "12-31"].map((end) => `${year}-${end}`)];
  return ends.filter((end) => end < date).at(-1) ?? ends[0];
}

export type CusipPeriod = { cusip: string; validFrom: string; validTo: string | null };

// Whether a row reported under this CUSIP for this quarter belongs to the stock: the CUSIP must be one
// of the stock's own (each share class has its own) and identify it at the quarter end.
export function identifiesStock(cusips: CusipPeriod[], cusip: string | null, reportPeriod: string): boolean {
  return cusips.some((period) => period.cusip === cusip && period.validFrom <= reportPeriod
    && (period.validTo === null || reportPeriod < period.validTo));
}

// The investor's holding in each quarter, from the quarters it reported, its share positions in the
// stock, and shares it reported under the stock's CUSIPs in quarters those CUSIPs are not confirmed for.
export function holdingSeries(
  reportPeriods: string[],
  reports: Map<string, { confidentialOmissions: boolean }>,
  positions: Map<string, { shares: number; valueUsd: number }>,
  unconfirmed: Map<string, Unconfirmed> = new Map(),
): QuarterHolding[] {
  return reportPeriods.map((reportPeriod) => {
    const report = reports.get(reportPeriod);
    const position = positions.get(reportPeriod);
    const held = report !== undefined && position !== undefined && position.shares > 0;
    const unclear = report !== undefined && !held ? unconfirmed.get(reportPeriod) ?? null : null;
    return {
      reportPeriod,
      state: report === undefined ? "no-report" : held ? "held" : unclear ? "unclear" : "not-held",
      shares: held ? position.shares : 0,
      valueUsd: held ? position.valueUsd : 0,
      confidentialOmissions: report?.confidentialOmissions ?? false,
      unconfirmed: unclear,
    };
  });
}

// A likely stock split between two quarters held: the share count changed by an exact whole-number
// ratio (or its inverse, for a reverse split) while the reported value per share moved the other way by
// about the same factor. Allows the share price itself to move between −50% and +60% in the quarter.
// Returns new shares per old share, or null. A split in a quarter with other buying or selling is not
// detected.
export function likelySplit(previous: QuarterHolding, current: QuarterHolding): number | null {
  if (previous.state !== "held" || current.state !== "held" || previous.shares <= 0 || current.shares <= 0) return null;
  const larger = Math.max(previous.shares, current.shares);
  const smaller = Math.min(previous.shares, current.shares);
  if (larger % smaller !== 0 || larger / smaller < 2) return null;
  const ratio = current.shares > previous.shares ? larger / smaller : smaller / larger;
  const priceMove = (current.valueUsd / current.shares) / (previous.valueUsd / previous.shares) * ratio;
  return priceMove >= 0.5 && priceMove <= 1.6 ? ratio : null;
}

// The change from the previous quarter. It is known only when the investor reported both quarters and
// its holding is clear in both; a missing report is not a zero.
export function quarterChange(current: QuarterHolding, previous: QuarterHolding | undefined): Change {
  const previousPeriod = previousQuarter(current.reportPeriod);
  const notComparable = (reportPeriod: string, reason: "no-report" | "unclear"): Change =>
    ({ kind: "not-comparable", previousPeriod, shares: 0, fraction: null, splitRatio: null, blocker: { reportPeriod, reason } });
  if (current.state === "no-report" || current.state === "unclear") return notComparable(current.reportPeriod, current.state);
  if (!previous || previous.reportPeriod !== previousPeriod || previous.state === "no-report") return notComparable(previousPeriod, "no-report");
  if (previous.state === "unclear") return notComparable(previousPeriod, "unclear");
  const shares = current.shares - previous.shares;
  const fraction = previous.shares > 0 ? shares / previous.shares : null;
  const splitRatio = likelySplit(previous, current);
  const kind: ChangeKind = previous.state === "held"
    ? current.state === "held"
      ? splitRatio !== null ? "split" : shares > 0 ? "increased" : shares < 0 ? "decreased" : "unchanged"
      : "closed"
    : current.state === "held" ? "opened" : "not-held";
  return { kind, previousPeriod, shares, fraction, splitRatio, blocker: null };
}
