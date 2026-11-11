import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { setTimeout } from "node:timers/promises";
import { randomBytes } from "node:crypto";

// Exercise the installed Next cache and tag invalidation, with a new request store per call.
// Only the server-only bundler marker and extensionless imports need Node test adapters.
Object.assign(globalThis, { AsyncLocalStorage });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier === "next/cache") return next("next/cache.js", context);
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const url = new URL(specifier, context.parentURL);
    if (existsSync(`${url.pathname}.ts`)) return next(`${url.href}.ts`, context);
  }
  return next(specifier, context);
} });

const { IncrementalCache } = await import("next/dist/server/lib/incremental-cache/index.js");
const { nodeFs } = await import("next/dist/server/lib/node-fs-methods.js");
const { createWorkStore } = await import("next/dist/server/async-storage/work-store.js");
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
const { executeRevalidates } = await import("next/dist/server/revalidation-utils.js");
const { cacheResearch, RESEARCH_CACHE_MAX_BYTES } = await import("./research-cache.ts");
const { POST } = await import("../app/api/revalidate/route.ts");
const { getInvestorSummaries, getPositions } = await import("./portfolio-data.ts");
const { getInvestorDirectory } = await import("./investor-directory-data.ts");
const { getPortfolioChanges, getInvestorComparison } = await import("./portfolio-changes-data.ts");
const { getStockOwnership, getStockLinks } = await import("./stock-data.ts");
const { getHighlights } = await import("./research-highlights-data.ts");
const { revalidateResearch } = await import("../../scripts/revalidate-research.mts");

const secret = "offline-test-secret-".repeat(3);
const preview = { previewModeId: "offline", previewModeSigningKey: "offline", previewModeEncryptionKey: "offline" };
const incrementalCache = new IncrementalCache({
  dev: false, requestHeaders: {}, fs: nodeFs, serverDistDir: "/tmp/stock-tracker-no-cache-files",
  flushToDisk: false, maxMemoryCacheSize: 8 * 1024 * 1024, previewProps: preview,
  prerenderManifest: { version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview },
});

async function request<T>(read: () => Promise<T>): Promise<T> {
  const store = createWorkStore({
    page: "/offline/route", buildId: "offline", deploymentId: "offline", previouslyRevalidatedTags: [],
    renderOpts: {
      incrementalCache, cacheLifeProfiles: { default: { stale: 300, revalidate: 900, expire: 86400 } },
      cacheComponents: false, validationLevel: "warning", staticPageGenerationTimeout: 60,
      experimental: { authInterrupts: false, useCacheTimeout: 50, durableUseCacheEntries: false },
      waitUntil: undefined, onClose: () => {}, onAfterTaskError: undefined,
    },
  });
  return workAsyncStorage.run(store, async () => {
    try { return await read(); }
    finally { await executeRevalidates(store); }
  });
}

async function invalidate() {
  // Next's local cache compares millisecond timestamps strictly. Separate these otherwise
  // instantaneous fixture requests, as a real post-import HTTP roundtrip would be separated.
  await setTimeout(2);
  return request(() => POST(new Request("https://app.invalid/api/revalidate", {
    method: "POST", headers: { Authorization: `Bearer ${secret}` },
  })));
}

