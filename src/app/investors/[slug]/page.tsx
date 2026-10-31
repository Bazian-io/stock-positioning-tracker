import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import styles from "@/components/dashboard/dashboard.module.css";
import { HoldingsTable, type TableLink } from "@/components/dashboard/holdings-table";
import { PendingFrame, QuarterNavigation, QuarterSelect } from "@/components/dashboard/quarter-navigation";
import { ValueChart } from "@/components/dashboard/value-chart";
import {
  POSITION_SORTS, axisTicks, formatDate, formatFilingDate, formatNumber, formatPercent, formatUsd, formatUsdAxis, formatUsdCompact,
  quarterLabel, quarterParts,
} from "@/lib/portfolio";
import {
  getInvestorBySlug, getPositions, getQuarterFilings, getQuarterSummaries, type QuarterFiling,
} from "@/lib/portfolio-data";
import { getStock, getStockLinks } from "@/lib/stock-data";
import { identifiesStock } from "@/lib/stock";

type InvestorPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TOP_HOLDINGS = 10;
const ALL_HOLDINGS_PAGE = 200; // Positions per page when showing all; large filers report thousands.

export async function generateMetadata({ params }: InvestorPageProps): Promise<Metadata> {
  const investor = await getInvestorBySlug((await params).slug);
  if (!investor) return { title: "Investor not found" };
  return {
    title: `${investor.name} 13F portfolio`,
    description: `${investor.name}'s reported 13F holdings by quarter, from SEC filings.`,
  };
}

function filingRole(filing: QuarterFiling): string {
  if (filing.amendmentType === "none") return "Original report";
  const role = filing.amendmentType === "restatement" ? "restatement" : "new holdings";
  return `Amendment ${filing.amendmentNumber}, ${role}`;
}

