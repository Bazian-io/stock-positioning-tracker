# Research data cache

The server caches investor summaries, the Investors directory, stock ownership, calculated quarter-to-quarter portfolio
changes, same-quarter investor comparisons, and compact homepage highlights with Next's `unstable_cache`.
It uses Vercel's managed Data Cache without enabling Cache Components or adding a service.
React `cache()` still handles the existing within-request metadata lookups.

## Initial measurements before selection

Measured on 10 November 2026 using the **local 31 October backup**, not live Supabase. The backup
contains 20 investors, 394 filings and 430,587 holdings. An isolated PGlite database used the existing
migrations and backed-up reference/filing rows. Holdings were restored only for Q1/Q2 2026 and all
quarters of AAPL, TSLA and NVDA (including their conversion sources). Existing data loaders and
financial calculation functions were run against those local views.

Sizes are UTF-8 JSON bytes, without HTTP/compression overhead; query counts and response bytes
describe the corresponding offline reads, not a measurement of current production billing.

| Candidate | Result bytes | Reads on a cache miss | JSON response bytes from those reads |
| --- | ---: | ---: | ---: |
| All investor summaries | 26,044 | 2 | 47,302 |
| Compact homepage highlights, Q2 2026 | 5,334 | 59 | 804,090 |
| AAPL ownership, all imported quarters | 86,956 | 4 | 98,924 |
| TSLA ownership, all imported quarters | 84,767 | 5 | 96,383 |
| NVDA ownership, all imported quarters | 93,563 | 5 | 106,619 |
| Berkshire Q1-to-Q2 changes | 20,169 | 4 | 38,317 |
| Bridgewater Q1-to-Q2 changes | 799,260 | 20 | 1,371,364 |
| D. E. Shaw Q1-to-Q2 changes | 2,447,777 | 53 | 3,827,990 |
| Two Sigma Q1-to-Q2 changes | 2,825,651 | 62 | 4,520,167 |
| State Street Q1-to-Q2 changes | 2,870,097 | 65 | 4,933,112 |
| D. E. Shaw / Two Sigma comparison, Q2 | 2,445,566 | 65 | 4,584,308 |

The homepage entry contains the same six selected highlights and coverage counts, rather than all
managers' intermediate comparisons. Its financial ranking rules and rendered content are unchanged.
Individual quarter summaries measured only 142–2,773 bytes; they are left uncached in this phase.
These are the original, unencoded sizes. The large results now use the bounded encoding below.

## Large comparison improvements

- `comparison_positions(uuid[], date[])` reads all required long-share positions once through the
  existing `portfolio_positions` view. It returns one JSON value, avoiding the 1,000-row API cap and
  repeated database aggregation for successive API pages. Its tuples omit repeated field names;
  quantities and values remain exact decimal strings. Requests are limited to two portfolios:
  one investor/two quarters or two investors/one quarter. It is `STABLE`, runs as the caller, and
  preserves RLS. It adds no stored data and has no data-writing statements.
- Security metadata is returned once per security with its identifiers nested, rather than repeating
  the security name, UUID and unused fields for each identifier. All aliases and validity dates remain.
  The existing `security_identifiers_security_idx` supports the child lookup. A capped identifier
  history is rejected rather than treated as complete.
- Large completed comparison results use lossless gzip at level 1 in the Next Data Cache. Filter,
  search and page visits reuse the same result. This removes the old 1,500-row exclusion. Dashboard
  quarter arguments are normalized to the financial fields so extra display metadata does not
  create duplicate cache entries.
- The existing TypeScript financial calculations still run on complete inputs. Page helpers compute
  full-result counts and shared weights before slicing 25 displayed rows. Source holdings are never
  paginated before classification, so exits, overlap and full-portfolio weights remain accurate.

Local before/after measurements use the same October backup and the `anon` role. The full financial
outputs matched for all five cases (15,911 change rows and 4,574 same-quarter comparison rows).