type Row = Record<string, unknown>;
const current = { reportPeriod: "2026-06-30", valueUsd: 10000, confidentialOmissions: false };
const previous = { ...current, reportPeriod: "2026-03-31" };
const stock = {
  securityId: "security-a", ticker: "TEST", exchange: "XNAS", name: "Test", companyName: null,
  issuerName: "TEST INC", shareClass: null, securityType: "common",
  cusips: [{ cusip: "123456789", validFrom: "2020-01-01", validTo: null }],
};
function fixtures(): Record<string, Row[]> {
  const security = { id: stock.securityId, issuer_name: stock.issuerName, listing_name: null, share_class: null, security_type: "common" };
  return {
    investors: [{ id: "investor-a", name: "TEST MANAGER", display_name: "Test manager", cik: "0000000001", slug: "test-manager", segment: "active_manager" }],
    quarterly_portfolios: [previous, current].map(q => ({
      investor_id: "investor-a", report_period: q.reportPeriod, value_usd: String(q.valueUsd), has_confidential_omissions: false,
    })),
    portfolio_positions: [previous, current].map((q, i) => ({
      investor_id: "investor-a", report_period: q.reportPeriod, reported_cusip: "123456789",
      reported_issuer: "TEST INC", reported_class: "COM", position_type: "long", quantity_type: "SH",
      quantity: String(100 + i * 50), value_usd: String(1000 + i * 500),
    })),
    security_conversions: [],
    securities: [security],
    security_identifiers: ["cusip", "ticker"].map((type, i) => ({
      id: String(i), security_id: stock.securityId, identifier_type: type, identifier_value: i ? "TEST" : "123456789",
      namespace: i ? "XNAS" : "", valid_from: "2020-01-01", valid_to: null, securities: security,
    })),
  };
}
let tables = fixtures();
let queries: URL[] = [];
let fail: (url: URL) => boolean = () => false;
let directoryResult = (rows: unknown[][]) => rows;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.origin, "https://research-cache-test.invalid", "Tests must never contact a live service");
  queries.push(url);
  if (fail(url)) return Response.json({ message: "offline statement timeout", code: "57014" }, { status: 500 });
  const table = url.pathname.split("/").at(-1)!;
  if (url.pathname.endsWith("/rpc/comparison_positions")) {
    const args = JSON.parse(String(init?.body));
    const positions = tables.portfolio_positions.filter(row => args.p_investor_ids.includes(row.investor_id)
      && args.p_report_periods.includes(row.report_period) && row.position_type === "long" && row.quantity_type === "SH");
    return Response.json(positions.map(row => [row.investor_id, row.report_period, row.reported_cusip,
      row.reported_issuer, row.reported_class, row.quantity, row.value_usd]));
  }
  if (url.pathname.endsWith("/rpc/directory_portfolio_summaries")) {
    const args = JSON.parse(String(init?.body));
    return Response.json(directoryResult(args.p_investor_ids.map((id: string, i: number) => {
      const period = args.p_report_periods[i];
      const positions = tables.portfolio_positions.filter(row => row.investor_id === id && row.report_period === period)
        .sort((a, b) => Number(b.value_usd) - Number(a.value_usd) || String(a.reported_issuer).localeCompare(String(b.reported_issuer)));
      const top = positions[0];
      return [id, period, String(positions.length), top?.reported_cusip ?? null, top?.reported_issuer ?? null, top?.value_usd ?? null];
    })));
  }
  assert.ok(tables[table], `Unexpected table: ${table}`);
  let rows = tables[table].slice();
  for (const [key, filter] of url.searchParams) {
    if (["select", "order", "offset", "limit", "security_identifiers.order"].includes(key)) continue;
    const dot = filter.indexOf(".");
    const op = filter.slice(0, dot), value = filter.slice(dot + 1);
    rows = rows.filter(row => {
      if (op === "in") return value.slice(1, -1).split(",").includes(String(row[key]));
      if (op === "eq") return String(row[key]) === value;
      if (op === "neq") return String(row[key]) !== value;
      if (op === "gt") return String(row[key]) > value;
      if (op === "lte") return String(row[key]) <= value;
      throw new Error(`Unsupported offline filter: ${op}`);
    });
  }
  const order = url.searchParams.get("order")?.split(",") ?? [];
  rows.sort((a, b) => {
    for (const term of order) {
      const [column, direction] = term.split(".");
      const comparison = column === "value_usd" ? Number(a[column]) - Number(b[column]) : String(a[column]).localeCompare(String(b[column]));
      if (comparison) return direction === "desc" ? -comparison : comparison;
    }
    return 0;
  });
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const total = rows.length;
  rows = rows.slice(offset, offset + Number(url.searchParams.get("limit") ?? 1000));
  const columns = (url.searchParams.get("select") ?? "*").split(/,(?![^()]*\))/);
  const data = rows.map(row => Object.fromEntries(columns.map(column => {
    if (column.trim().startsWith("security_identifiers(")) {
      const fields = column.slice(column.indexOf("(") + 1, -1).split(",").map(field => field.trim());
      return ["security_identifiers", tables.security_identifiers.filter(identifier => identifier.security_id === row.id)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map(identifier => Object.fromEntries(fields.map(field => [field, identifier[field]])))];
    }
    const key = column.trim().split(/::|!/)[0];
    return [key, row[key]];
  })));
  return Response.json(data, { headers: { "Content-Range": `${offset}-${offset + data.length - 1}/${total}` } });
};

