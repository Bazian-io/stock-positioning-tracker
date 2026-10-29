// Checks of the stored data that need no database: each takes rows already read and returns what a
// person should review. Used by check-data.mts.
import { exactShareRatio, likelySplit, type QuarterHolding } from "../../src/lib/stock.ts";

// A position from portfolio_positions: one investor's rows for one security in one quarter, combined.
export type Position = {
  investorId: string;
  reportPeriod: string;
  cusip: string | null;
  issuer: string;
  positionType: string; // "long", "put" or "call".
  quantityType: string; // "SH" or "PRN".
  shares: number;
  valueUsd: number;
};

export type CusipRecord = { securityId: string; cusip: string; validFrom: string; validTo: string | null };

const isLongShares = (position: Position) => position.positionType === "long" && position.quantityType === "SH" && position.shares > 0;
const covers = (record: CusipRecord, reportPeriod: string) =>
  record.validFrom <= reportPeriod && (record.validTo === null || reportPeriod < record.validTo);

// The stock a position belongs to, if its CUSIP identifies one in that quarter.
export function stockOf(position: Position, cusips: CusipRecord[]): string | null {
  return cusips.find((record) => record.cusip === position.cusip && covers(record, position.reportPeriod))?.securityId ?? null;
}

// typo: an invalid check digit, so not a real CUSIP. other-class: the same issuer (first six characters)
// as one of the stock's CUSIPs: another share class or tracking stock, or an earlier CUSIP of the stock
// (likelyPredecessors tells those apart when the share count carried over). same-name: a different
// security with the same name, such as a typo that passes the check digit, or a predecessor before a
// reorganization changed the CUSIP.
export type NameMatchKind = "typo" | "other-class" | "same-name";

export type SuspectedTypo = { cusip: string; securityId: string; issuer: string; reportPeriods: string[]; kind: NameMatchKind };

// CUSIPs reported under a name that filers also used for a recorded stock, while that investor's report
// for the quarter has no confirmed position in the stock. The stock's page shows those quarters as
// "reported, not held"; a typo is fixed by recording it with --alias.
export function suspectedTypos(positions: Position[], cusips: CusipRecord[], validCusip: (cusip: string) => boolean): SuspectedTypo[] {
  const recorded = new Set(cusips.map((record) => record.cusip));
  const stocksByName = new Map<string, Set<string>>();
  const held = new Set<string>();
  for (const position of positions.filter(isLongShares)) {
    const securityId = stockOf(position, cusips);
    if (!securityId) continue;
    if (!stocksByName.has(position.issuer)) stocksByName.set(position.issuer, new Set());
    stocksByName.get(position.issuer)?.add(securityId);
    held.add(`${position.investorId}|${position.reportPeriod}|${securityId}`);
  }
  const typos = new Map<string, SuspectedTypo>();
  for (const position of positions.filter(isLongShares)) {
    if (!position.cusip || recorded.has(position.cusip)) continue;
    for (const securityId of stocksByName.get(position.issuer) ?? []) {
      if (held.has(`${position.investorId}|${position.reportPeriod}|${securityId}`)) continue;
      const key = `${position.cusip}|${securityId}`;
      const sameIssuer = cusips.some((record) => record.securityId === securityId && record.cusip.slice(0, 6) === position.cusip?.slice(0, 6));
      const kind: NameMatchKind = !validCusip(position.cusip) ? "typo" : sameIssuer ? "other-class" : "same-name";
      const typo = typos.get(key) ?? { cusip: position.cusip, securityId, issuer: position.issuer, reportPeriods: [], kind };
      if (!typo.reportPeriods.includes(position.reportPeriod)) typo.reportPeriods.push(position.reportPeriod);
      typos.set(key, typo);
    }
  }
  return [...typos.values()].map((typo) => ({ ...typo, reportPeriods: typo.reportPeriods.sort() }));
}

export type LikelyPredecessor = { cusip: string; securityId: string; investorId: string; issuer: string; lastPeriod: string; shares: number };

// An unrecorded CUSIP whose holding ends in one quarter while the same investor's holding of a recorded
// stock starts in the next quarter with exactly the same share count: most likely the stock's earlier
// CUSIP, replaced one-for-one in a corporate action. Its quarters show as "reported, not held" on the
// stock's page until linked with --predecessor. reportedQuarters: "investorId|reportPeriod".
export function likelyPredecessors(
  positions: Position[],
  cusips: CusipRecord[],
  reportedQuarters: Set<string>,
  nextQuarter: (period: string) => string,
): LikelyPredecessor[] {
  const recorded = new Set(cusips.map((record) => record.cusip));
  const stockShares = new Map<string, Map<string, number>>(); // "investor|period" → stock → shares
  const unrecorded = new Map<string, Position>(); // "investor|cusip|period"
  for (const position of positions.filter(isLongShares)) {
    const securityId = stockOf(position, cusips);
    if (securityId) {
      const key = `${position.investorId}|${position.reportPeriod}`;
      const stocks = stockShares.get(key) ?? new Map<string, number>();
      stocks.set(securityId, (stocks.get(securityId) ?? 0) + position.shares);
      stockShares.set(key, stocks);
    } else if (position.cusip && !recorded.has(position.cusip)) {
      const key = `${position.investorId}|${position.cusip}|${position.reportPeriod}`;
      const total = unrecorded.get(key);
      unrecorded.set(key, total ? { ...total, shares: total.shares + position.shares } : position);
    }
  }
  const found = new Map<string, LikelyPredecessor>();
  for (const old of unrecorded.values()) {
    const next = nextQuarter(old.reportPeriod);
    if (!reportedQuarters.has(`${old.investorId}|${next}`) || unrecorded.has(`${old.investorId}|${old.cusip}|${next}`)) continue;
    const before = stockShares.get(`${old.investorId}|${old.reportPeriod}`);
    for (const [securityId, shares] of stockShares.get(`${old.investorId}|${next}`) ?? []) {
      if (shares !== old.shares || before?.has(securityId)) continue;
      found.set(`${old.cusip}|${securityId}`, {
        cusip: old.cusip ?? "", securityId, investorId: old.investorId, issuer: old.issuer, lastPeriod: old.reportPeriod, shares,
      });
    }
  }
  return [...found.values()];
}

