import assert from "node:assert/strict";
import { test } from "node:test";
import {
  axisTicks, formatDate, formatFilingDate, formatNumberAxis, formatNumberCompact, formatPercent, formatUsd, formatUsdAxis, formatUsdCompact,
  quarterLabel, secFilingUrl,
} from "./portfolio.ts";

test("axis ticks start at zero and end at a round number above the maximum", () => {
  assert.deepEqual(axisTicks(363_553_518_000), [0, 100e9, 200e9, 300e9, 400e9]);
  assert.deepEqual(axisTicks(95), [0, 25, 50, 75, 100]);
  assert.deepEqual(axisTicks(0), [0]);
});

test("values, dates and quarters are formatted for readers", () => {
  assert.equal(formatUsdCompact(299_253_556_246), "$299.25B");
  assert.equal(formatUsdCompact(7_801_234_567), "$7.80B");
  assert.equal(formatUsdCompact(580_504), "$580.50K");
  assert.deepEqual([0, 100e9, 2.5e9].map(formatUsdAxis), ["$0", "$100B", "$2.5B"]);
  assert.equal(formatUsd(299_253_556_246), "$299,253,556,246");
  assert.equal(formatNumberCompact(227_917_808), "227.92M");
  assert.deepEqual([0, 100e6, 2.5e9].map(formatNumberAxis), ["0", "100M", "2.5B"]);
  assert.equal(formatPercent(0.21985), "22.0%");
  assert.equal(formatPercent(0.0000019), "<0.1%");
  assert.equal(formatDate("2026-06-30"), "Jun 30, 2026");
  // Accepted 4:05 p.m. Eastern on Aug 14, 2026; still Aug 14 on EDGAR's calendar.
  assert.equal(formatFilingDate("2026-08-14T20:05:04+00:00"), "Aug 14, 2026");
  assert.equal(quarterLabel("2026-06-30"), "Q2 2026");
  assert.equal(quarterLabel("2021-09-30"), "Q3 2021");
  assert.equal(
    secFilingUrl("0001067983", "0001193125-26-352200"),
    "https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/0001193125-26-352200-index.htm",
  );
});