beforeEach(async () => {
  process.env.RESEARCH_CACHE_SECRET = secret;
  process.env.SUPABASE_URL = "https://research-cache-test.invalid";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_offline_fixture";
  tables = fixtures(); queries = []; fail = () => false;
  directoryResult = rows => rows;
  assert.equal((await invalidate()).status, 200);
});
after(() => { globalThis.fetch = originalFetch; });

test("independent requests reuse the real Next cache, including completed calculations", async () => {
  let reads = 0;
  const calculated = cacheResearch("calculated-fixture", async (value: number) => ({ total: value * ++reads }));
  assert.deepEqual(await request(() => calculated(3)), { total: 3 });
  assert.deepEqual(await request(() => calculated(3)), { total: 3 });
  assert.equal(reads, 1);
  await invalidate();
  assert.deepEqual(await request(() => calculated(3)), { total: 6 });
  assert.equal(reads, 2);
});

// The directory's previous loading path, reduced only to the fields its JSX actually displays.
async function originalDirectory(quarter: string | null) {
  const investors = await getInvestorSummaries();
  const rows = await Promise.all(investors.map(async investor => {
    const period = quarter ?? investor.latestQuarter;
    const valueUsd = investor.values.find(summary => summary.reportPeriod === period)?.valueUsd ?? null;
    const positions = period && valueUsd !== null ? await getPositions(investor.id, period, valueUsd, 0, 1) : null;
    const largest = positions?.largest;
    return { investor, period, valueUsd, positions: positions ? { total: positions.total, largest: largest ? {
      cusip: largest.cusip, issuer: largest.issuer, valueUsd: largest.valueUsd, portfolioShare: largest.portfolioShare,
    } : null } : null };
  }));
  return Promise.all(rows.map(async row => {
    const links = row.period && row.positions?.largest?.cusip ? await getStockLinks([row.positions.largest.cusip], row.period) : {};
    return { ...row, largestStock: links[row.positions?.largest?.cusip ?? ""] ?? null };
  }));
}

test("directory batching preserves every display field and cached requests make no database reads", async () => {
  tables.portfolio_positions.push({ ...tables.portfolio_positions[1], position_type: "put", quantity: "900", value_usd: "2000" });
  tables.investors.push({ ...tables.investors[0], id: "investor-b", name: "Earlier filer", display_name: null, slug: "earlier" });
  tables.quarterly_portfolios.push({ ...tables.quarterly_portfolios[0], investor_id: "investor-b" });
  tables.portfolio_positions.push({ ...tables.portfolio_positions[0], investor_id: "investor-b" });
  for (const quarter of [null, previous.reportPeriod, current.reportPeriod, "2025-12-31"]) {
    const expected = await request(() => originalDirectory(quarter));
    const actual = await request(() => getInvestorDirectory(quarter));
    assert.deepEqual(actual, expected);
    const reads = queries.length;
    assert.deepEqual(await request(() => getInvestorDirectory(quarter)), expected);
    assert.equal(queries.length, reads);
  }
  const latest = await request(() => getInvestorDirectory(null));
  const owner = latest.find(row => row.investor.id === "investor-a")!;
  assert.equal(owner.positions?.total, 2);
  assert.equal(owner.positions?.largest?.portfolioShare, 0.2); // Options stay in the full portfolio.
  assert.equal(latest.find(row => row.investor.id === "investor-b")?.period, previous.reportPeriod);
});