// Positions under a recorded CUSIP in a quarter none of its records covers. Stock pages show these
// quarters as unclear; --extend-windows moves start dates back when filings support it.
export function outsideWindows(positions: Position[], cusips: CusipRecord[]): Position[] {
  const recorded = new Set(cusips.map((record) => record.cusip));
  return positions.filter((position) => position.cusip !== null && recorded.has(position.cusip) && stockOf(position, cusips) === null);
}

const pricePerShare = (position: Position) => position.valueUsd / position.shares;

// The same CUSIP in the same quarter is valued at the same quarter-end price by every filer, so value
// per share should agree. A larger gap points to a mistyped value or share count, or a value reported in
// thousands of dollars instead of dollars.
export function priceDisagreements(positions: Position[], tolerance = 0.02): Position[][] {
  const groups = new Map<string, Position[]>();
  for (const position of positions.filter(isLongShares)) {
    if (!position.cusip) continue;
    const key = `${position.cusip}|${position.reportPeriod}`;
    groups.set(key, [...(groups.get(key) ?? []), position]);
  }
  return [...groups.values()].filter((group) => {
    if (new Set(group.map((position) => position.investorId)).size < 2) return false;
    const prices = group.map(pricePerShare);
    return Math.max(...prices) / Math.min(...prices) > 1 + tolerance;
  });
}

export type QuarterPair = { previous: Position; current: Position; splitRatio: number | null; priceRatio: number };

// One investor's consecutive reported quarters of the same CUSIP. reportedQuarters: every quarter the
// investor reported, as "investorId|reportPeriod".
export function consecutivePairs(positions: Position[], reportedQuarters: Set<string>, previousQuarter: (period: string) => string): QuarterPair[] {
  const longs = positions.filter(isLongShares);
  const byKey = new Map(longs.map((position) => [`${position.investorId}|${position.cusip}|${position.reportPeriod}`, position]));
  const holding = (position: Position): QuarterHolding => ({
    reportPeriod: position.reportPeriod, state: "held", shares: position.shares, valueUsd: position.valueUsd,
    confidentialOmissions: false, unconfirmed: null, received: null,
  });
  const pairs = longs.flatMap((current) => {
    const period = previousQuarter(current.reportPeriod);
    const previous = byKey.get(`${current.investorId}|${current.cusip}|${period}`);
    if (!previous || !current.cusip || !reportedQuarters.has(`${current.investorId}|${period}`)) return [];
    return [{ previous, current, ratio: exactShareRatio(holding(previous), holding(current)) }];
  });
  // Other investors' exact share ratios for the same CUSIP and quarter confirm a reverse split.
  return pairs.map(({ previous, current }) => {
    const confirming = pairs.filter((other) => other.current.cusip === current.cusip && other.current.reportPeriod === current.reportPeriod
      && other.current.investorId !== current.investorId && other.ratio !== null).map((other) => other.ratio ?? 0);
    return {
      previous,
      current,
      splitRatio: likelySplit(holding(previous), holding(current), confirming),
      priceRatio: pricePerShare(current) / pricePerShare(previous),
    };
  });
}

// Value per share that moved more than fourfold between quarters without the pattern of a split: a
// likely error in the value or the share count.
export function priceJumps(pairs: QuarterPair[], factor = 4): QuarterPair[] {
  return pairs.filter((pair) => pair.splitRatio === null && (pair.priceRatio > factor || pair.priceRatio < 1 / factor));
}

// A quarter's 13F filing deadline: 45 days after the quarter ends, or the next business day when that
// falls on a weekend or federal holiday (SEC Rule 0-3). Of the federal holidays, only Presidents' Day
// (the third Monday of February) can fall in the days after a 45th day (14 Feb, 15 May, 14 Aug, 14 Nov).
export function filingDeadline(reportPeriod: string): string {
  const date = new Date(`${reportPeriod}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 45);
  const presidentsDay = () => date.getUTCMonth() === 1 && date.getUTCDay() === 1 && date.getUTCDate() >= 15 && date.getUTCDate() <= 21;
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || presidentsDay()) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// The latest quarter whose 13F filing deadline has passed.
export function latestDueQuarter(today: string): { reportPeriod: string; dueDate: string } {
  const year = Number(today.slice(0, 4));
  const quarterEnds = [year - 1, year].flatMap((y) => ["03-31", "06-30", "09-30", "12-31"].map((end) => `${y}-${end}`));
  const reportPeriod = quarterEnds.filter((end) => filingDeadline(end) < today).at(-1) ?? quarterEnds[0];
  return { reportPeriod, dueDate: filingDeadline(reportPeriod) };
}
