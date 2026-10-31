import assert from "node:assert/strict";
import { test } from "node:test";
import { compareInvestors, comparisonCounts, comparisonPeriods, comparisonRows } from "./investor-comparison.ts";
import type { ComparisonPosition, ComparisonSecurity } from "./portfolio-changes.ts";
import { researchHref, returnTarget } from "./research.ts";

const period = "2026-06-30";
const leftReport = { reportPeriod: period, valueUsd: 10_000, confidentialOmissions: false };
const rightReport = { reportPeriod: period, valueUsd: 20_000, confidentialOmissions: false };
const position = (investorId: string, cusip: string | null, shares: number, extra: Partial<ComparisonPosition> = {}): ComparisonPosition => ({
  investorId, cusip, shares, valueUsd: shares * 10, reportPeriod: period,
  issuer: cusip ?? "Unidentified issuer", titleOfClass: "COM", positionType: "long", quantityType: "SH", ...extra,
});
const input = { period, leftId: "a", rightId: "b", leftReport, rightReport };
const portfolio = [position("a", "shared", 200), position("b", "shared", 50), position("a", "left", 100), position("b", "right", 500)];

test("same-quarter comparisons show shared and unique positions with each full portfolio as denominator", () => {
  const rows = compareInvestors({ ...input, positions: portfolio });
  assert.deepEqual(comparisonCounts(rows), { all: 3, shared: 1, "left-only": 1, "right-only": 1, unclear: 0 });
  const shared = rows.find((row) => row.category === "shared")!;
  assert.deepEqual([shared.left.shares, shared.right.shares, shared.leftWeight, shared.rightWeight], [200, 50, 0.2, 0.025]);
  assert.ok(Math.abs(shared.weightGap! - 0.175) < 1e-10);
  assert.equal(rows.find((row) => row.category === "left-only")?.rightWeight, 0);
});

test("a missing or mismatched report never establishes a unique holding or zero weight", () => {
  for (const report of [undefined, { ...rightReport, reportPeriod: "2026-03-31" }]) {
    const [row] = compareInvestors({ ...input, rightReport: report, positions: [position("a", "known", 100)] });
    assert.equal(row.category, "unclear");
    assert.equal(row.right.state, "no-report");
    assert.equal(row.rightWeight, null);
    assert.equal(row.weightGap, null);
    assert.equal(comparisonCounts([row])["left-only"], 0);
  }
});

test("a validated empty report can establish absence, with zero shares and weight", () => {
  const [row] = compareInvestors({ ...input, rightReport: { ...rightReport, valueUsd: 0 }, positions: [position("a", "known", 100)] });
  assert.equal(row.category, "left-only");
  assert.equal(row.right.state, "not-held");
  assert.equal(row.right.shares, 0);
  assert.equal(row.rightWeight, 0);
});

test("confidential omissions block claims of unique holdings but retain positive shared disclosures", () => {
  const rows = compareInvestors({ ...input, rightReport: { ...rightReport, confidentialOmissions: true }, positions: portfolio });
  assert.equal(rows.find((row) => row.id === "cusip:left")?.category, "unclear");
  assert.equal(rows.find((row) => row.id === "cusip:left")?.rightWeight, null);
  assert.equal(rows.find((row) => row.id === "cusip:shared")?.category, "shared");
  assert.equal(rows.find((row) => row.id === "cusip:right")?.category, "right-only");
});

test("options, principal amounts, other investors and other quarters cannot affect the share comparison", () => {
  const rows = compareInvestors({ ...input, positions: [
    ...portfolio, position("a", "shared", 5000, { positionType: "call" }), position("b", "shared", 5000, { positionType: "put" }),
    position("a", "bond", 5000, { quantityType: "PRN" }), position("other", "another", 200),
    position("a", "old", 500, { reportPeriod: "2026-03-31" }),
  ] });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.category === "shared")?.leftWeight, 0.2);
});

