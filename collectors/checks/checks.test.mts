import assert from "node:assert/strict";
import { test } from "node:test";
import { nextQuarter, previousQuarter } from "../../src/lib/stock.ts";
import { isValidCusip } from "../securities/identify.mts";
import {
  consecutivePairs, filingDeadline, latestDueQuarter, likelyPredecessors, marketSplits, outsideWindows, priceDisagreements, priceJumps, suspectedTypos, type CusipRecord,
  type Position,
} from "./findings.mts";

const position = (investorId: string, reportPeriod: string, cusip: string, issuer: string, shares: number, valueUsd: number): Position =>
  ({ investorId, reportPeriod, cusip, issuer, positionType: "long", quantityType: "SH", shares, valueUsd });
const nu: CusipRecord = { securityId: "nu", cusip: "G6683N103", validFrom: "2022-12-31", validTo: null };

test("a CUSIP reported under a stock's name, in a quarter without the stock, is a suspected typo", () => {
  // Berkshire's Nu Holdings rows, as filed: the mistyped CUSIP for four quarters, then the right one.
  const positions = [
    ...["2021-12-31", "2022-03-31", "2022-06-30", "2022-09-30"].map((period) => position("brk", period, "G6693N103", "NU HLDGS LTD", 107_118_784, 1e9)),
    position("brk", "2022-12-31", "G6683N103", "NU HLDGS LTD", 107_118_784, 435_973_451),
    // Another security under the same name, held in the same quarter as the stock: not suspected.
    position("brk", "2022-12-31", "G6683N111", "NU HLDGS LTD", 10, 100),
    // Another class of the same issuer, and a predecessor's CUSIP, in a quarter without the stock.
    position("brk", "2021-09-30", "G6683N111", "NU HLDGS LTD", 10, 100),
    position("brk", "2021-09-30", "829933100", "NU HLDGS LTD", 10, 100),
  ];
  assert.deepEqual(suspectedTypos(positions, [nu], isValidCusip), [
    { cusip: "G6693N103", securityId: "nu", issuer: "NU HLDGS LTD", reportPeriods: ["2021-12-31", "2022-03-31", "2022-06-30", "2022-09-30"], kind: "typo" },
    { cusip: "G6683N111", securityId: "nu", issuer: "NU HLDGS LTD", reportPeriods: ["2021-09-30"], kind: "other-class" },
    { cusip: "829933100", securityId: "nu", issuer: "NU HLDGS LTD", reportPeriods: ["2021-09-30"], kind: "same-name" },
  ]);
  // Once recorded as an alias for those quarters, the typo is no longer suspected.
  const alias = { securityId: "nu", cusip: "G6693N103", validFrom: "2021-12-31", validTo: "2022-10-01" };
  assert.deepEqual(suspectedTypos(positions, [nu, alias], isValidCusip).map((match) => match.kind), ["other-class", "same-name"]);
});

test("holdings under a recorded CUSIP before its recorded start are listed", () => {
  const early = position("blk", "2022-06-30", "G6683N103", "NU HOLDINGS LTD", 5, 50);
  assert.deepEqual(outsideWindows([early, position("blk", "2026-06-30", "G6683N103", "NU HOLDINGS LTD", 5, 50)], [nu]), [early]);
});

