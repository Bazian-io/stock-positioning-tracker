# Investors directory performance

Implemented locally on 11 November 2026. No live database reads, migrations or deployments.

## What changed

Previously `/investors` loaded the shared investor/history summary, then called `getPositions` for
each reporting investor concurrently. Each call requested an exact grouped position count and the
largest holding, including several fields the directory never displayed. Top-holding stock links
were loaded separately. Even with investor summaries cached, holdings queries ran on every visit.

The new `getInvestorDirectory` reuses `getInvestorSummaries` and `getStockLinks`. The read-only
`directory_portfolio_summaries(uuid[], date[])` function replaces individual holdings requests.
It pairs each investor with its selected quarter, counts all grouped positions with a window count,
then returns only the largest holding's CUSIP, filed name and USD value. Each portfolio is aggregated
once for its count and largest holding. The app batches at most 100 investors per call.

The complete directory result, including stock links, uses the existing bounded research cache.
Its key includes the selected quarter (or latest-per-investor mode), excluding navigation parameters.
It shares the invalidation tag, secret requirement, daily key rollover and error/size guards.
Incomplete, mismatched or invalid summaries throw before caching. Failed stock-link reads also fail
the fill. Hits skip the directory's database calls and data preparation.

## Financial behavior

- The existing amendment-aware `portfolio_positions` view supplies counts and top holdings.
  No stored data or view definitions change.
- Counts remain exact grouped position counts, not source-row counts or estimates. Options,
  principal positions and separate share classes remain included as before.
- Largest-holding ties use the same full ordering as `getPositions`.
- Weights retain the full reported portfolio denominator and the existing zero-value rule.
- Missing reports remain unavailable; validated empty reports show zero positions.
- Names, groups, CIKs, slugs, quarter histories, trend values and stock-link validity rules use the
  existing loaders. Corporate-action/CUSIP history is not rewritten or adjusted.
- Page markup and navigation are unchanged apart from consuming the prepared directory rows.

## Local measurements

The entire 31 October backup was restored into isolated PGlite: 20 investors, 394 filings and
430,587 holdings, with all reference data and current local migrations. Queries used the `anon` role
after local table statistics were refreshed. Network calls were blocked. Before/after display data
matched for **all 20 imported quarters**, latest mode and a quarter with no reports.

For latest mode (Q2 2026):

| Measurement | Before | After |
| --- | ---: | ---: |
| Database requests, cold directory | 25 | 6 |
| Database requests, cached revisit | 23 | 0 |
| Cold response JSON bytes | 57,468 | 55,272 |
| Revisit response JSON bytes | 10,166 | 0 |
| Local holdings-summary SQL time | 279 ms | 161 ms |
| Warm application loader wall time | 0.59 ms | 0.28 ms |
| Warm application loader CPU time | 0.61 ms | 0.28 ms |

The six cold requests are two investor/history reads, one batched summary RPC and three stock-link
reads. Latest mode may need additional stock-link reads when investors' latest quarters differ.
A quarter with no reports skips the holdings RPC entirely. Cold request count fell 76%; cold JSON
size fell only 3.8%. The larger ongoing egress saving comes from cache hits avoiding all directory
reads. The complete Next cache record measured about 35 KB, below the 1 MB guard; no gzip is needed.

These are **local estimates, not measured Supabase network transfer or Vercel billing**. The adapter
models a PostgREST exact-count read as a result query plus a filtered count in one SQL statement;
it does not run PostgREST. Numeric sorting uses the underlying numeric column before text projection.
SQL timings describe one serialized local preparation run per case, not concurrent production
latency. Application timings replay JSON to exclude SQL/network time: medians of three cold fills
and five warm reads, with garbage collection requested before each sample. They exclude React
rendering. CPU timings at this scale are noisy. Cold application work can increase slightly because
the whole directory is serialized for caching; repeat visits avoid that work.

The [raw results](investor-directory-performance.json) include hashes, counts, bytes and timings for
seven scenarios. All imported quarters were also compared, including the intentional State Street
Q1 2023 and ValueAct Q3 2024 gaps. Tests cover amendments, units, options, principal positions, ties,
missing identifiers, mixed quarters, zero/missing reports, more than 1,000 positions, batching,
permissions, rejected partial responses and invalidation.

## Release dependency and remaining risks

`20261111000000_directory_portfolio_summaries.sql` is **prepared locally and unapplied**. It must be
approved and applied before deploying the directory code. The earlier comparison migration is also
still required for the comparison changes. Both are additive and compatible with the old application.
No new index, table, materialized view, scheduled task or paid service.

The RPC is `STABLE`, `SECURITY INVOKER`, has an explicit search path and only grants execution to the
existing application/collector roles. It has no dynamic SQL or writes, rejects mismatched/null
inputs and limits each call to one quarter per investor and 100 investors. Existing RLS applies.

Cold requests still aggregate selected portfolios; simultaneous misses can duplicate that work.
Larger future datasets can still time out. Directory rows still render per request. Other pages'
holdings queries, stock-series calculations and comparison cold misses are unchanged. Imports and
cache fills are not atomic: finish the batch, let old requests settle, run `npm run cache:invalidate`,
and verify the updated result. Keep deployment protection until actual egress, cache hits and Fluid
CPU have been measured after a separately approved release.