test("verified CUSIP aliases combine while separate share classes and unmatched CUSIPs remain separate", () => {
  const securities: ComparisonSecurity[] = [{ id: "verified", name: "Verified security", ticker: "VRF", cusips: [
    { cusip: "alias-one", validFrom: "2021-01-01", validTo: null }, { cusip: "alias-two", validFrom: "2021-01-01", validTo: null },
  ] }];
  const rows = compareInvestors({ ...input, securities, positions: [
    position("a", "alias-one", 100), position("a", "alias-two", 50), position("b", "alias-two", 20),
    position("a", "class-a", 100, { issuer: "Same issuer" }), position("b", "class-b", 200, { issuer: "Same issuer" }),
  ] });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.ticker === "VRF")?.left.shares, 150);
  assert.equal(rows.find((row) => row.ticker === "VRF")?.category, "shared");
  assert.equal(rows.filter((row) => row.category === "shared").length, 1);
});

test("an out-of-window CUSIP and a missing CUSIP remain uncertain instead of becoming overlap or absence", () => {
  const securities: ComparisonSecurity[] = [{ id: "verified", name: "Verified security", ticker: "VRF", cusips: [
    { cusip: "old", validFrom: "2021-01-01", validTo: "2026-04-01" }, { cusip: "new", validFrom: "2026-04-01", validTo: null },
  ] }];
  const rows = compareInvestors({ ...input, securities, positions: [position("a", "old", 100), position("b", "new", 100), position("a", null, 10), position("b", null, 20)] });
  assert.ok(rows.every((row) => row.category === "unclear"));
  const verified = rows.find((row) => row.id === "stock:verified")!;
  assert.equal(verified.left.state, "unclear");
  assert.equal(verified.leftWeight, null);
  assert.equal(verified.right.shares, 100);
});

test("filtering, search and weight-gap sorting do not change counts, denominators or inputs", () => {
  const positions = structuredClone(portfolio);
  const rows = compareInvestors({ ...input, positions });
  const original = structuredClone(rows);
  assert.deepEqual(comparisonRows(rows, "all", "", "gap").map((row) => row.id), ["cusip:right", "cusip:shared", "cusip:left"]);
  assert.equal(comparisonRows(rows, "shared", "SHARED", "weight")[0].leftWeight, 0.2);
  assert.equal(comparisonRows(rows, "shared", "left", "weight").length, 0);
  assert.equal(comparisonCounts(rows).all, 3);
  assert.deepEqual(rows, original);
  assert.deepEqual(positions, portfolio);
});

test("quarter selection defaults to the latest common quarter and retains an explicit non-common quarter", () => {
  const left = ["2026-03-31", period];
  const right = ["2025-12-31", "2026-03-31"];
  assert.equal(comparisonPeriods(left, right).selected, "2026-03-31");
  assert.equal(comparisonPeriods(left, right, period).selected, period);
  assert.equal(comparisonPeriods([period], ["2026-03-31"]).latestCommon, undefined);
  assert.equal(comparisonPeriods([period], ["2026-03-31"]).selected, period);
  assert.equal(comparisonPeriods([], []).selected, undefined);
});

test("ticker search accepts share-class dots and slashes without matching another class", () => {
  const rows = compareInvestors({ ...input, positions: [position("a", "class-b", 100), position("b", "class-a", 100)], securities: [
    { id: "b", name: "Berkshire Hathaway", ticker: "BRK-B", cusips: [{ cusip: "class-b", validFrom: "2021-01-01", validTo: null }] },
    { id: "a", name: "Berkshire Hathaway", ticker: "BRK-A", cusips: [{ cusip: "class-a", validFrom: "2021-01-01", validTo: null }] },
  ] });
  for (const query of ["BRK.B", "brk/b", "BRK-B"]) assert.deepEqual(comparisonRows(rows, "all", query, "weight").map((row) => row.ticker), ["BRK-B"]);
});

test("returning from a stock retains the comparison pair, quarter, filter, search, sort and page without nesting", () => {
  const state = { a: "berkshire-hathaway", b: "blackrock", quarter: period, q: "Apple", filter: "shared", sort: "gap", page: "2", from: "/search?q=bank", back: "/stocks/AAPL" };
  const target = returnTarget(researchHref("/compare", state) + "#comparison-holdings")!;
  const url = new URL(target.href, "https://research.invalid");
  for (const key of ["a", "b", "quarter", "q", "filter", "sort", "page"] as const) assert.equal(url.searchParams.get(key), state[key]);
  assert.equal(url.searchParams.has("from"), false);
  assert.equal(url.searchParams.has("back"), false);
  assert.equal(url.hash, "#comparison-holdings");
  assert.equal(target.label, "Back to investor comparison");
});
