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
  received: Received | null; // Shares received in a corporate action during the quarter, when held.
};

// A corporate action in which holders of another security received shares of the stock at a fixed
// ratio (Sirius XM's September 2024 merger: 0.1 new share for each Sirius XM share).
export type Conversion = { fromCusip: string; sharesPerShare: number; effectiveDate: string; description: string };

// Shares received in conversions during a quarter, estimated from the investor's holdings reported for
// the quarter before; it may have traded between that quarter end and the conversion.
export type Received = { shares: number; effectiveDate: string; description: string };

// Shares reported under a CUSIP that is not confirmed to identify the stock in that quarter.
export type Unconfirmed = { cusip: string; shares: number };

export type ChangeKind =
  | "increased" | "decreased" | "unchanged" | "split" | "received" | "opened" | "closed" | "not-held" | "not-comparable";

export type Change = {
  kind: ChangeKind;
  previousPeriod: string;
  shares: number; // Change in shares held.
  fraction: number | null; // Relative to the previous quarter's shares, when it held some.
  splitRatio: number | null; // For "split": new shares per old share (20 for 20-for-1, 0.1 for 1-for-10).
  // For "received": the shares received in a corporate action; shares is then the change beyond them.
  received: Received | null;
  // For "not-comparable": the quarter without a report or with an unclear holding.
  blocker: { reportPeriod: string; reason: "no-report" | "unclear" } | null;
};

// Exchange MICs and their names.
export const EXCHANGE_NAMES: Record<string, string> = {
  XNAS: "Nasdaq", XNYS: "NYSE", XASE: "NYSE American", ARCX: "NYSE Arca", BATS: "Cboe BZX", IEXG: "IEX",
};

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

// Shares of the stock received in conversions that took effect during the quarter ending reportPeriod,
// from the investor's shares of each converted security (CUSIP → shares) reported for the quarter before.
export function receivedInQuarter(conversions: Conversion[], heldBefore: Map<string, number>, reportPeriod: string): Received | null {
  const start = previousQuarter(reportPeriod);
  const due = conversions.filter((conversion) => conversion.effectiveDate > start && conversion.effectiveDate <= reportPeriod
    && (heldBefore.get(conversion.fromCusip) ?? 0) > 0);
  if (due.length === 0) return null;
  return {
    shares: due.reduce((sum, conversion) => sum + (heldBefore.get(conversion.fromCusip) ?? 0) * conversion.sharesPerShare, 0),
    effectiveDate: due[0].effectiveDate,
    description: due[0].description,
  };
}

// The investor's holding in each quarter, from the quarters it reported, its share positions in the
// stock, shares it reported under the stock's CUSIPs in quarters those CUSIPs are not confirmed for, and
// shares it received in corporate actions.
export function holdingSeries(
  reportPeriods: string[],
  reports: Map<string, { confidentialOmissions: boolean }>,
  positions: Map<string, { shares: number; valueUsd: number }>,
  unconfirmed: Map<string, Unconfirmed> = new Map(),
  received: Map<string, Received> = new Map(),
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
      received: held ? received.get(reportPeriod) ?? null : null,
    };
  });
}

// New shares per old share when one quarter's share count is a whole multiple (two or more) of the
// other's: 20, or 0.5 for exactly half. Otherwise null.
export function exactShareRatio(previous: QuarterHolding | undefined, current: QuarterHolding): number | null {
  if (previous?.state !== "held" || current.state !== "held" || previous.shares <= 0 || current.shares <= 0) return null;
  const larger = Math.max(previous.shares, current.shares);
  const smaller = Math.min(previous.shares, current.shares);
  if (larger % smaller !== 0 || larger / smaller < 2) return null;
  return current.shares > previous.shares ? larger / smaller : smaller / larger;
}

// A likely stock split between two quarters held: the share count changed by an exact ratio while the
// reported value per share moved the other way by about the same factor, so the share price itself
// (value per share times the ratio) moved no more than a market usually does in a quarter. Buying or
// selling leaves value per share where the market took it instead. Round-number trades can mimic 2- and
// 3-for-1 splits, so for those the price may move only −30% to +45%; for larger ratios −50% to +60%. A
// reverse split (fewer shares) is labelled only when another investor's holding changed by the same
// ratio in the same quarter (confirmingRatios), because selling exactly half of a round position looks
// the same. Returns new shares per old share, or null. A split in a quarter with other buying or selling
// is not detected.
export function likelySplit(previous: QuarterHolding, current: QuarterHolding, confirmingRatios: number[] = []): number | null {
  const ratio = exactShareRatio(previous, current);
  if (ratio === null || (ratio < 1 && !confirmingRatios.includes(ratio))) return null;
  const priceMove = (current.valueUsd / current.shares) / (previous.valueUsd / previous.shares) * ratio;
  const [low, high] = Math.max(ratio, 1 / ratio) <= 3 ? [0.7, 1.45] : [0.5, 1.6];
  return priceMove >= low && priceMove <= high ? ratio : null;
}

// The change from the previous quarter. It is known only when the investor reported both quarters and
// its holding is clear in both; a missing report is not a zero. confirmingRatios: other investors' exact
// share ratios for the same quarter (see likelySplit).
export function quarterChange(current: QuarterHolding, previous: QuarterHolding | undefined, confirmingRatios: number[] = []): Change {
  const previousPeriod = previousQuarter(current.reportPeriod);
  const notComparable = (reportPeriod: string, reason: "no-report" | "unclear"): Change =>
    ({ kind: "not-comparable", previousPeriod, shares: 0, fraction: null, splitRatio: null, received: null, blocker: { reportPeriod, reason } });
  if (current.state === "no-report" || current.state === "unclear") return notComparable(current.reportPeriod, current.state);
  if (!previous || previous.reportPeriod !== previousPeriod || previous.state === "no-report") return notComparable(previousPeriod, "no-report");
  if (previous.state === "unclear") return notComparable(previousPeriod, "unclear");
  if (current.received) {
    // Received in a corporate action: the change beyond the shares received.
    const beyond = current.shares - previous.shares - current.received.shares;
    return { kind: "received", previousPeriod, shares: beyond, fraction: null, splitRatio: null, received: current.received, blocker: null };
  }
  const shares = current.shares - previous.shares;
  const fraction = previous.shares > 0 ? shares / previous.shares : null;
  const splitRatio = likelySplit(previous, current, confirmingRatios);
  const kind: ChangeKind = previous.state === "held"
    ? current.state === "held"
      ? splitRatio !== null ? "split" : shares > 0 ? "increased" : shares < 0 ? "decreased" : "unchanged"
      : "closed"
    : current.state === "held" ? "opened" : "not-held";
  return { kind, previousPeriod, shares, fraction, splitRatio, received: null, blocker: null };
}
