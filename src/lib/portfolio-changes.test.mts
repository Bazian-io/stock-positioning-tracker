import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchesChange, portfolioChanges, type ComparisonConversion, type ComparisonPosition, type ComparisonSecurity,
} from "./portfolio-changes.ts";

const before = { reportPeriod: "2026-03-31", valueUsd: 10_000, confidentialOmissions: false };
const after = { reportPeriod: "2026-06-30", valueUsd: 20_000, confidentialOmissions: false };
const position = (cusip: string | null, shares: number, reportPeriod: string, valueUsd = shares * 10, extra: Partial<ComparisonPosition> = {}): ComparisonPosition => ({
  cusip, shares, reportPeriod, valueUsd, investorId: "investor", issuer: cusip ?? "Unknown issuer", titleOfClass: "Common stock",
  positionType: "long", quantityType: "SH", ...extra,
});
const stock = (id: string, cusip: string): ComparisonSecurity => ({
  id, name: id, ticker: id.toUpperCase(), cusips: [{ cusip, validFrom: "2021-09-30", validTo: null }],
});

test("new, closed, increased, reduced and unchanged positions have independent counts and full-portfolio weights", () => {
  const positions = [
    position("new", 50, after.reportPeriod),
    position("closed", 80, before.reportPeriod),
    position("increased", 100, before.reportPeriod), position("increased", 150, after.reportPeriod),
    position("reduced", 100, before.reportPeriod), position("reduced", 80, after.reportPeriod),
    position("same", 100, before.reportPeriod), position("same", 100, after.reportPeriod),
  ];
  const snapshot = structuredClone(positions);
  const rows = portfolioChanges({ current: after, previous: before, positions });
  assert.deepEqual(rows.map((row) => row.category).sort(), ["closed", "decreased", "increased", "opened", "unchanged"]);
  const increased = rows.find((row) => row.name === "increased")!;
  assert.deepEqual([increased.previousWeight, increased.currentWeight, increased.change.shares], [0.1, 0.075, 50]);
  assert.equal(rows.filter((row) => matchesChange(row, "changed")).length, 4);
  assert.equal(rows.filter((row) => matchesChange(row, "opened")).length, 1);
  assert.deepEqual(positions, snapshot); // Computing or filtering never adjusts reported inputs.
});

test("a missing or nonconsecutive report cannot produce new or closed positions", () => {
  const positions = [position("held", 100, after.reportPeriod)];
  for (const previous of [undefined, { ...before, reportPeriod: "2025-12-31" }]) {
    const [row] = portfolioChanges({ current: after, previous, positions });
    assert.equal(row.category, "not-comparable");
    assert.equal(row.previous.state, "no-report");
    assert.equal(row.previousWeight, null);
  }
});

test("a validated empty report is a reported zero and can establish an exit", () => {
  const [row] = portfolioChanges({ current: { ...after, valueUsd: 0 }, previous: before, positions: [position("exited", 100, before.reportPeriod)] });
  assert.equal(row.category, "closed");
  assert.equal(row.current.state, "not-held");
  assert.equal(row.currentWeight, 0);
});

