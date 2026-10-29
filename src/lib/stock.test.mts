import assert from "node:assert/strict";
import { test } from "node:test";
import {
  holdingSeries, identifiesStock, lastQuarterBefore, likelySplit, nextQuarter, previousQuarter, quarterChange, type QuarterHolding,
} from "./stock.ts";

const quarters = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];

test("each quarter is held, reported without the stock, or not reported", () => {
  const series = holdingSeries(
    quarters,
    new Map([["2025-09-30", { confidentialOmissions: false }], ["2026-03-31", { confidentialOmissions: true }], ["2026-06-30", { confidentialOmissions: false }]]),
    new Map([["2025-09-30", { shares: 100, valueUsd: 1000 }], ["2026-06-30", { shares: 150, valueUsd: 1800 }]]),
  );
  assert.deepEqual(series.map(({ state, shares }) => [state, shares]), [["held", 100], ["no-report", 0], ["not-held", 0], ["held", 150]]);
  assert.equal(series[2].confidentialOmissions, true);
});

test("shares under a stock's CUSIP outside its recorded dates make a reported quarter unclear, not a zero", () => {
  const series = holdingSeries(
    quarters,
    new Map(quarters.map((quarter) => [quarter, { confidentialOmissions: false }])),
    new Map([["2026-03-31", { shares: 50, valueUsd: 500 }]]),
    new Map([["2025-12-31", { cusip: "G6693N103", shares: 50 }], ["2026-03-31", { cusip: "G6693N103", shares: 5 }]]),
  );
  assert.deepEqual(series.map(({ state }) => state), ["not-held", "unclear", "held", "not-held"]);
  assert.deepEqual(series[1].unconfirmed, { cusip: "G6693N103", shares: 50 });
  assert.equal(series[2].unconfirmed, null); // Held under a confirmed CUSIP: not unclear.
  assert.deepEqual(quarterChange(series[1], series[0]).blocker, { reportPeriod: "2025-12-31", reason: "unclear" });
  assert.deepEqual(quarterChange(series[2], series[1]).blocker, { reportPeriod: "2025-12-31", reason: "unclear" });
  assert.equal(quarterChange(series[3], series[2]).kind, "closed");
});

test("an exact whole-number change in shares with the opposite move in value per share is a likely split", () => {
  const held = (reportPeriod: string, shares: number, valueUsd: number): QuarterHolding =>
    ({ reportPeriod, state: "held", shares, valueUsd, confidentialOmissions: false, unconfirmed: null });
  // Berkshire's Amazon shares around the June 2022 20-for-1 split, as reported.
  const amazon = quarterChange(held("2022-06-30", 10_666_000, 1_132_835_860), held("2022-03-31", 533_300, 1_738_534_000));
  assert.deepEqual([amazon.kind, amazon.splitRatio], ["split", 20]);
  // Berkshire's Apple sale in Q2 2024: about half, but not an exact ratio.
  assert.equal(quarterChange(held("2024-06-30", 400_000_000, 84_248_000_000), held("2024-03-31", 789_368_450, 135_360_000_000)).kind, "decreased");
  // An exact doubling bought at a steady price is a purchase.
  assert.equal(likelySplit(held("2026-03-31", 1_000_000, 100_000_000), held("2026-06-30", 2_000_000, 220_000_000)), null);
  // A 10-for-1 split while the price rose 37% (as NVIDIA's did in Q2 2024), and a 1-for-10 reverse split.
  assert.equal(likelySplit(held("2024-03-31", 1_000_000, 900_000_000), held("2024-06-30", 10_000_000, 1_233_000_000)), 10);
  assert.equal(likelySplit(held("2026-03-31", 1_000_000, 5_000_000), held("2026-06-30", 100_000, 4_800_000)), 0.1);
});

test("changes compare consecutive reported quarters; a missing report is never treated as zero", () => {
  const at = (reportPeriod: string, state: QuarterHolding["state"], shares = 0): QuarterHolding =>
    ({ reportPeriod, state, shares, valueUsd: shares * 10, confidentialOmissions: false, unconfirmed: null });
  const change = (previous: QuarterHolding | undefined, current: QuarterHolding) => {
    const { kind, shares, fraction } = quarterChange(current, previous);
    return { kind, shares, fraction };
  };
  assert.deepEqual(change(at("2026-03-31", "held", 100), at("2026-06-30", "held", 150)), { kind: "increased", shares: 50, fraction: 0.5 });
  assert.deepEqual(change(at("2026-03-31", "held", 100), at("2026-06-30", "held", 60)), { kind: "decreased", shares: -40, fraction: -0.4 });
  assert.deepEqual(change(at("2026-03-31", "held", 100), at("2026-06-30", "held", 100)), { kind: "unchanged", shares: 0, fraction: 0 });
  assert.deepEqual(change(at("2026-03-31", "not-held"), at("2026-06-30", "held", 100)), { kind: "opened", shares: 100, fraction: null });
  assert.deepEqual(change(at("2026-03-31", "held", 100), at("2026-06-30", "not-held")), { kind: "closed", shares: -100, fraction: -1 });
  assert.deepEqual(change(at("2026-03-31", "not-held"), at("2026-06-30", "not-held")), { kind: "not-held", shares: 0, fraction: null });
  assert.equal(change(at("2026-03-31", "no-report"), at("2026-06-30", "held", 100)).kind, "not-comparable");
  assert.equal(change(undefined, at("2026-06-30", "held", 100)).kind, "not-comparable");
  // Only the immediately preceding quarter is comparable.
  assert.equal(change(at("2025-12-31", "held", 100), at("2026-06-30", "held", 100)).kind, "not-comparable");
  assert.deepEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"].map(previousQuarter), ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]);
  assert.deepEqual(["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"].map(nextQuarter), ["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
  assert.deepEqual(["2025-12-15", "2022-10-01", "2026-01-01", "2026-03-31"].map(lastQuarterBefore), ["2025-09-30", "2022-09-30", "2025-12-31", "2025-12-31"]);
});

test("rows belong to a stock only under its own CUSIPs, while they identify it", () => {
  const classA = [{ cusip: "02079K305", validFrom: "2021-09-30", validTo: null }];
  assert.ok(identifiesStock(classA, "02079K305", "2026-06-30"));
  assert.ok(!identifiesStock(classA, "02079K107", "2026-06-30")); // Class C stays separate.
  assert.ok(!identifiesStock(classA, "02079K305", "2021-06-30")); // Before the evidenced start.
  const renamed = [{ cusip: "30303M102", validFrom: "2021-09-30", validTo: "2022-06-30" }];
  assert.ok(identifiesStock(renamed, "30303M102", "2022-03-31"));
  assert.ok(!identifiesStock(renamed, "30303M102", "2022-06-30")); // Validity ends are exclusive.
});