test("directory keeps missing reports, verified empty reports, zero values and uncertain stock links distinct", async () => {
  tables.investors.push({ ...tables.investors[0], id: "no-report", slug: "no-report" });
  tables.security_identifiers[0].valid_from = "2026-04-01";
  const old = await request(() => getInvestorDirectory(previous.reportPeriod));
  assert.equal(old[0].largestStock, null);
  assert.equal(old[0].positions?.largest?.issuer, "TEST INC");
  tables.quarterly_portfolios[1].value_usd = "0";
  tables.portfolio_positions = tables.portfolio_positions.filter(row => row.report_period !== current.reportPeriod);
  const rows = await request(() => getInvestorDirectory(current.reportPeriod));
  assert.deepEqual(rows[0].positions, { total: 0, largest: null });
  assert.equal(rows[0].valueUsd, 0);
  assert.equal(rows[1].positions, null);
  assert.equal(rows[1].valueUsd, null);
});

test("directory invalidation refreshes totals, counts, largest holdings, investor names and stock links", async () => {
  await request(() => getInvestorDirectory(null));
  tables.investors[0].display_name = "Corrected manager";
  tables.quarterly_portfolios[1].value_usd = "20000";
  tables.portfolio_positions.push({ ...tables.portfolio_positions[1], reported_cusip: "987654321", reported_issuer: "OTHER", value_usd: "4000" });
  tables.security_identifiers[0].identifier_value = "987654321";
  tables.security_identifiers[1].identifier_value = "NEW";
  await invalidate();
  const rows = await request(() => getInvestorDirectory(null));
  assert.equal(rows[0].investor.name, "Corrected manager");
  assert.equal(rows[0].valueUsd, 20000);
  assert.equal(rows[0].positions?.total, 2);
  assert.equal(rows[0].positions?.largest?.portfolioShare, 0.2);
  assert.equal(rows[0].largestStock?.ticker, "NEW");
});

test("failed or incomplete directory summaries and stock links are not cached as complete results", async () => {
  for (const endpoint of ["directory_portfolio_summaries", "security_identifiers"]) {
    fail = url => url.pathname.endsWith(endpoint);
    await assert.rejects(request(() => getInvestorDirectory(null)), /offline statement timeout/);
    fail = () => false;
  }
  for (const transform of [
    (rows: unknown[][]) => rows.slice(1),
    (rows: unknown[][]) => rows.map(row => ["wrong-investor", ...row.slice(1)]),
    (rows: unknown[][]) => rows.map(row => [...row.slice(0, 2), null, null, null, null]),
  ]) {
    directoryResult = transform;
    await assert.rejects(request(() => getInvestorDirectory(null)), /directory portfolio summar/);
  }
  directoryResult = rows => rows;
  assert.equal((await request(() => getInvestorDirectory(null)))[0].positions?.total, 1);
});

test("directory batches more than 100 investors without dropping results", async () => {
  const source = fixtures();
  tables.investors = Array.from({ length: 101 }, (_, i) => ({ ...source.investors[0], id: `investor-${i}` }));
  tables.quarterly_portfolios = tables.investors.map(row => ({ ...source.quarterly_portfolios[1], investor_id: row.id }));
  tables.portfolio_positions = tables.investors.map(row => ({ ...source.portfolio_positions[1], investor_id: row.id }));
  const rows = await request(() => getInvestorDirectory(null));
  assert.equal(rows.length, 101);
  assert.ok(rows.every(row => row.positions?.total === 1));
  assert.equal(queries.filter(url => url.pathname.endsWith("directory_portfolio_summaries")).length, 2);
});

