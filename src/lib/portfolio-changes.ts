import type { Position } from "./portfolio.ts";
import {
  exactShareRatio, holdingSeries, identifiesStock, previousQuarter, quarterChange, receivedInQuarter,
  type Change, type Conversion, type CusipPeriod, type QuarterHolding, type Unconfirmed,
} from "./stock.ts";

export type ComparisonQuarter = { reportPeriod: string; valueUsd: number; confidentialOmissions: boolean };
export type ComparisonPosition = Pick<Position, "cusip" | "issuer" | "titleOfClass" | "shares" | "valueUsd" | "positionType" | "quantityType">
  & { investorId: string; reportPeriod: string };
export type ComparisonSecurity = { id: string; name: string; ticker: string | null; cusips: CusipPeriod[] };
export type ComparisonConversion = Conversion & { securityId: string };

export const CHANGE_FILTERS = [
  { value: "changed", label: "All changes" },
  { value: "opened", label: "New positions" },
  { value: "increased", label: "Increased" },
  { value: "decreased", label: "Reduced" },
  { value: "closed", label: "Closed" },
  { value: "corporate-action", label: "Corporate actions" },
  { value: "unchanged", label: "Unchanged" },
  { value: "not-comparable", label: "Unclear" },
] as const;
export type ChangeFilter = (typeof CHANGE_FILTERS)[number]["value"];

export type PortfolioChange = {
  id: string;
  name: string;
  ticker: string | null;
  cusips: string[];
  previous: QuarterHolding;
  current: QuarterHolding;
  previousWeight: number | null;
  currentWeight: number | null;
  change: Change;
  category: Exclude<ChangeFilter, "changed">;
  note?: string;
};

type Group = {
  id: string;
  name: string;
  security?: ComparisonSecurity;
  cusips: Set<string>;
  held: Map<string, { shares: number; valueUsd: number }>;
  unclear: Map<string, Unconfirmed>;
};

function groupPositions(positions: ComparisonPosition[], securities: ComparisonSecurity[], periods: string[]): Group[] {
  const byCusip = new Map<string, ComparisonSecurity[]>();
  for (const security of securities) {
    for (const cusip of new Set(security.cusips.map((period) => period.cusip))) {
      byCusip.set(cusip, [...byCusip.get(cusip) ?? [], security]);
    }
  }
  const groups = new Map<string, Group>();
  for (const position of positions) {
    if (position.positionType !== "long" || position.quantityType !== "SH" || !periods.includes(position.reportPeriod)) continue;
    const candidates = position.cusip ? byCusip.get(position.cusip) ?? [] : [];
    const valid = candidates.filter((security) => identifiesStock(security.cusips, position.cusip, position.reportPeriod));
    // An out-of-window identifier blocks comparisons with each possible stock; it never becomes a zero.
    const identities: (ComparisonSecurity | undefined)[] = valid.length === 1 ? valid : candidates.length ? candidates : [undefined];
    for (const security of identities) {
      const id = security ? `stock:${security.id}` : position.cusip ? `cusip:${position.cusip}` : `unknown:${position.issuer}|${position.titleOfClass ?? ""}`;
      const group = groups.get(id) ?? {
        id, name: position.issuer, security, cusips: new Set<string>(), held: new Map(), unclear: new Map(),
      };
      if (position.cusip) group.cusips.add(position.cusip);
      const confirmed = position.cusip !== null && (candidates.length === 0 || valid.length === 1);
      if (confirmed) {
        const total = group.held.get(position.reportPeriod) ?? { shares: 0, valueUsd: 0 };
        group.held.set(position.reportPeriod, { shares: total.shares + position.shares, valueUsd: total.valueUsd + position.valueUsd });
      } else {
        const total = group.unclear.get(position.reportPeriod)?.shares ?? 0;
        group.unclear.set(position.reportPeriod, { cusip: position.cusip ?? "missing", shares: total + position.shares });
      }
      groups.set(id, group);
    }
  }
  return [...groups.values()];
}

function weight(holding: QuarterHolding, quarter: ComparisonQuarter | undefined): number | null {
  if (!quarter || holding.state === "no-report" || holding.state === "unclear"
    || (holding.state === "not-held" && holding.confidentialOmissions)) return null;
  return quarter.valueUsd > 0 ? holding.valueUsd / quarter.valueUsd : 0;
}

