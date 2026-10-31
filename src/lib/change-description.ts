import { formatDate, formatNumber, formatPercent, quarterLabel } from "./portfolio.ts";
import type { Change, Received } from "./stock.ts";

// "20-for-1" or "1-for-10".
export function splitLabel(ratio: number): string {
  return ratio >= 1 ? `${formatNumber(ratio)}-for-1` : `1-for-${formatNumber(Math.round(1 / ratio))}`;
}

// "About 101,380,356 shares from Sirius XM's merger … on Sep 9, 2024, based on Q2 2024 holdings; +3,774,673 more than that",
// or for a split "About 10,000,000 shares after NVIDIA's 10-for-1 stock split on Jun 10, 2024, …".
export function receivedNote(received: Received, change?: Change): string {
  const note = `About ${formatNumber(Math.round(received.shares))} shares ${received.ownShares > 0 ? "after" : "from"} ${received.description} `
    + `on ${formatDate(received.effectiveDate)}`;
  if (!change) return note;
  // Fractions of shares are paid in cash, so a difference of a few shares is not a trade.
  const beyond = Math.round(change.shares);
  const traded = Math.abs(beyond) > Math.max(10, received.shares * 1e-4);
  return `${note}, based on ${quarterLabel(change.previousPeriod)} holdings${traded
    ? `; ${beyond > 0 ? "+" : "−"}${formatNumber(Math.abs(beyond))} shares ${beyond > 0 ? "more" : "fewer"} than that` : ""}`;
}

// "Increased" with "+1,234 shares (+2.3%)", and so on. A change needs reports for both quarters.
export function describeChange(change: Change): { label: string; detail?: string } {
  const sign = (value: number) => (value > 0 ? "+" : value < 0 ? "−" : "");
  const percent = change.fraction === null ? "" : ` (${sign(change.fraction)}${formatPercent(Math.abs(change.fraction))})`;
  const shares = `${sign(change.shares)}${formatNumber(Math.abs(change.shares))} shares`;
  switch (change.kind) {
    case "increased":
    case "decreased":
      return { label: change.kind === "increased" ? "Increased" : "Decreased", detail: `${shares}${percent}` };
    case "unchanged":
      return { label: "Unchanged" };
    case "received":
      return {
        label: change.received && change.received.ownShares > 0 ? "Stock split" : "Received in corporate action",
        detail: change.received ? receivedNote(change.received, change) : undefined,
      };
    case "split":
      return {
        label: "Likely stock split",
        detail: `${splitLabel(change.splitRatio ?? 1)}: reported shares ${(change.splitRatio ?? 1) >= 1
          ? `×${formatNumber(change.splitRatio ?? 1)}`
          : `÷${formatNumber(Math.round(1 / (change.splitRatio ?? 1)))}`}`,
      };
    case "opened":
      return { label: "New position", detail: `Not held in ${quarterLabel(change.previousPeriod)}` };
    case "closed":
      return { label: "Closed", detail: shares };
    case "not-held":
      return { label: "Not held", detail: `Also not held in ${quarterLabel(change.previousPeriod)}` };
    case "not-comparable":
      return {
        label: "Not comparable",
        detail: change.blocker?.reason === "unclear"
          ? `Holding unclear in ${quarterLabel(change.blocker.reportPeriod)}`
          : `No ${quarterLabel(change.blocker?.reportPeriod ?? change.previousPeriod)} report in our data`,
      };
  }
}