| Dataset | Cold JSON bytes before | Cold JSON bytes after | Fresh-cache database reads | Stored entry bytes |
| --- | ---: | ---: | ---: | ---: |
| D. E. Shaw changes | 3,827,990 | 2,032,742 | 0 | 560,983 |
| Two Sigma changes | 4,520,167 | 2,399,288 | 0 | 656,343 |
| State Street changes | 4,933,112 | 2,620,020 | 0 | 690,575 |
| Renaissance changes | 3,930,800 | 2,084,564 | 0 | 571,767 |
| D. E. Shaw / Two Sigma | 4,584,308 | 2,431,931 | 0 | 587,195 |

Cold response JSON bytes fell about 47%. Position aggregation reads fell from 7–9 to one per tested
comparison. Other cold reads still load reporting coverage, corporate actions and identifier batches.
Fresh hits skip every database read in the comparison loader and reuse completed financial calculations.
In a single local SQL preparation run per case, position-input reads took 108–165 ms before and
41–60 ms after. These PGlite timings describe the local queries, not Supabase production latency.

The [raw local benchmark](comparison-performance.json) records checksums, query counts, bytes and
timings. SQL was executed locally to prepare response fixtures, then those JSON responses were replayed
to isolate application/cache work from database and network latency. Application timings use three
cold fills and five warm reads; garbage collection ran before timing. Process CPU includes background
GC and is not a precise measure of billed Vercel CPU. These loader measurements exclude React rendering.
Warm loader times fell from roughly 25–29 ms to 9–14 ms. Cold application work increased from roughly
27–32 ms to 39–44 ms because encoding adds work (SQL and network latency are excluded here). Warm
loads avoid downloads, parsing of those responses and financial grouping. No production CPU-saving
percentage is claimed.

## Limits and freshness

- Only successful encoded entries at most **1,000,000 bytes** are stored, leaving encoding headroom
  below Next's 2 MiB limit. Only portfolio changes and same-quarter comparisons opt into gzip. Their
  expanded JSON is limited to 8 MB; decoding enforces the same bound. Results that exceed either bound
  are returned normally, without a second download, but are not cached. Nothing is truncated to fit.
- Failed queries throw before storage. A homepage with any failed comparison is returned with its
  existing partial-result message but is not cached. Non-finite numbers are not serialized to null.
  Missing reports and uncertain positions remain legitimate financial states, not fabricated zeros.
- Cache keys include the loader, all arguments, source Supabase URL, implementation version and UTC
  date. The date prevents an old current-ticker selection surviving into a new day. Navigation-only
  query parameters never reach these loaders.
- The Next revalidation interval is 24 hours. A new cache key at each UTC-day boundary additionally
  forces a fresh read, at most one calendar day after a fill. Tests prove a failed next-day refresh
  throws instead of returning yesterday's data. This automatic refresh does not replace invalidation
  after a correction that needs to appear immediately.
  Cache entries may also be evicted. No full-site warming, background cron or extra database table.
- All six loaders share one application-specific tag. Corrections to an old quarter, an identifier
  or another investor's split evidence can affect multiple pages, so targeted expiry is deferred.
- Bump the internal cache version when changing calculation semantics or cached output shapes in a
  future release. This is unrelated to the public version section.

## Enabling and invalidating (requires a separately approved release)

No actual credentials or Vercel settings are changed by this implementation. Caching remains disabled
until `RESEARCH_CACHE_SECRET` is configured with a cryptographically random secret of at least 32
characters. **Next.js does not require this secret**: this is our deliberate deployment safety policy
so caching cannot be enabled before secure manual invalidation is available. The secret authenticates
the endpoint; it does not encrypt the financial data. Put the same value in the server environment and local `.env.local` used
by the invalidation command. Never expose it in client code, a URL, a command argument or logs.
It is a separate secret from Supabase's keys; the web app still uses only the publishable database key.

