import assert from "node:assert/strict";
import { test } from "node:test";
import {
  holdingSeries, identifiesStock, lastQuarterBefore, likelySplit, nextQuarter, previousQuarter, quarterChange, receivedInQuarter,
  type Conversion, type QuarterHolding,
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
    ({ reportPeriod, state: "held", shares, valueUsd, confidentialOmissions: false, unconfirmed: null, received: null });
  // Berkshire's Amazon shares around the June 2022 20-for-1 split, as reported.
  const amazon = quarterChange(held("2022-06-30", 10_666_000, 1_132_835_860), held("2022-03-31", 533_300, 1_738_534_000));
  assert.deepEqual([amazon.kind, amazon.splitRatio], ["split", 20]);
  // Berkshire's Apple sale in Q2 2024: about half, but not an exact ratio.
  assert.equal(quarterChange(held("2024-06-30", 400_000_000, 84_248_000_000), held("2024-03-31", 789_368_450, 135_360_000_000)).kind, "decreased");
  // An exact doubling bought at a steady price is a purchase.
  assert.equal(likelySplit(held("2026-03-31", 1_000_000, 100_000_000), held("2026-06-30", 2_000_000, 220_000_000)), null);
  // A 10-for-1 split while the price rose 37% (as NVIDIA's did in Q2 2024), and a 2-for-1 while it rose 10%.
  assert.equal(likelySplit(held("2024-03-31", 1_000_000, 900_000_000), held("2024-06-30", 10_000_000, 1_233_000_000)), 10);
  assert.equal(likelySplit(held("2026-03-31", 1_000_000, 200_000_000), held("2026-06-30", 2_000_000, 220_000_000)), 2);
  // Round-number trades that the old rule called splits: selling exactly half while the price was flat or
  // rose 15%, and doubling while it fell 25%.
  assert.equal(likelySplit(held("2026-03-31", 400_000_000, 24e9), held("2026-06-30", 200_000_000, 12e9)), null);
  assert.equal(likelySplit(held("2026-03-31", 400_000_000, 24e9), held("2026-06-30", 200_000_000, 13.8e9)), null);
  assert.equal(likelySplit(held("2026-03-31", 10_000_000, 1e9), held("2026-06-30", 20_000_000, 1.5e9)), null);
  // A 1-for-10 reverse split counts only when another investor's holding changed by the same ratio.
  const reverse = [held("2026-03-31", 1_000_000, 5_000_000), held("2026-06-30", 100_000, 4_800_000)] as const;
  assert.equal(likelySplit(...reverse), null);
  assert.equal(likelySplit(...reverse, [0.1]), 0.1);
  assert.equal(likelySplit(...reverse, [0.5]), null);
});

test("changes compare consecutive reported quarters; a missing report is never treated as zero", () => {
  const at = (reportPeriod: string, state: QuarterHolding["state"], shares = 0): QuarterHolding =>
    ({ reportPeriod, state, shares, valueUsd: shares * 10, confidentialOmissions: false, unconfirmed: null, received: null });
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

test("shares received in a corporate action are told apart from buying, using the official ratios", () => {
  // Sirius XM, 9 September 2024: 0.1 new share per Sirius XM share, 0.8375 per Liberty SiriusXM share.
  const merger = "the Sirius XM merger";
  const siri: Conversion[] = [
    { fromCusip: "82968B103", sharesPerShare: 0.1, effectiveDate: "2024-09-09", description: merger },
    { fromCusip: "531229813", sharesPerShare: 0.8375, effectiveDate: "2024-09-09", description: merger },
    { fromCusip: "531229789", sharesPerShare: 0.8375, effectiveDate: "2024-09-09", description: merger },
  ];
  // Berkshire's holdings reported for Q2 2024.
  const before = new Map([["82968B103", 132_878_213], ["531229813", 35_182_219], ["531229789", 70_002_897]]);
  const received = receivedInQuarter(siri, before, "2024-09-30");
  assert.equal(Math.round(received?.shares ?? 0), 101_380_356);
  assert.equal(receivedInQuarter(siri, before, "2024-06-30"), null); // Not yet in effect.
  assert.equal(receivedInQuarter(siri, new Map(), "2024-09-30"), null); // Nothing held to convert.

  const series = holdingSeries(
    ["2024-06-30", "2024-09-30", "2024-12-31"],
    new Map([["2024-06-30", { confidentialOmissions: false }], ["2024-09-30", { confidentialOmissions: false }], ["2024-12-31", { confidentialOmissions: false }]]),
    new Map([["2024-09-30", { shares: 105_155_029, valueUsd: 2.5e9 }], ["2024-12-31", { shares: 117_468_573, valueUsd: 2.7e9 }]]),
    new Map(),
    new Map(received ? [["2024-09-30", received]] : []),
  );
  const change = quarterChange(series[1], series[0]);
  assert.equal(change.kind, "received");
  assert.equal(Math.round(change.shares), 3_774_673); // Bought beyond the conversion.
  assert.equal(quarterChange(series[2], series[1]).kind, "increased");
  // Liberty Live, 3 August 2023: 0.25 per Liberty SiriusXM share and 0.0428 per Formula One share.
  const live: Conversion[] = [
    { fromCusip: "531229607", sharesPerShare: 0.25, effectiveDate: "2023-08-03", description: "the reclassification" },
    { fromCusip: "531229854", sharesPerShare: 0.0428, effectiveDate: "2023-08-03", description: "the reclassification" },
  ];
  const fromQ2 = receivedInQuarter(live, new Map([["531229607", 43_208_291], ["531229854", 7_722_451]]), "2023-09-30");
  assert.equal(Math.round(fromQ2?.shares ?? 0), 11_132_594); // Berkshire reported 11,132,590: fractions were paid in cash.
});