test("values are compared between investors and between quarters, and splits are told apart from errors", () => {
  const amazon = [position("brk", "2022-03-31", "023135106", "AMAZON COM INC", 533_300, 1_738_531_000), position("brk", "2022-06-30", "023135106", "AMAZON COM INC", 10_666_000, 1_132_836_000)];
  const thousands = [position("brk", "2022-09-30", "037833100", "APPLE INC", 100, 13_820), position("brk", "2022-12-31", "037833100", "APPLE INC", 100, 12_993_000)];
  const reported = new Set(["brk|2022-03-31", "brk|2022-06-30", "brk|2022-09-30", "brk|2022-12-31"]);
  const pairs = consecutivePairs([...amazon, ...thousands], reported, previousQuarter);
  assert.deepEqual(pairs.map((pair) => [pair.current.issuer, pair.splitRatio]), [["AMAZON COM INC", 20], ["APPLE INC", null]]);
  // A value reported in thousands instead of dollars moves value per share about a thousandfold.
  assert.deepEqual(priceJumps(pairs).map((pair) => pair.current.issuer), ["APPLE INC"]);
  // A small stock that fell 90% for every holder moved in price; one holder alone falling 90% did not.
  const crash = (investor: string, after: number) => [
    position(investor, "2022-09-30", "000000001", "EXAMPLE BIO", 1000, 10_000), position(investor, "2022-12-31", "000000001", "EXAMPLE BIO", 1000, after),
  ];
  const holders = new Set(["brk|2022-09-30", "brk|2022-12-31", "blk|2022-09-30", "blk|2022-12-31"]);
  assert.deepEqual(priceJumps(consecutivePairs([...crash("brk", 1000), ...crash("blk", 1000)], holders, previousQuarter)), []);
  assert.deepEqual(priceJumps(consecutivePairs([...crash("brk", 1000), ...crash("blk", 9000)], holders, previousQuarter))
    .map((pair) => pair.current.investorId), ["brk"]);
  // Held by one investor only, a tenfold fall is not enough to tell from a price move.
  assert.deepEqual(priceJumps(consecutivePairs(crash("brk", 1000), holders, previousQuarter)), []);
  // A 1-for-2 reverse split shows for both investors that held through it; one investor selling half does not.
  const reverse = (investor: string, shares: number) => [
    position(investor, "2026-03-31", "000000000", "EXAMPLE CO", shares, shares * 10),
    position(investor, "2026-06-30", "000000000", "EXAMPLE CO", shares / 2, shares * 10.4),
  ];
  const both = new Set(["brk|2026-03-31", "brk|2026-06-30", "blk|2026-03-31", "blk|2026-06-30"]);
  assert.deepEqual(consecutivePairs([...reverse("brk", 1000), ...reverse("blk", 4000)], both, previousQuarter).map((pair) => pair.splitRatio), [0.5, 0.5]);
  assert.deepEqual(consecutivePairs(reverse("brk", 1000), both, previousQuarter).map((pair) => pair.splitRatio), [null]);
  const sameQuarter = [position("brk", "2026-06-30", "037833100", "APPLE INC", 100, 20_500), position("blk", "2026-06-30", "037833100", "APPLE INC", 200, 41_100)];
  assert.deepEqual(priceDisagreements(sameQuarter), []);
  // Filers' price sources differ by a few percent; that is not an error.
  assert.deepEqual(priceDisagreements([sameQuarter[0], { ...sameQuarter[1], valueUsd: 43_000 }]), []);
  assert.equal(priceDisagreements([sameQuarter[0], { ...sameQuarter[1], valueUsd: 41 }]).length, 1);
});

test("13F deadlines fall 45 days after quarter end, moved past weekends and Presidents' Day", () => {
  // SEC's 2026 deadlines: 17 Feb (14 Feb was a Saturday and 16 Feb Presidents' Day), 15 May, 14 Aug, 16 Nov.
  assert.deepEqual(["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"].map(filingDeadline), ["2026-02-17", "2026-05-15", "2026-08-14", "2026-11-16"]);
  assert.deepEqual(["2026-12-31", "2027-03-31", "2027-06-30", "2027-09-30"].map(filingDeadline), ["2027-02-16", "2027-05-17", "2027-08-16", "2027-11-15"]);
  // A quarter is due once its deadline day has passed.
  assert.deepEqual(latestDueQuarter("2026-10-29"), { reportPeriod: "2026-06-30", dueDate: "2026-08-14" });
  assert.deepEqual(latestDueQuarter("2026-11-16"), { reportPeriod: "2026-06-30", dueDate: "2026-08-14" });
  assert.deepEqual(latestDueQuarter("2026-11-17"), { reportPeriod: "2026-09-30", dueDate: "2026-11-16" });
  assert.deepEqual(latestDueQuarter("2027-02-16"), { reportPeriod: "2026-09-30", dueDate: "2026-11-16" });
  assert.deepEqual(latestDueQuarter("2027-02-17"), { reportPeriod: "2026-12-31", dueDate: "2027-02-16" });
});