// Uses the same per-stock rules as stock pages, joining aliases only within their verified dates.
// Peer positions are needed only for possible unrecorded reverse splits.
export function portfolioChanges({ current, previous, positions, securities = [], conversions = [], peers = [] }: {
  current: ComparisonQuarter;
  previous?: ComparisonQuarter;
  positions: ComparisonPosition[];
  securities?: ComparisonSecurity[];
  conversions?: ComparisonConversion[];
  peers?: ComparisonPosition[];
}): PortfolioChange[] {
  const priorPeriod = previousQuarter(current.reportPeriod);
  const prior = previous?.reportPeriod === priorPeriod ? previous : undefined;
  const periods = [priorPeriod, current.reportPeriod];
  const reports = new Map([current, ...(prior ? [prior] : [])].map((quarter) => [quarter.reportPeriod, quarter]));
  const heldBefore = new Map<string, number>();
  for (const position of positions) {
    if (position.reportPeriod === priorPeriod && position.cusip && position.positionType === "long" && position.quantityType === "SH") {
      heldBefore.set(position.cusip, (heldBefore.get(position.cusip) ?? 0) + position.shares);
    }
  }
  const confirmations = new Map<string, number[]>();
  const peersByInvestor = new Map<string, ComparisonPosition[]>();
  for (const peer of peers) {
    const rows = peersByInvestor.get(peer.investorId) ?? [];
    rows.push(peer);
    peersByInvestor.set(peer.investorId, rows);
  }
  for (const peerPositions of peersByInvestor.values()) {
    for (const group of groupPositions(peerPositions, securities, periods)) {
      const [before, after] = holdingSeries(periods, new Map(periods.map((period) => [period, { confidentialOmissions: false }])), group.held, group.unclear);
      const ratio = exactShareRatio(before, after);
      if (ratio !== null) confirmations.set(group.id, [...confirmations.get(group.id) ?? [], ratio]);
    }
  }
  return groupPositions(positions, securities, periods).map((group): PortfolioChange => {
    const ownCusips = group.security?.cusips.filter((period) => identifiesStock([period], period.cusip, priorPeriod)).map((period) => period.cusip) ?? [];
    const received = receivedInQuarter(conversions.filter((conversion) => conversion.securityId === group.security?.id), heldBefore, current.reportPeriod, ownCusips);
    const [before, after] = holdingSeries(periods, reports, group.held, group.unclear, new Map(received ? [[current.reportPeriod, received]] : []));
    let change = quarterChange(after, before, confirmations.get(group.id));
    let note: string | undefined;
    const uncertainZero = [before, after].find((holding) => holding.state === "not-held" && holding.confidentialOmissions);
    if (uncertainZero && change.blocker?.reason === "unclear") {
      note = "This filing omits confidential holdings, so the apparent zero is uncertain.";
    }
    if (group.unclear.size && change.kind === "not-comparable") {
      note = [...group.unclear.values()].some((holding) => holding.cusip === "missing")
        ? "The filing has no CUSIP for this position, so its identity cannot be compared reliably."
        : "The reported CUSIP is outside its verified dates for this stock.";
    }
    const convertedOut = before.state === "held" && after.state === "not-held"
      ? conversions.filter((conversion) => conversion.securityId !== group.security?.id && group.cusips.has(conversion.fromCusip)
        && conversion.effectiveDate > priorPeriod && conversion.effectiveDate <= current.reportPeriod)
      : [];
    if (convertedOut.length && change.kind === "closed") {
      change = { ...change, kind: "received", shares: 0, fraction: null };
      note = `A corporate action converted this security during the quarter: ${[...new Set(convertedOut.map((conversion) => conversion.description))].join("; ")}. Its absence alone does not establish a sale.`;
    }
    const category = change.kind === "split" || change.kind === "received" ? "corporate-action"
      : change.kind === "not-held" ? "unchanged" : change.kind;
    return {
      id: group.id,
      name: group.held.size ? group.security?.name ?? group.name : group.name,
      ticker: group.held.size ? group.security?.ticker ?? null : null,
      cusips: group.security?.cusips.map((period) => period.cusip) ?? [...group.cusips],
      previous: before, current: after,
      previousWeight: weight(before, prior), currentWeight: weight(after, current), change, category, note,
    };
  }).sort((a, b) => Math.max(b.previousWeight ?? 0, b.currentWeight ?? 0) - Math.max(a.previousWeight ?? 0, a.currentWeight ?? 0)
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function matchesChange(row: PortfolioChange, filter: ChangeFilter): boolean {
  return filter === "changed" ? row.category !== "unchanged" : row.category === filter;
}