test("summaries, changes, stock ownership and compact highlights reuse reads and refresh corrected data", async () => {
  const read = async () => ({
    summaries: await getInvestorSummaries(),
    changes: await getPortfolioChanges("investor-a", current, previous),
    ownership: await getStockOwnership(stock),
    highlights: await getHighlights(current.reportPeriod),
  });
  const original = await request(read);
  assert.equal(original.changes[0].current.shares, 150);
  assert.equal(original.changes[0].currentWeight, 0.15);
  assert.equal(original.highlights.highlights.length, 1);
  const firstReads = queries.length;
  assert.ok(firstReads > 0);
  assert.deepEqual(await request(read), JSON.parse(JSON.stringify(original)));
  assert.equal(queries.length, firstReads);
  tables.portfolio_positions[1].quantity = "175";
  tables.portfolio_positions[1].value_usd = "1750";
  tables.quarterly_portfolios[1].value_usd = "12000";
  assert.deepEqual(await request(read), JSON.parse(JSON.stringify(original)));
  assert.equal(queries.length, firstReads);
  await invalidate();
  const updated = await request(read);
  assert.equal(updated.summaries[0].latestValueUsd, 12000);
  assert.equal(updated.changes[0].current.shares, 175);
  assert.equal(updated.ownership.positions[1].shares, 175);
  assert.equal(updated.highlights.highlights[0].position.currentWeight, 1750 / 12000);
  assert.ok(queries.length > firstReads);
});

test("cache keys separate arguments, denominators and database sources", async () => {
  const normal = await request(() => getPortfolioChanges("investor-a", current, previous));
  const changed = await request(() => getPortfolioChanges("investor-a", { ...current, valueUsd: 20000 }, previous));
  assert.equal(normal[0].currentWeight, 0.15);
  assert.equal(changed[0].currentWeight, 0.075);
  const requests = queries.length;
  const expanded = { ...current, amended: true, holdingRowCount: 2000 };
  assert.deepEqual(await request(() => getPortfolioChanges("investor-a", expanded, previous)), JSON.parse(JSON.stringify(normal)));
  assert.equal(queries.length, requests);
  let reads = 0;
  const read = cacheResearch("source-test", async (id: string) => ({ id, read: ++reads }));
  await request(() => read("a")); await request(() => read("b"));
  process.env.SUPABASE_URL = "https://another-offline-source.invalid";
  await request(() => read("a"));
  assert.equal(reads, 3);
});

test("an invalidated result cannot fall back to known outdated data when its next query fails", async () => {
  await request(() => getStockOwnership(stock));
  tables.portfolio_positions[1].quantity = "200";
  await invalidate();
  fail = url => url.pathname.endsWith("portfolio_positions");
  await assert.rejects(request(() => getStockOwnership(stock)), /offline statement timeout/);
  fail = () => false;
  assert.equal((await request(() => getStockOwnership(stock))).positions[1].shares, 200);
});

test("cached ownership preserves options, uncertain identifiers and confidential reports", async () => {
  tables.portfolio_positions.push({ ...tables.portfolio_positions[1], position_type: "put", quantity: "50" });
  tables.quarterly_portfolios[0].has_confidential_omissions = true;
  const limited = { ...stock, cusips: [{ ...stock.cusips[0], validFrom: "2026-04-01" }] };
  const first = await request(() => getStockOwnership(limited));
  assert.equal(first.unconfirmed.length, 1);
  assert.equal(first.positions.find(row => row.positionType === "put")?.shares, 50);
  assert.equal(first.reports[0].confidentialOmissions, true);
  const reads = queries.length;
  assert.deepEqual(await request(() => getStockOwnership(limited)), first);
  assert.equal(queries.length, reads);
});

test("UTC date changes refresh results whose ticker validity depends on today", async (t) => {
  let day = "2026-11-10T12:00:00.000Z", reads = 0;
  t.mock.method(Date.prototype, "toISOString", () => day);
  const read = cacheResearch("date-sensitive-fixture", async () => ++reads);
  assert.equal(await request(read), 1);
  assert.equal(await request(read), 1);
  day = "2026-11-11T00:00:00.000Z";
  assert.equal(await request(read), 2);
});

test("daily expiry blocks on fresh data and does not preserve yesterday's result after a failed refresh", async (t) => {
  let day = "2026-11-10T23:59:59.000Z";
  t.mock.method(Date.prototype, "toISOString", () => day);
  await request(() => getStockOwnership(stock));
  tables.portfolio_positions[1].quantity = "210";
  day = "2026-11-11T00:00:01.000Z";
  fail = url => url.pathname.endsWith("portfolio_positions");
  await assert.rejects(request(() => getStockOwnership(stock)), /offline statement timeout/);
  fail = () => false;
  assert.equal((await request(() => getStockOwnership(stock))).positions[1].shares, 210);
});

