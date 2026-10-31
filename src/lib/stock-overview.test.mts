import assert from "node:assert/strict";
import { test } from "node:test";
import { holdingSeries, quarterChange, uncertainZero, type QuarterHolding } from "./stock.ts";
import { matchesStockFilter, stockOverview } from "./stock-overview.ts";

const before = "2026-03-31";
const after = "2026-06-30";
const holding = (reportPeriod: string, state: QuarterHolding["state"], shares = 0, extra: Partial<QuarterHolding> = {}): QuarterHolding => ({
  reportPeriod, state, shares, valueUsd: shares * 10, confidentialOmissions: false, unconfirmed: null, received: null, ...extra,
});
const row = (previous: QuarterHolding | undefined, current: QuarterHolding) => ({ current, change: quarterChange(current, previous) });

test("overview counts and filters distinguish current holders from reported activity", () => {
  const rows = [
    row(holding(before, "held", 100), holding(after, "held", 150)),
    row(holding(before, "held", 100), holding(after, "held", 50)),
    row(holding(before, "not-held"), holding(after, "held", 100)),
    row(holding(before, "held", 100), holding(after, "not-held")),
    row(holding(before, "held", 100), holding(after, "held", 100)),
    row(holding(before, "not-held"), holding(after, "not-held")),
  ];
  const snapshot = structuredClone(rows);
  const counts = stockOverview(rows);
  assert.deepEqual([counts.all, counts.holding, counts.increased, counts.decreased, counts.opened, counts.closed, counts.unchanged, counts["not-held"]], [6, 4, 1, 1, 1, 1, 1, 2]);
  assert.equal(rows.filter((item) => matchesStockFilter(item, "holding")).length, 4);
  assert.equal(rows.filter((item) => matchesStockFilter(item, "closed"))[0].current.shares, 0);
  assert.deepEqual(rows, snapshot); // Filtering does not alter shares, values or change calculations.
});

test("a holder with no previous report is distinct from an investor with no current report", () => {
  const rows = [row(holding(before, "no-report"), holding(after, "held", 100)), row(holding(before, "held", 100), holding(after, "no-report"))];
  const counts = stockOverview(rows);
  assert.deepEqual([counts.holding, counts["not-comparable"], counts["no-report"], counts.opened, counts.closed], [1, 1, 1, 0, 0]);
  assert.equal(matchesStockFilter(rows[0], "not-comparable"), true);
  assert.equal(matchesStockFilter(rows[1], "not-comparable"), false);
});

test("confidential zeros cannot establish openings or exits and never count as confirmed absences", () => {
  const rows = [
    row(holding(before, "held", 100), holding(after, "not-held", 0, { confidentialOmissions: true })),
    row(holding(before, "not-held", 0, { confidentialOmissions: true }), holding(after, "held", 100)),
  ];
  const counts = stockOverview(rows);
  assert.deepEqual([counts.opened, counts.closed, counts["not-held"], counts.unclear, counts.holding], [0, 0, 0, 2, 1]);
  assert.equal(uncertainZero(rows[0].current), true);
  assert.equal(rows[0].change.blocker?.reportPeriod, after);
  assert.equal(rows[1].change.blocker?.reportPeriod, before);
});

test("confidential flags do not prevent comparing positive holdings disclosed in both quarters", () => {
  const item = row(holding(before, "held", 100, { confidentialOmissions: true }), holding(after, "held", 150, { confidentialOmissions: true }));
  assert.equal(item.change.kind, "increased");
  assert.equal(stockOverview([item]).unclear, 0);
});

test("out-of-window identifiers stay unclear instead of appearing as zero or a new holding", () => {
  const rows = [
    row(holding(before, "held", 100), holding(after, "unclear", 0, { unconfirmed: { cusip: "unconfirmed", shares: 100 } })),
    row(holding(before, "unclear"), holding(after, "held", 100)),
  ];
  const counts = stockOverview(rows);
  assert.deepEqual([counts.unclear, counts.holding, counts["not-held"], counts.opened, counts.closed], [2, 1, 0, 0, 0]);
});

test("stock splits and received shares remain outside increased, reduced and new position counts", () => {
  const split = row(holding(before, "held", 100, { valueUsd: 1000 }), holding(after, "held", 1000, { valueUsd: 1100 }));
  const received = row(holding(before, "not-held"), holding(after, "held", 50, {
    received: { shares: 50, ownShares: 0, effectiveDate: "2026-05-01", description: "a merger" },
  }));
  const counts = stockOverview([split, received]);
  assert.deepEqual([counts.holding, counts["corporate-action"], counts.increased, counts.decreased, counts.opened], [2, 2, 0, 0, 0]);
});

test("first imported quarters keep known holdings visible without inventing activity", () => {
  const rows = [row(undefined, holding(after, "held", 100)), row(undefined, holding(after, "not-held"))];
  const counts = stockOverview(rows);
  assert.deepEqual([counts.holding, counts["not-held"], counts["not-comparable"], counts.opened, counts.closed], [1, 1, 2, 0, 0]);
});

test("a confidential omission remains an uncertain zero in the reported series", () => {
  const [current] = holdingSeries([after], new Map([[after, { confidentialOmissions: true }]]), new Map());
  assert.equal(uncertainZero(current), true);
  assert.equal(matchesStockFilter(row(holding(before, "held", 100), current), "not-held"), false);
});