Set `RESEARCH_APP_URL` locally to the production HTTPS origin. When Vercel Authentication protects
the deployment, also set the local `VERCEL_AUTOMATION_BYPASS_SECRET` obtained from Vercel's approved
automation bypass settings. Keep deployment protection enabled. If the paused team or plan prevents
reaching the endpoint, cache invalidation has not succeeded; do not treat the site as updated.

After each approved import/amendment/correction batch has finished publishing validated data:

```sh
npm run cache:invalidate
```

This is an **explicit manual post-import step**, not an automatic collector hook. Run it after partial
collector failures too if any validated data was published. Run it again after subsequent identifier
or conversion corrections. Coordinate it after writers and in-flight old reads have finished; cache
invalidation and database publication are not one transaction.

The command sends a protected POST to `/api/revalidate`, with credentials in headers and redirects
disabled. HTTPS is required except for loopback testing. The endpoint only expires the fixed research
tag with `revalidateTag(tag, { expire: 0 })`; it cannot modify the database or accept arbitrary tags.
Missing configuration returns 503, incorrect authentication returns 401, and other HTTP methods get
405 from Next. The next server request reloads expired data. Already open browser pages need a reload.

Check the command's exit status and verify one corrected value in the app. The response acknowledges
the invalidation request; Vercel can reject framework revalidation under platform limits without
throwing. Check server warnings and retry if necessary. Call once per batch, not once per holding.

### Required release order

The new code depends on **two unapplied local migrations**:
`supabase/migrations/20261110000000_comparison_positions.sql` and
`supabase/migrations/20261111000000_directory_portfolio_summaries.sql`. After separate approval, back up the
database and apply those migrations before deploying the application. They are additive and compatible
with the old code and request a PostgREST schema-cache reload. Confirm each new function is
available, configure the invalidation credentials, then deploy behind protection and verify one
bounded comparison and directory request. No live migration, credential configuration or deployment is performed here.

The directory batches its counts and largest holdings, then caches its complete display data.
See [directory performance and validation](investor-directory-performance.md).

## CPU, cost and remaining work

Fresh hits skip Supabase reads and the calculations inside the cached loaders. In particular,
homepage ranking and eligible portfolio-change grouping/split calculations are reused. Stock ownership
hits skip downloads and normalization, but the stock page still builds its series and renders on each
request. Every dynamic page still invokes a function; this is not full-page/CDN caching.

The offline tests use the installed Next IncrementalCache and invalidation implementation, with fresh
request contexts and a synthetic PostgREST transport that refuses all external destinations. They
cover reuse, corrected data, rejected authentication, failed later pages, partial highlights, oversized
UTF-8 results, UTC rollover, financial states and the manual command. `npm run test:web` runs them.

Cold aggregate/view queries can still time out: the first comparison must read its complete relevant
inputs. Encoding adds CPU on misses, and each cache hit still decodes a complete result before filtering
and rendering 25 rows. Results larger than the limits remain uncached. Dashboard exact-count queries,
directory cold aggregations, per-stock series calculations, repeated rendering and traffic to many distinct
URLs remain. Concurrent cold requests may repeat work. Cache invalidation and database updates are not
one transaction; coordinate imports and verify refreshed values as described above.
Vercel's cache also has finite Hobby quotas; track cache reads/writes, Supabase bytes and Fluid CPU.

Next phase: inspect remaining cold query plans and dashboard exact counts, then profile
remaining page rendering using bounded requests after an approved protected release. Measure actual
cache hit rates, cache quota use, egress and Fluid CPU before restoring unrestricted public access.

References: [Next.js caching API](https://nextjs.org/docs/app/api-reference/functions/unstable_cache),
[tag expiry](https://nextjs.org/docs/app/api-reference/functions/revalidateTag),
[Vercel cache limits](https://vercel.com/docs/caching/runtime-cache/data-cache),
[Vercel cache usage](https://vercel.com/docs/runtime-cache#pricing).