test("large complete financial results fit the cache losslessly and refresh after invalidation", async () => {
  let reads = 0;
  const financial = await request(() => getPortfolioChanges("investor-a", current, previous));
  const rows = Array.from({ length: 5000 }, (_, index) => ({ ...financial[0], id: `position-${index}` }));
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > RESEARCH_CACHE_MAX_BYTES);
  const read = cacheResearch("large-financial-fixture", async () => { reads++; return rows; }, { compress: true });
  assert.ok(JSON.stringify(await request(read)) === JSON.stringify(rows), "Cold financial values must match completely");
  assert.ok(JSON.stringify(await request(read)) === JSON.stringify(rows), "Cached financial values must match completely");
  assert.equal(reads, 1);
  rows[0] = { ...rows[0], currentWeight: 0.2 };
  await invalidate();
  assert.equal((await request(read))[0].currentWeight, 0.2);
  assert.equal(reads, 2);
});

test("data too large even after compression is returned intact without caching", async () => {
  let reads = 0;
  const value = randomBytes(1_200_000).toString("hex");
  const read = cacheResearch("incompressible-fixture", async () => { reads++; return value; }, { compress: true });
  assert.equal(await request(read), value);
  assert.equal(await request(read), value);
  assert.equal(reads, 2);
});

test("same-quarter comparisons reuse complete results across visits and reject truncated identifier histories", async () => {
  const first = await request(() => getInvestorComparison("investor-a", "missing-investor", current.reportPeriod));
  assert.equal(first.rows[0].category, "unclear");
  assert.equal(first.rows[0].right.state, "no-report");
  const reads = queries.length;
  assert.deepEqual(await request(() => getInvestorComparison("investor-a", "missing-investor", current.reportPeriod)), JSON.parse(JSON.stringify(first)));
  assert.equal(queries.length, reads);
  tables.security_identifiers = Array.from({ length: 1000 }, (_, i) => ({ ...tables.security_identifiers[0], id: String(i) }));
  await invalidate();
  await assert.rejects(request(() => getInvestorComparison("investor-a", "missing-investor", current.reportPeriod)), /identifier history exceeds/);
});

test("comparison metadata keeps historical aliases and current tickers without repeated security fields", async () => {
  tables.security_identifiers[0].valid_from = "2026-04-01";
  tables.security_identifiers.push({ ...tables.security_identifiers[0], id: "old-cusip", identifier_value: "987654321", valid_from: "2020-01-01", valid_to: "2026-04-01" });
  tables.security_identifiers.push({ ...tables.security_identifiers[1], id: "old-ticker", identifier_value: "OLD", valid_from: "2020-01-01", valid_to: "2026-04-01" });
  tables.portfolio_positions[0].reported_cusip = "987654321";
  const rows = await request(() => getPortfolioChanges("investor-a", current, previous));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].previous.shares, 100);
  assert.equal(rows[0].current.shares, 150);
  assert.equal(rows[0].ticker, "TEST");
  assert.equal(rows[0].category, "increased");
  const metadata = queries.find(url => url.pathname.endsWith("securities"))!;
  assert.equal(metadata.searchParams.get("security_identifiers.order"), "id.asc");
  assert.ok(!metadata.searchParams.get("select")!.includes("share_class"));
});

test("expanded results above the memory bound bypass caching even when highly compressible", async () => {
  let reads = 0;
  const value = "x".repeat(8_000_001);
  const read = cacheResearch("expanded-limit-fixture", async () => { reads++; return value; }, { compress: true });
  assert.equal((await request(read)).length, value.length);
  assert.equal((await request(read)).length, value.length);
  assert.equal(reads, 2);
});

