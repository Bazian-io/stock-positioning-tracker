import assert from "node:assert/strict";
import { test } from "node:test";
import { nextQuarter, previousQuarter } from "../../src/lib/stock.ts";
import { isValidCusip } from "../securities/identify.mts";
import {
  consecutivePairs, latestDueQuarter, likelyPredecessors, outsideWindows, priceDisagreements, priceJumps, suspectedTypos, type CusipRecord,
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
  const sameQuarter = [position("brk", "2026-06-30", "037833100", "APPLE INC", 100, 20_500), position("blk", "2026-06-30", "037833100", "APPLE INC", 200, 41_100)];
  assert.deepEqual(priceDisagreements(sameQuarter), []);
  assert.equal(priceDisagreements([sameQuarter[0], { ...sameQuarter[1], valueUsd: 41 }]).length, 1);
});

test("the latest quarter due is the last one whose 45-day filing deadline has passed", () => {
  assert.deepEqual(latestDueQuarter("2026-10-29"), { reportPeriod: "2026-06-30", dueDate: "2026-08-14" });
  assert.deepEqual(latestDueQuarter("2026-11-14"), { reportPeriod: "2026-09-30", dueDate: "2026-11-14" });
  assert.deepEqual(latestDueQuarter("2027-01-10"), { reportPeriod: "2026-09-30", dueDate: "2026-11-14" });
  assert.deepEqual(latestDueQuarter("2027-02-14"), { reportPeriod: "2026-12-31", dueDate: "2027-02-14" });
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
  assert.deepEqual(likelyPredecessors(positions, [llyva, siri], reported, nextQuarter), [
    { cusip: "531229748", securityId: "llyva", investorId: "brk", issuer: "LIBERTY MEDIA CORP DEL", lastPeriod: "2025-09-30", shares: 4_986_588 },
  ]);
  // Once linked, the earlier CUSIP is recorded and no longer listed.
  const linked = { securityId: "llyva", cusip: "531229748", validFrom: "2023-09-30", validTo: "2025-12-15" };
  assert.deepEqual(likelyPredecessors(positions, [llyva, linked, siri], reported, nextQuarter), []);
});