// One dashboard for every investor in the database, at /investors/[slug].
export default async function InvestorPage({ params, searchParams }: InvestorPageProps) {
  const [{ slug }, { quarter: requested, holdings, page, q, sort: requestedSort }] = await Promise.all([params, searchParams]);
  const investor = await getInvestorBySlug(slug);
  if (!investor) notFound();
  const quarters = await getQuarterSummaries(investor.id);
  const latest = quarters.at(-1);
  const selected = requested === undefined ? latest : quarters.find((quarter) => quarter.reportPeriod === requested);
  if (!latest || !selected) notFound();

  const query = typeof q === "string" ? q.trim().slice(0, 100) : "";
  const sort = POSITION_SORTS.find((candidate) => candidate.value === requestedSort) ?? POSITION_SORTS[0];
  const filtered = query !== "" || sort !== POSITION_SORTS[0];
  const showAll = holdings === "all" || filtered;
  const pageNumber = showAll && typeof page === "string" && /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1;
  const limit = showAll ? ALL_HOLDINGS_PAGE : TOP_HOLDINGS;
  const ticker = query.toUpperCase().replace(/[./]/g, "-");
  const matchingStock = /^[A-Z0-9-]{1,10}$/.test(ticker) ? await getStock(ticker) : null;
  const cusips = matchingStock?.cusips.filter((period) => identifiesStock([period], period.cusip, selected.reportPeriod))
    .map((period) => period.cusip);
  const [{ positions, total, matching, largest }, filings] = await Promise.all([
    getPositions(investor.id, selected.reportPeriod, selected.valueUsd, (pageNumber - 1) * limit, limit, { search: query, sort: sort.value, cusips }),
    getQuarterFilings(investor, selected.reportPeriod),
  ]);
  if (positions.length === 0 && pageNumber > 1) notFound();
  // Positions in a stock we can identify link to its stock page, under the stock's readable name.
  const stocks = await getStockLinks(
    [...positions, ...(largest ? [largest] : [])].flatMap((position) => (position.cusip ? [position.cusip] : [])),
    selected.reportPeriod,
  );
  const largestName = largest ? (largest.cusip && stocks[largest.cusip]?.name) || largest.issuer : null;
  const original = filings.find((filing) => filing.amendmentType === "none");
  const amendments = filings.filter((filing) => filing.amendmentType !== "none");
  const label = quarterLabel(selected.reportPeriod);
  const isLatest = selected === latest;

  // Links within the dashboard keep the selected quarter.
  const pagePath = `/investors/${investor.slug}`;
  const dashboardHref = (view: { all?: boolean; page?: number; clear?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (!isLatest) search.set("quarter", selected.reportPeriod);
    if (view.all) search.set("holdings", "all");
    if (query && !view.clear) search.set("q", query);
    if (sort !== POSITION_SORTS[0] && !view.clear) search.set("sort", sort.value);
    if (view.page && view.page > 1) search.set("page", String(view.page));
    return search.size > 0 ? `${pagePath}?${search}` : pagePath;
  };
  const pageCount = Math.ceil(matching / ALL_HOLDINGS_PAGE);
  const tableLinks: TableLink[] = [];
  if (showAll && pageNumber > 1) {
    tableLinks.push({ href: `${dashboardHref({ all: true, page: pageNumber - 1 })}#holdings`, label: "← Previous" });
  }
  if (showAll && pageNumber < pageCount) {
    tableLinks.push({ href: `${dashboardHref({ all: true, page: pageNumber + 1 })}#holdings`, label: "Next →" });
  }
  if (total > TOP_HOLDINGS && !filtered) {
    tableLinks.push(showAll
      ? { href: dashboardHref(), label: `Show the top ${TOP_HOLDINGS}`, keepScroll: true }
      : { href: dashboardHref({ all: true }), label: `Show all ${formatNumber(total)} positions`, keepScroll: true });
  }
  const firstRank = showAll ? (pageNumber - 1) * ALL_HOLDINGS_PAGE + 1 : 1;
  const tableStatus = matching === 0 ? (query ? "No matching holdings" : "No holdings reported")
    : `${formatNumber(firstRank)}–${formatNumber(firstRank + positions.length - 1)} of ${formatNumber(matching)} ${query ? "matching " : ""}${matching === 1 ? "holding" : "holdings"}`;
  const keep: Record<string, string> = {};
  if (showAll) keep.holdings = "all";
  if (query) keep.q = query;
  if (sort !== POSITION_SORTS[0]) keep.sort = sort.value;

  const ticks = axisTicks(Math.max(...quarters.map((quarter) => quarter.valueUsd)));
  const scaleMax = ticks.at(-1) ?? 1;
  const chartQuarters = quarters.map((quarter) => ({
    reportPeriod: quarter.reportPeriod,
    label: quarterLabel(quarter.reportPeriod),
    ...quarterParts(quarter.reportPeriod),
    valueLabel: formatUsdCompact(quarter.valueUsd),
    height: (quarter.valueUsd / scaleMax) * 100,
    description: `${quarterLabel(quarter.reportPeriod)}: ${formatUsdCompact(quarter.valueUsd)} reported${quarter.amended ? ", amended" : ""}`,
    details: [`${quarterLabel(quarter.reportPeriod)} reported value`, ...(quarter.amended ? ["Includes amended filings"] : [])],
  }));
  const chartTicks = ticks.map((tick) => ({ label: formatUsdAxis(tick), position: (tick / scaleMax) * 100 }));

  return (
    <QuarterNavigation keep={keep}>
      <main className={styles.page}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href="/investors">Investors</Link>
          <span aria-hidden="true">/</span>
          <span>{investor.name}</span>
        </nav>

        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>{investor.name}</h1>
            <p className={styles.meta}>
              <span>Holdings reported to the SEC on Form 13F</span>
            </p>
            <details className={styles.disclosure}>
              <summary>Investor &amp; filing details</summary>
              <div className={styles.meta}>
                {investor.filedName !== investor.name && <span>Files as {investor.filedName}</span>}
                <span>CIK {investor.cik}</span>
                <a href={`https://www.sec.gov/edgar/browse/?CIK=${Number(investor.cik)}`}>SEC EDGAR filings ↗</a>
              </div>
            </details>
          </div>
          <QuarterSelect
            selected={selected.reportPeriod}
            quarters={quarters.toReversed().map((quarter) => ({
              value: quarter.reportPeriod,
              label: `${quarterLabel(quarter.reportPeriod)}${quarter === latest ? " (latest)" : ""}`,
            }))}
          />
        </header>

        <PendingFrame>
          {!isLatest && (
            <p className={styles.notice}>
              <span>
                Showing {label}. The latest reported quarter is {quarterLabel(latest.reportPeriod)}.
              </span>
              <Link href={pagePath} scroll={false}>
                View the latest quarter
              </Link>
            </p>
          )}

          <section className={styles.summary} aria-label={`Summary for ${label}`}>
            <div className={styles.hero}>
              <p className={styles.label}>
                Reported portfolio value
                <span className={styles.badge}>{isLatest ? `${label} · Latest` : label}</span>
              </p>
              <p className={styles.heroValue}>{formatUsdCompact(selected.valueUsd)}</p>
              <p className={styles.note}>
                {formatUsd(selected.valueUsd)} · Quarter-end market value in USD
              </p>
              <p className={styles.note}>A historical disclosure, not an investment return.</p>
            </div>
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <p className={styles.label}>Quarter end</p>
                <p className={styles.tileValue}>{formatDate(selected.reportPeriod)}</p>
                <p className={styles.note}>{label} reporting period</p>
              </div>
              <div className={styles.tile}>
                <p className={styles.label}>Filed with the SEC</p>
                <p className={styles.tileValue}>{original ? formatFilingDate(original.filedAt) : "Not available"}</p>
                <p className={styles.note}>
                  {amendments.length === 0
                    ? "Form 13F-HR, not amended"
                    : `${amendments.length === 1 ? "1 amendment" : `${amendments.length} amendments`}, latest ${formatFilingDate(amendments[amendments.length - 1].filedAt)}`}
                </p>
              </div>
              <div className={styles.tile}>
                <p className={styles.label}>Positions</p>
                <p className={styles.tileValue}>{formatNumber(total)} securities</p>
                <p className={styles.note}>Combined from {formatNumber(selected.holdingRowCount)} filing rows</p>
              </div>
              <div className={styles.tile}>
                <p className={styles.label}>Largest position</p>
                <p className={styles.tileValue}>{largestName ?? "None reported"}</p>
                <p className={styles.note}>
                  {largest ? `${formatPercent(largest.portfolioShare)} of reported value` : "No holdings in this report"}
                </p>
              </div>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="value-history">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="value-history" className={styles.cardTitle}>
                  Reported portfolio value by quarter
                </h2>
                <p className={styles.cardSubtitle}>
                  {quarters.length > 1
                    ? `${chartQuarters[0].label}–${chartQuarters[chartQuarters.length - 1].label} · Select a bar to view that quarter.`
                    : `Only one quarter, ${label}, has been imported for this investor so far. The chart appears once there are two quarters to compare.`}
                </p>
              </div>
            </div>
            {quarters.length > 1 && (
              <>
                <ValueChart quarters={chartQuarters} ticks={chartTicks} selected={selected.reportPeriod} />
                <details className={styles.tableView}>
                  <summary>Show values as a table</summary>
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Quarter</th>
                          <th scope="col" className={styles.optional}>Quarter end</th>
                          <th scope="col" className={styles.numeric}>Reported value</th>
                          <th scope="col" className={`${styles.numeric} ${styles.optional}`}>Filing rows</th>
                          <th scope="col">Amended</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quarters.toReversed().map((quarter) => (
                          <tr key={quarter.reportPeriod}>
                            <th scope="row">{quarterLabel(quarter.reportPeriod)}</th>
                            <td className={styles.optional}>{formatDate(quarter.reportPeriod)}</td>
                            <td className={styles.numeric}>{formatUsd(quarter.valueUsd)}</td>
                            <td className={`${styles.numeric} ${styles.optional}`}>{formatNumber(quarter.holdingRowCount)}</td>
                            <td>{quarter.amended ? "Yes" : "No"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </section>

          <section className={styles.card} aria-labelledby="holdings">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="holdings" className={styles.cardTitle}>
                  {showAll ? "Portfolio holdings" : "Largest holdings"}, {label}
                </h2>
                <p className={styles.cardSubtitle}>
                  {sort.label}. Portfolio percentages always use the full quarter&apos;s reported value.
                </p>
              </div>
              <p className={styles.cardMeta}>
                {formatNumber(total)} securities · {formatUsdCompact(selected.valueUsd)}
              </p>
            </div>
            <form key={`${selected.reportPeriod}:${query}:${sort.value}`} className={styles.tableControls} action={`${pagePath}#holdings`} role="search" aria-label="Search portfolio holdings">
              <input type="hidden" name="quarter" value={selected.reportPeriod} />
              <input type="hidden" name="holdings" value="all" />
              <label className={styles.searchField}>
                Search holdings
                <input name="q" type="search" defaultValue={query} maxLength={100} placeholder="Company, ticker or CUSIP" className={styles.searchInput} />
              </label>
              <label className={styles.quarterSelect}>
                Sort by
                <span className={styles.selectWrap}>
                  <select name="sort" defaultValue={sort.value}>
                    {POSITION_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </span>
              </label>
              <button type="submit" className={styles.button}>Apply</button>
              {filtered && <Link href={`${dashboardHref({ all: true, clear: true })}#holdings`} className={styles.tableToggle} scroll={false}>Clear filters</Link>}
            </form>
            <details className={styles.disclosure}>
              <summary>How these holdings are shown</summary>
              <p className={styles.cardSubtitle}>
                Filers can report one position in several rows, for example one per subsidiary or adviser; rows for the
                same security are combined here. Share classes stay separate. Search matches names as filed, CUSIPs and
                exact verified tickers. It searches the whole quarter, including holdings beyond this page.
              </p>
            </details>
            {positions.length === 0 && (
              <p className={styles.emptyState}>
                {query ? <>No holdings match &ldquo;{query}&rdquo; in {label}. Try a company name, exact ticker or CUSIP.</> : "No holdings were reported for this quarter."}
              </p>
            )}
            <HoldingsTable
              positions={positions}
              firstRank={firstRank}
              largestShare={largest?.portfolioShare ?? 0}
              caption={`Holdings, ${label}, combined by security. ${sort.label}`}
              links={tableLinks}
              status={tableStatus}
              pageLabel={showAll && pageCount > 1 ? `Page ${formatNumber(pageNumber)} of ${formatNumber(pageCount)}` : undefined}
              stocks={stocks}
            />
          </section>

          <details className={`${styles.card} ${styles.sourceDetails}`}>
            <summary>SEC sources &amp; methodology</summary>
            <div className={styles.split}>
              <div>
                <h2 className={styles.cardTitle}>SEC filings for {label}</h2>
                <ul className={styles.filings}>
                  {filings.map((filing) => (
                    <li key={filing.accessionNumber}>
                      <span className={styles.filingRole}>
                        {filingRole(filing)}
                        <span className={styles.badge} data-tone={filing.counted ? undefined : "muted"}>
                          {filing.counted ? "Counted" : "Replaced by restatement"}
                        </span>
                      </span>
                      <span className={styles.filingMeta}>
                        {filing.formType} · filed {formatFilingDate(filing.filedAt)} ·{" "}
                        <a href={filing.secUrl}>{filing.accessionNumber} ↗</a>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h2 className={styles.cardTitle}>About these numbers</h2>
                <ul className={styles.notes}>
                  <li>
                    Reported value is the market value, at quarter-end prices, of the securities {investor.name} listed
                    on Form 13F. It leaves out short positions, cash, private holdings and anything else outside the
                    SEC&apos;s 13F list.
                  </li>
                  <li>
                    These are historical disclosures, not investment performance. A change between quarters mixes
                    buying and selling with price moves.
                  </li>
                  <li>
                    Amendments are applied as filed: a restatement replaces the original report, and a new-holdings
                    amendment adds positions, such as ones first kept confidential.
                  </li>
                  {filings.some((filing) => filing.filedAt < "2023-01-03") && (
                    <li>Filings made before 2023 reported values in thousands of dollars; they are shown in dollars here.</li>
                  )}
                  {selected.confidentialOmissions && (
                    <li>
                      A filing for this quarter says some holdings were omitted under an SEC confidential treatment
                      request. Positions disclosed later by amendment are included above.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </details>
        </PendingFrame>
      </main>
    </QuarterNavigation>
  );
}