test("database errors and failed later pages are never saved as complete summaries", async () => {
  tables.quarterly_portfolios = Array.from({ length: 1001 }, (_, i) => ({ ...tables.quarterly_portfolios[0], report_period: String(i).padStart(4, "0") }));
  fail = url => url.pathname.endsWith("quarterly_portfolios") && url.searchParams.get("offset") === "1000";
  await assert.rejects(request(getInvestorSummaries), /offline statement timeout/);
  const reads = queries.length;
  fail = () => false;
  const result = await request(getInvestorSummaries);
  assert.equal(result[0].quarterCount, 1001);
  assert.ok(queries.length > reads);
  const completeReads = queries.length;
  await request(getInvestorSummaries);
  assert.equal(queries.length, completeReads);
});

test("partial homepage comparisons retain their fallback but are retried on the next request", async () => {
  fail = url => url.pathname.endsWith("comparison_positions");
  const partial = await request(() => getHighlights(current.reportPeriod));
  assert.equal(partial.failed, 1);
  assert.equal(partial.compared, 0);
  fail = () => false;
  const complete = await request(() => getHighlights(current.reportPeriod));
  assert.equal(complete.failed, 0);
  assert.equal(complete.compared, 1);
  const reads = queries.length;
  assert.deepEqual(await request(() => getHighlights(current.reportPeriod)), JSON.parse(JSON.stringify(complete)));
  assert.equal(queries.length, reads);
});

test("oversized UTF-8 results are returned intact but never stored or read twice in one call", async () => {
  let reads = 0;
  const value = "€".repeat(Math.ceil(RESEARCH_CACHE_MAX_BYTES / 3));
  const read = cacheResearch("large-fixture", async () => { reads++; return { value }; });
  assert.equal((await request(read)).value, value);
  assert.equal(reads, 1);
  assert.equal((await request(read)).value, value);
  assert.equal(reads, 2);
});

test("non-finite values are not silently changed to null by cache serialization", async () => {
  let reads = 0;
  const read = cacheResearch("nonfinite-fixture", async () => { reads++; return { value: NaN }; });
  assert.ok(Number.isNaN((await request(read)).value));
  assert.ok(Number.isNaN((await request(read)).value));
  assert.equal(reads, 2);
});

test("invalidation fails closed and rejects missing, query-string and incorrect credentials", async () => {
  let reads = 0;
  const read = cacheResearch("auth-fixture", async () => ++reads);
  assert.equal(await request(read), 1);
  for (const authorization of [undefined, "Bearer wrong", "Basic wrong"]) {
    const response = await request(() => POST(new Request(`https://app.invalid/api/revalidate?secret=${secret}`, {
      method: "POST", headers: authorization ? { Authorization: authorization } : {},
    })));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await request(read), 1);
  }
  delete process.env.RESEARCH_CACHE_SECRET;
  assert.equal((await invalidate()).status, 503);
  assert.equal(await request(read), 2);
  assert.equal(await request(read), 3);
  process.env.RESEARCH_CACHE_SECRET = "too-short";
  assert.equal((await invalidate()).status, 503);
});

test("the post-import command uses a protected POST, never redirects credentials, and reports failures", async () => {
  const env = { RESEARCH_CACHE_SECRET: secret, RESEARCH_APP_URL: "https://app.invalid", VERCEL_AUTOMATION_BYPASS_SECRET: "offline-bypass" };
  let calls = 0;
  const send: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://app.invalid/api/revalidate");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    assert.equal(new Headers(init?.headers).get("x-vercel-protection-bypass"), "offline-bypass");
    return Response.json({ revalidationRequested: true });
  };
  await revalidateResearch(env, send);
  assert.equal(calls, 1);
  await assert.rejects(revalidateResearch({ ...env, RESEARCH_APP_URL: "http://app.invalid" }, send), /HTTPS origin/);
  await assert.rejects(revalidateResearch({ ...env, RESEARCH_CACHE_SECRET: "" }, send), /random secret/);
  await assert.rejects(revalidateResearch(env, async () => new Response("", { status: 503 })), /HTTP 503/);
  await assert.rejects(revalidateResearch(env, async () => Response.json({})), /acknowledge/);
});
