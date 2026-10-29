import assert from "node:assert/strict";
import { test } from "node:test";
import { holdingSeries, identifiesStock, previousQuarter, quarterChange, type QuarterHolding } from "./stock.ts";

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

test("changes compare consecutive reported quarters; a missing report is never treated as zero", () => {
  const at = (reportPeriod: string, state: QuarterHolding["state"], shares = 0): QuarterHolding =>
    ({ reportPeriod, state, shares, valueUsd: shares * 10, confidentialOmissions: false });
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