test("options, principal amounts and other quarters are excluded; share classes remain separate", () => {
  const rows = portfolioChanges({ current: after, previous: before, positions: [
    position("class-a", 100, after.reportPeriod, 1000, { issuer: "Same issuer" }),
    position("class-c", 200, after.reportPeriod, 2000, { issuer: "Same issuer" }),
    position("class-a", 5000, after.reportPeriod, 50000, { positionType: "call" }),
    position("class-a", 7000, after.reportPeriod, 70000, { positionType: "put" }),
    position("bond", 10000, after.reportPeriod, 10000, { quantityType: "PRN" }),
    position("older", 100, "2025-12-31"),
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.current.shares).sort((a, b) => a - b), [100, 200]);
});

test("CUSIPs without verified mappings are compared by exact CUSIP; missing CUSIPs remain unclear", () => {
  const rows = portfolioChanges({ current: after, previous: before, positions: [
    position("unmapped", 100, before.reportPeriod), position("unmapped", 150, after.reportPeriod),
    position(null, 10, before.reportPeriod), position(null, 20, after.reportPeriod),
  ] });
  assert.equal(rows.find((row) => row.id === "cusip:unmapped")?.category, "increased");
  assert.equal(rows.find((row) => row.id.startsWith("unknown:"))?.category, "not-comparable");
});

test("an out-of-window CUSIP blocks comparison instead of creating a new position", () => {
  const security = stock("verified", "cusip");
  security.cusips[0].validFrom = after.reportPeriod;
  const [row] = portfolioChanges({ current: after, previous: before, securities: [security], positions: [
    position("cusip", 100, before.reportPeriod), position("cusip", 120, after.reportPeriod),
  ] });
  assert.equal(row.previous.state, "unclear");
  assert.equal(row.category, "not-comparable");
  assert.equal(row.previousWeight, null);
});

test("confidential omissions keep apparent openings and closures out of the activity counts", () => {
  const [opened] = portfolioChanges({ current: after, previous: { ...before, confidentialOmissions: true }, positions: [position("held", 100, after.reportPeriod)] });
  const [closed] = portfolioChanges({ current: { ...after, confidentialOmissions: true }, previous: before, positions: [position("held", 100, before.reportPeriod)] });
  assert.equal(opened.category, "not-comparable");
  assert.equal(closed.category, "not-comparable");
  assert.equal(opened.previousWeight, null);
  assert.equal(closed.currentWeight, null);
});

test("verified aliases combine into one stock while retaining reported totals", () => {
  const security = stock("same-stock", "new");
  security.cusips.push({ cusip: "old", validFrom: "2021-09-30", validTo: after.reportPeriod });
  const [row] = portfolioChanges({ current: after, previous: before, securities: [security], positions: [
    position("old", 100, before.reportPeriod), position("new", 100, after.reportPeriod),
  ] });
  assert.equal(row.category, "unchanged");
  assert.equal(row.previous.shares, 100);
  assert.equal(row.current.shares, 100);
});

test("an official split with a new CUSIP is a corporate action, with only the difference beyond it as change", () => {
  const security = stock("split-stock", "new");
  security.cusips.push({ cusip: "old", validFrom: "2021-09-30", validTo: "2026-05-01" });
  const conversion: ComparisonConversion = { securityId: security.id, fromCusip: "old", sharesPerShare: 10, effectiveDate: "2026-05-01", description: "a 10-for-1 stock split" };
  const [row] = portfolioChanges({ current: after, previous: before, securities: [security], conversions: [conversion], positions: [
    position("old", 100, before.reportPeriod, 1000), position("new", 1050, after.reportPeriod, 1200),
  ] });
  assert.equal(row.category, "corporate-action");
  assert.equal(row.change.received?.ownShares, 100);
  assert.equal(row.change.shares, 50);
  assert.equal(row.current.shares, 1050);
});

test("likely forward splits and corroborated reverse splits follow the existing stock rules", () => {
  const positions = [position("forward", 100, before.reportPeriod, 1000), position("forward", 1000, after.reportPeriod, 1100),
    position("reverse", 1000, before.reportPeriod, 5000), position("reverse", 100, after.reportPeriod, 4800)];
  const unconfirmed = portfolioChanges({ current: after, previous: before, positions });
  assert.equal(unconfirmed.find((row) => row.name === "forward")?.change.kind, "split");
  assert.equal(unconfirmed.find((row) => row.name === "reverse")?.change.kind, "decreased");
  const confirmed = portfolioChanges({ current: after, previous: before, positions, peers: [
    position("reverse", 2000, before.reportPeriod, 10000, { investorId: "peer" }),
    position("reverse", 200, after.reportPeriod, 9600, { investorId: "peer" }),
  ] });
  assert.equal(confirmed.find((row) => row.name === "reverse")?.change.kind, "split");
});

test("a merger does not manufacture a closed source position or a newly bought target", () => {
  const security = stock("target", "new");
  const conversion: ComparisonConversion = { securityId: security.id, fromCusip: "old", sharesPerShare: 0.5, effectiveDate: "2026-05-01", description: "a merger" };
  const rows = portfolioChanges({ current: after, previous: before, securities: [security], conversions: [conversion], positions: [
    position("old", 100, before.reportPeriod), position("new", 50, after.reportPeriod),
  ] });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.category === "corporate-action"));
  assert.equal(rows.find((row) => row.ticker === "TARGET")?.change.shares, 0);
});

test("equal share-count trades at a stable price are not labelled as splits", () => {
  const rows = portfolioChanges({ current: after, previous: before, positions: [
    position("buy", 100, before.reportPeriod, 1000), position("buy", 200, after.reportPeriod, 2000),
    position("sell", 200, before.reportPeriod, 2000), position("sell", 100, after.reportPeriod, 1000),
  ] });
  assert.deepEqual(rows.map((row) => row.category).sort(), ["decreased", "increased"]);
});
