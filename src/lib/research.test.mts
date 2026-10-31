import assert from "node:assert/strict";
import { test } from "node:test";
import { detailReturnTarget, matchingInvestors, notableChanges, reportingQuarter, researchHref, resultPage, returnTarget, searchQuery } from "./research.ts";
import type { PortfolioChange } from "./portfolio-changes.ts";
import { quarterChange, type QuarterHolding } from "./stock.ts";

const quarter = "2026-06-30";
const root = "/search?quarter=2026-06-30&q=Apple&page=2#stock-AAPL";

test("return links preserve the exact results query, page, quarter and result anchor", () => {
  assert.deepEqual(returnTarget(root), { href: root, label: "Back to search results" });
  assert.equal(returnTarget("/stocks?q=BRK.B&quarter=2024-06-30&page=3#stock-BRK-B")?.href,
    "/stocks?quarter=2024-06-30&q=BRK.B&page=3#stock-BRK-B");
  assert.equal(returnTarget("/investors?quarter=2024-09-30#investor-valueact-holdings")?.label, "Back to investors");
});

test("return destinations cannot escape the app or carry nested navigation", () => {
  for (const value of ["https://example.com", "//example.com", "/\\example.com", "javascript:alert(1)", "/stocks/AAPL", "/api", "/search\n", [root]]) {
    assert.equal(returnTarget(value), undefined);
  }
  assert.equal(returnTarget("/search?q=AAPL&from=%2Fstocks&back=%2Finvestors&quarter=no&page=-2#unknown")?.href, "/search?q=AAPL");
  assert.equal(returnTarget("/search?" + "a".repeat(2000)), undefined);
});

test("previous research views retain filters and original results without growing a navigation chain", () => {
  const previous = researchHref("/investors/berkshire-hathaway", {
    quarter, q: "AAPL", holdings: "all", sort: "name-asc", page: "2", change: "closed", changePage: "3", from: root, back: "/stocks/NVDA",
  }) + "#holdings";
  const target = detailReturnTarget(previous)!;
  const url = new URL(target.href, "https://research.invalid");
  for (const [key, value] of Object.entries({ quarter, q: "AAPL", holdings: "all", sort: "name-asc", page: "2", change: "closed", changePage: "3", from: root })) {
    assert.equal(url.searchParams.get(key), value);
  }
  assert.equal(url.hash, "#holdings");
  assert.equal(url.searchParams.has("back"), false);
  let view = previous;
  for (let step = 0; step < 30; step += 1) {
    const back = detailReturnTarget(view)!.href;
    view = researchHref(step % 2 ? "/stocks/AAPL" : "/investors/berkshire-hathaway", { quarter, from: root, back });
    assert.ok(view.length < 700);
  }
  assert.equal(detailReturnTarget("/stocks/AAPL?quarter=2024-06-30&investor=berkshire-hathaway&filter=decreased#holders")?.label, "Back to AAPL overview");
  for (const value of ["//example.com/stocks/AAPL", "/search", "/investors/a/b", "/stocks/%2FAAPL", "/stocks/AAPL\r"]) assert.equal(detailReturnTarget(value), undefined);
});

test("search and quarter inputs handle duplicated, empty and malformed query parameters", () => {
  assert.equal(searchQuery("  %AAPL_*\\  "), "AAPL");
  assert.equal(searchQuery(["AAPL", "MSFT"]), "");
  assert.equal(searchQuery("a".repeat(200)).length, 100);
  assert.equal(reportingQuarter("2024-06-30"), "2024-06-30");
  for (const value of ["2024-06-31", "2024-02-30", "tomorrow", [quarter]]) assert.equal(reportingQuarter(value), undefined);
  for (const value of ["0", "-1", "1e6", "1000000", ["2"]]) assert.equal(resultPage(value), 1);
  assert.equal(resultPage("32"), 32);
});

test("investor search matches readable and filed names, punctuation, slugs and padded CIKs", () => {
  const investors = [
    { name: "D. E. Shaw", filedName: "D. E. SHAW & CO., INC.", slug: "d-e-shaw", cik: "1009207" },
    { name: "Berkshire Hathaway", filedName: "BERKSHIRE HATHAWAY INC", slug: "berkshire-hathaway", cik: "1067983" },
  ];
  for (const query of ["de shaw", "D-E-SHAW", "Shaw & Co", "0001009207"]) assert.equal(matchingInvestors(investors, query)[0]?.slug, "d-e-shaw");
  assert.equal(matchingInvestors(investors, "BERKSHIRE")[0]?.slug, "berkshire-hathaway");
  assert.deepEqual(matchingInvestors(investors, "."), []);
  assert.deepEqual(matchingInvestors(investors, "unknown"), []);
});

const holding = (reportPeriod: string, shares: number): QuarterHolding => ({
  reportPeriod, shares, valueUsd: shares * 10, state: shares > 0 ? "held" : "not-held", confidentialOmissions: false, unconfirmed: null, received: null,
});
function position(id: string, weights: [number | null, number | null], extra: Partial<PortfolioChange> = {}): PortfolioChange {
  const previous = holding("2026-03-31", 100);
  const current = holding(quarter, 150);
  return { id, name: id, ticker: "AAPL", cusips: ["037833100"], previous, current, previousWeight: weights[0], currentWeight: weights[1], category: "increased", change: quarterChange(current, previous), ...extra };
}
const manager = (id: string, changes: PortfolioChange[]) => ({ investor: { id, name: id, slug: id }, changes });

test("highlights select one change per manager and rank weight shifts across differently sized portfolios", () => {
  const input = [manager("first", [position("large-position-small-shift", [0.5, 0.51]), position("larger-shift", [0.02, 0.12])]),
    manager("second", [position("biggest-shift", [0.01, 0.31])]), manager("third", [position("third", [0.03, 0.01])])];
  const before = structuredClone(input);
  const highlights = notableChanges(input, 2);
  assert.deepEqual(highlights.map((highlight) => highlight.position.id), ["biggest-shift", "larger-shift"]);
  assert.deepEqual(input, before);
});

test("corporate actions, uncertainty, missing weights and unchanged positions cannot become highlights", () => {
  const candidates = [
    position("corporate", [0.6, 0], { category: "corporate-action" }),
    position("unclear", [0.6, 0], { category: "not-comparable" }),
    position("missing", [null, 0.9]), position("invalid", [NaN, 0.9]),
    position("unchanged", [0.6, 0], { category: "unchanged" }), position("same-weight", [0.6, 0.6]),
    position("ordinary", [0.01, 0.04]),
  ];
  assert.deepEqual(notableChanges([manager("one", candidates)]).map((item) => item.position.id), ["ordinary"]);
  assert.deepEqual(notableChanges([]), []);
});

test("an exit can be highlighted with an actual reported zero and a full prior portfolio weight", () => {
  const previous = holding("2026-03-31", 100);
  const current = holding(quarter, 0);
  const exit = position("exit", [0.2, 0], { previous, current, category: "closed", change: quarterChange(current, previous) });
  assert.equal(notableChanges([manager("one", [exit])])[0]?.position.change.kind, "closed");
  assert.equal(exit.current.state, "not-held");
  assert.equal(exit.current.shares, 0);
});