test("a holding that ends as a stock's holding starts with the same share count is a likely earlier CUSIP", () => {
  // Berkshire's Liberty Live Series A: the tracking stock until Q3 2025, Liberty Live Holdings from Q4 2025.
  const llyva: CusipRecord = { securityId: "llyva", cusip: "530909100", validFrom: "2025-12-31", validTo: null };
  // Sirius XM: old SIRI shares became 0.1 new shares in September 2024, so counts do not carry over.
  const siri: CusipRecord = { securityId: "siri", cusip: "829933100", validFrom: "2024-09-30", validTo: null };
  const positions = [
    position("brk", "2025-06-30", "531229748", "LIBERTY MEDIA CORP DEL", 4_986_588, 1),
    position("brk", "2025-09-30", "531229748", "LIBERTY MEDIA CORP DEL", 4_986_588, 1),
    position("brk", "2025-12-31", "530909100", "LIBERTY LIVE HOLDINGS INC", 4_986_588, 1),
    position("brk", "2024-06-30", "82968B103", "SIRIUS XM HLDGS INC", 132_878_213, 1),
    position("brk", "2024-09-30", "829933100", "SIRIUS XM HOLDINGS INC", 105_155_029, 1),
  ];
  const reported = new Set(["brk|2024-06-30", "brk|2024-09-30", "brk|2025-06-30", "brk|2025-09-30", "brk|2025-12-31"]);
  const named = (issuer: string) => issuer.startsWith("LIBERTY");
  assert.deepEqual(likelyPredecessors(positions, [llyva, siri], reported, nextQuarter, named), [
    { cusip: "531229748", securityId: "llyva", investorId: "brk", issuer: "LIBERTY MEDIA CORP DEL", lastPeriod: "2025-09-30", shares: 4_986_588, investors: 1 },
  ]);
  // Once linked, the earlier CUSIP is recorded and no longer listed.
  const linked = { securityId: "llyva", cusip: "531229748", validFrom: "2023-09-30", validTo: "2025-12-15" };
  assert.deepEqual(likelyPredecessors(positions, [llyva, linked, siri], reported, nextQuarter, named), []);
  // By chance: one investor sold a fund and bought the same number of shares of an unrelated stock.
  assert.deepEqual(likelyPredecessors(positions, [llyva, siri], reported, nextQuarter, () => false), []);
  // Two investors carrying the same count over are evidence enough, without the stock's name.
  const twice = [...positions, ...positions.slice(1, 3).map((row) => ({ ...row, investorId: "blk", shares: 1000 }))];
  const both = new Set([...reported, "blk|2025-09-30", "blk|2025-12-31"]);
  assert.deepEqual(likelyPredecessors(twice, [llyva, siri], both, nextQuarter, () => false).map((match) => match.investors), [2]);
  // A CUSIP still reported afterwards, by any investor, was not replaced.
  const stillReported = [...positions, position("blk", "2025-12-31", "531229748", "LIBERTY MEDIA CORP DEL", 10, 1)];
  assert.deepEqual(likelyPredecessors(stillReported, [llyva, siri], new Set([...reported, "blk|2025-12-31"]), nextQuarter, named), []);
});

test("a split is seen across holders: price per share falls by the ratio while share counts rise by it", () => {
  // NVIDIA's 10-for-1 split in Q2 2024, the price itself up 37%: one holder kept its shares, one also bought.
  const nvidia = [
    position("tiger", "2024-03-31", "67066G104", "NVIDIA CORPORATION", 1_000_000, 903_560_000),
    position("tiger", "2024-06-30", "67066G104", "NVIDIA CORPORATION", 10_000_000, 1_235_400_000),
    position("coatue", "2024-03-31", "67066G104", "NVIDIA CORPORATION", 500_000, 451_780_000),
    position("coatue", "2024-06-30", "67066G104", "NVIDIA CORPORATION", 6_000_000, 741_240_000),
  ];
  assert.deepEqual(marketSplits(nvidia, previousQuarter).map(({ cusip, reportPeriod, ratio, holders }) => ({ cusip, reportPeriod, ratio, holders })), [
    { cusip: "67066G104", reportPeriod: "2024-06-30", ratio: 10, holders: 2 },
  ]);
  // A 55% crash with unchanged share counts is not a split, nor is a fund doubling a position that fell 40%.
  const crash = [
    position("baker", "2024-03-31", "000000000", "EXAMPLE BIO", 1_000_000, 20_000_000),
    position("baker", "2024-06-30", "000000000", "EXAMPLE BIO", 1_000_000, 9_000_000),
    position("quant", "2024-03-31", "000000000", "EXAMPLE BIO", 300_000, 6_000_000),
    position("quant", "2024-06-30", "000000000", "EXAMPLE BIO", 610_000, 7_320_000),
  ];
  assert.deepEqual(marketSplits(crash, previousQuarter), []);
});
