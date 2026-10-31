import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Fragment } from "react";
import styles from "@/components/dashboard/dashboard.module.css";
import { LinkSelect, PendingFrame, QuarterNavigation, QuarterSelect } from "@/components/dashboard/quarter-navigation";
import { ValueChart, type ChartQuarter } from "@/components/dashboard/value-chart";
import {
  axisTicks, formatDate, formatNumber, formatNumberAxis, formatNumberCompact, formatPercent, formatUsd, formatUsdCompact, quarterLabel,
  quarterParts,
} from "@/lib/portfolio";
import {
  EXCHANGE_NAMES, exactShareRatio, holdingSeries, identifiesStock, lastQuarterBefore, previousQuarter, quarterChange, receivedInQuarter, uncertainZero,
  type Change, type QuarterHolding, type Received, type Unconfirmed,
} from "@/lib/stock";
import { getStock, getStockOwnership, type StockPosition } from "@/lib/stock-data";
import { describeChange, receivedNote, splitLabel } from "@/lib/change-description";
import { STOCK_FILTERS, matchesStockFilter, stockOverview, type StockFilter } from "@/lib/stock-overview";
import { ResearchReturn } from "@/components/research-return";
import { detailReturnTarget, researchHref, returnTarget } from "@/lib/research";

type StockPageProps = {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: StockPageProps): Promise<Metadata> {
  const stock = await getStock((await params).ticker.toUpperCase());
  if (!stock) return { title: "Stock not found" };
  return {
    title: `${stock.name} (${stock.ticker}) institutional holdings`,
    description: `Tracked institutional investors' reported 13F holdings of ${stock.name} (${stock.ticker}), by quarter.`,
  };
}

const OPTION_LABELS: Record<string, string> = { put: "put options", call: "call options" };

// The direction of a change, beside its label.
const CHANGE_MARKERS: Partial<Record<Change["kind"], string>> = { increased: "▲", opened: "▲", decreased: "▼", closed: "▼" };

function stateLabel(holding: QuarterHolding): string {
  if (holding.state === "held") return `${formatNumber(holding.shares)} shares`;
  if (uncertainZero(holding)) return "Uncertain";
  if (holding.state === "not-held") return "Reported, not held";
  if (holding.state === "unclear") return "Unclear";
  return "No report";
}

// Why a quarter is unclear: "Reported 107.12M shares under CUSIP G6683N103, which is not confirmed as NU
// for this quarter".
function unclearNote(unconfirmed: Unconfirmed, ticker: string): string {
  return `Reported ${formatNumberCompact(unconfirmed.shares)} shares under CUSIP ${unconfirmed.cusip}, which is not confirmed as ${ticker} for this quarter`;
}

// Options on the stock are reported separately from shares: "Also reported call options on 1.20M shares".
function optionsNote(options: StockPosition[]): string | null {
  if (options.length === 0) return null;
  return `Also reported ${options.map((option) => `${OPTION_LABELS[option.positionType]} on ${formatNumberCompact(option.shares)} shares (${formatUsdCompact(option.valueUsd)})`).join(", ")}`;
}

// One page for every stock with a ticker, at /stocks/[ticker].
export default async function StockPage({ params, searchParams }: StockPageProps) {
  const [{ ticker: requestedTicker }, { quarter: requestedQuarter, investor: requestedInvestor, filter: requestedFilter, from, back }] = await Promise.all([params, searchParams]);
  const returnTo = returnTarget(from)?.href;
  const previousView = detailReturnTarget(back)?.href;
  const ticker = requestedTicker.toUpperCase();
  if (ticker !== requestedTicker) {
    const query = new URLSearchParams();
    if (typeof requestedQuarter === "string") query.set("quarter", requestedQuarter);
    if (typeof requestedInvestor === "string") query.set("investor", requestedInvestor);
    if (typeof requestedFilter === "string") query.set("filter", requestedFilter);
    if (returnTo) query.set("from", returnTo);
    if (previousView) query.set("back", previousView);
    redirect(`/stocks/${encodeURIComponent(ticker)}${query.size ? `?${query}` : ""}`);
  }
  const stock = await getStock(ticker);
  if (!stock) notFound();
  const { investors, reports, positions, unconfirmed, conversions, convertedFrom } = await getStockOwnership(stock);

  // Every quarter any tracked investor reported, oldest first.
  const quarters = [...new Set(reports.map((report) => report.reportPeriod))].sort();
  const latest = quarters.at(-1);
  const selected = requestedQuarter === undefined ? latest : quarters.find((quarter) => quarter === requestedQuarter);
  if (!latest || !selected) notFound();
  const index = quarters.indexOf(selected);
  const label = quarterLabel(selected);
  const isLatest = selected === latest;
  const filter = STOCK_FILTERS.find((option) => option.value === requestedFilter)?.value ?? "all";

  // Each investor's holding in every quarter: shares held long, separate from options.
  const series = new Map(investors.map((investor) => {
    const longShares = (position: StockPosition) =>
      position.investorId === investor.id && position.positionType === "long" && position.quantityType === "SH";
    const shares = new Map<string, { shares: number; valueUsd: number }>();
    for (const position of positions.filter(longShares)) {
      const total = shares.get(position.reportPeriod) ?? { shares: 0, valueUsd: 0 };
      shares.set(position.reportPeriod, { shares: total.shares + position.shares, valueUsd: total.valueUsd + position.valueUsd });
    }
    const unclear = new Map<string, Unconfirmed>();
    for (const position of unconfirmed.filter(longShares)) {
      const total = unclear.get(position.reportPeriod)?.shares ?? 0;
      unclear.set(position.reportPeriod, { cusip: position.cusip, shares: total + position.shares });
    }
    // Shares received in corporate actions, from the investor's holdings of the converted securities.
    const received = new Map<string, Received>();
    for (const quarter of quarters) {
      const heldBefore = new Map<string, number>();
      for (const position of convertedFrom.filter(longShares).filter((row) => row.reportPeriod === previousQuarter(quarter))) {
        heldBefore.set(position.cusip, (heldBefore.get(position.cusip) ?? 0) + position.shares);
      }
      // The stock's own CUSIPs in the quarter before: converting those is a split.
      const ownCusips = stock.cusips.filter((period) => identifiesStock(stock.cusips, period.cusip, previousQuarter(quarter))).map((period) => period.cusip);
      const receivedThen = receivedInQuarter(conversions, heldBefore, quarter, ownCusips);
      if (receivedThen) received.set(quarter, receivedThen);
    }
    const reported = new Map(reports.filter((report) => report.investorId === investor.id).map((report) => [report.reportPeriod, report]));
    return [investor.id, holdingSeries(quarters, reported, shares, unclear, received)];
  }));

  // An investor's change in the quarter at this position, with other investors' exact share ratios for
  // the same quarter, which confirm a reverse split.
  const changeAt = (investorId: string, position: number) => {
    const holdings = series.get(investorId) ?? [];
    const confirmingRatios = investors.filter((other) => other.id !== investorId).flatMap((other) => {
      const theirs = series.get(other.id) ?? [];
      const ratio = position > 0 ? exactShareRatio(theirs[position - 1], theirs[position]) : null;
      return ratio === null ? [] : [ratio];
    });
    return quarterChange(holdings[position], holdings[position - 1], confirmingRatios);
  };

  const rows = investors.map((investor) => {
    const holdings = series.get(investor.id) ?? [];
    const current = holdings[index];
    const portfolio = reports.find((report) => report.investorId === investor.id && report.reportPeriod === selected);
    return {
      investor,
      current,
      previous: holdings[index - 1],
      change: changeAt(investor.id, index),
      portfolioShare: portfolio && portfolio.valueUsd > 0 ? current.valueUsd / portfolio.valueUsd : 0,
      options: positions.filter((position) => position.investorId === investor.id && position.reportPeriod === selected && position.positionType !== "long"),
    };
  });
  const counts = stockOverview(rows);
  const comparable = rows.filter((row) => row.change.kind !== "not-comparable").length;
  const comparisonFilters: StockFilter[] = ["increased", "decreased", "opened", "closed", "unchanged", "corporate-action"];
  const countLabel = (selection: StockFilter) => comparable === 0 && comparisonFilters.includes(selection) ? "—" : formatNumber(counts[selection]);
  const visible = rows.filter((row) => matchesStockFilter(row, filter));
  const holders = rows.filter((row) => row.current.state === "held").sort((a, b) => b.current.valueUsd - a.current.valueUsd);
  const visibleHolders = visible.filter((row) => row.current.state === "held").sort((a, b) => b.current.valueUsd - a.current.valueUsd);
  // Investors that held none in either quarter are listed by name in one line; those that closed a
  // position, or whose zero is uncertain, keep a row.
  const notHeldEither = filter === "all" ? visible.filter((row) => row.change.kind === "not-held" && !uncertainZero(row.current) && row.options.length === 0) : [];
  const notHeld = visible.filter((row) => row.current.state === "not-held" && !uncertainZero(row.current) && !notHeldEither.includes(row));
  const unclear = visible.filter((row) => row.current.state === "unclear" || uncertainZero(row.current));
  const noReport = visible.filter((row) => row.current.state === "no-report");
  const previousReports = reports.filter((report) => report.reportPeriod === previousQuarter(selected)).length;

  // The investor shown in the chart: chosen in the URL, otherwise the holder with the most reported quarters
  // (the larger holder on a tie), so the chart shows the longest history.
  const charted = investors.filter((investor) => series.get(investor.id)?.some((holding) => holding.state === "held"));
  const reportedQuarters = (investorId: string) => series.get(investorId)?.filter((holding) => holding.state !== "no-report").length ?? 0;
  const candidates = holders.length > 0 ? holders.map((row) => row.investor) : charted;
  const longestHistory = [...candidates].sort((a, b) => reportedQuarters(b.id) - reportedQuarters(a.id))[0];
  const chartInvestor = charted.find((investor) => investor.slug === requestedInvestor) ?? longestHistory;
  const chartSeries = chartInvestor ? series.get(chartInvestor.id) ?? [] : [];
  const ticks = axisTicks(Math.max(0, ...chartSeries.map((holding) => holding.shares)));
  const scaleMax = ticks.at(-1) || 1;
  const chartQuarters: ChartQuarter[] = chartSeries.map((holding, position) => {
    const quarter = quarterLabel(holding.reportPeriod);
    const held = holding.state === "held";
    const reportedZero = holding.state === "not-held" && !uncertainZero(holding);
    const { splitRatio } = chartInvestor ? changeAt(chartInvestor.id, position) : quarterChange(holding, chartSeries[position - 1]);
    const descriptions: Record<QuarterHolding["state"], string> = {
      held: `${formatNumber(holding.shares)} shares reported`,
      "not-held": uncertainZero(holding) ? "holding uncertain due to confidential omissions" : "reported, not held",
      unclear: "holding unclear",
      "no-report": "no report in our data",
    };
    return {
      reportPeriod: holding.reportPeriod,
      label: quarter,
      ...quarterParts(holding.reportPeriod),
      valueLabel: held ? `${formatNumberCompact(holding.shares)} shares` : reportedZero ? "0 shares" : stateLabel(holding),
      // A missing report or an unclear holding is drawn as a full-height hatched column; its label sits above it.
      height: held ? (holding.shares / scaleMax) * 100 : reportedZero ? 0 : 100,
      description: `${quarter}: ${descriptions[holding.state]}`,
      details: held
        ? [
          `${quarter} reported shares`,
          `${formatUsdCompact(holding.valueUsd)} reported value`,
          ...(splitRatio !== null ? [`Likely ${splitLabel(splitRatio)} stock split`] : []),
          ...(holding.received ? [`${holding.received.ownShares > 0 ? "Stock split" : "Received in corporate action"}: ${receivedNote(holding.received)}`] : []),
        ]
        : reportedZero
          ? [`${quarter}: reported, not held`]
          : uncertainZero(holding)
            ? [`${quarter}: holding uncertain`, "This filing omitted confidential holdings; an absent position is not a confirmed zero"]
          : holding.unconfirmed
            ? [`${quarter}: holding unclear`, unclearNote(holding.unconfirmed, stock.ticker)]
            : [`${quarter}: no 13F report in our data`],
      state: reportedZero ? "zero" : held ? undefined : "missing",
    };
  });
  const chartTicks = ticks.map((tick) => ({ label: formatNumberAxis(tick), position: (tick / scaleMax) * 100 }));

  const filterQuery: Record<string, string> = filter === "all" ? {} : { filter };
  if (returnTo) filterQuery.from = returnTo;
  if (previousView) filterQuery.back = previousView;
  const pageHref = (query: Record<string, string>) => `/stocks/${encodeURIComponent(stock.ticker)}?${new URLSearchParams({ quarter: latest, ...filterQuery, ...query })}`;
  const quarterQuery: Record<string, string> = { quarter: selected };
  const filterHref = (selection: StockFilter) => `/stocks/${encodeURIComponent(stock.ticker)}?${new URLSearchParams({
    ...quarterQuery, ...(returnTo ? { from: returnTo } : {}), ...(previousView ? { back: previousView } : {}), ...(chartInvestor ? { investor: chartInvestor.slug } : {}), ...(selection === "all" ? {} : { filter: selection }),
  })}#holders`;
  const filterLabel = STOCK_FILTERS.find((option) => option.value === filter)!.label;
  const stockView = detailReturnTarget(filterHref(filter))?.href;
  const investorHref = (slug: string) => researchHref(`/investors/${slug}`, { quarter: selected, from: returnTo, back: stockView });
  const currentCusips = stock.cusips.filter((period) => period.validTo === null).map((period) => period.cusip);
  // Earlier CUSIPs, such as one replaced in a corporate action, or one that filers mistyped: "531229748, Q3 2023–Q3 2025".
  const otherCusips = stock.cusips.flatMap((period) => period.validTo === null ? [] : [
    `${period.cusip}, ${quarterLabel(period.validFrom)}–${quarterLabel(lastQuarterBefore(period.validTo))}`,
  ]);
  const kind = stock.shareClass ?? stock.securityType.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());

  const holderRow = (row: (typeof rows)[number]) => {
    const change = describeChange(row.change);
    const confidentialComparison = uncertainZero(row.current) || (row.previous && uncertainZero(row.previous));
    const note = row.current.unconfirmed
      ? unclearNote(row.current.unconfirmed, stock.ticker)
      : row.current.state === "not-held" && row.current.confidentialOmissions
        ? "This report omitted some holdings under confidential treatment, so the zero is not certain"
        : confidentialComparison
          ? "The previous filing omitted confidential holdings, so a new position cannot be established from its apparent zero"
          : optionsNote(row.options);
    return (
      <tr key={row.investor.id} data-investor={row.investor.slug} data-change-kind={row.change.kind}>
        <th scope="row" className={`${styles.security} ${styles.wrapping}`}>
          <Link href={investorHref(row.investor.slug)} className={styles.issuer}>
            {row.investor.name}
          </Link>
          {note && (
            <details className={styles.rowDetails}>
              <summary>{row.current.unconfirmed ? "Unclear holding" : confidentialComparison ? "Confidential filing note" : "Options reported"}</summary>
              <p>{note}</p>
            </details>
          )}
        </th>
        <td className={styles.numeric} data-label="Reported shares">
          {row.current.state === "held" ? formatNumber(row.current.shares) : uncertainZero(row.current) ? "Uncertain" : row.current.state === "not-held" ? "0" : "—"}
        </td>
        <td className={styles.numeric} data-label="Reported value" title={row.current.state === "held" ? formatUsd(row.current.valueUsd) : undefined}>
          {row.current.state === "held" ? formatUsdCompact(row.current.valueUsd) : "—"}
        </td>
        <td className={`${styles.numeric} ${styles.optional}`} data-label="Share of portfolio">
          {row.current.state === "held" ? formatPercent(row.portfolioShare) : "—"}
        </td>
        <td className={`${styles.security} ${styles.wrapping} ${styles.changeCell}`} data-label={`Change from ${quarterLabel(previousQuarter(selected))}`}>
          {row.current.state === "no-report" || row.current.state === "unclear" ? (
            <span className={styles.secondary}>
              {row.current.state === "unclear" ? "Not comparable: holding unclear" : `No ${label} report in our data`}
            </span>
          ) : (
            <>
              <span>
                {CHANGE_MARKERS[row.change.kind] && (
                  <span className={styles.changeMarker} aria-hidden="true">{CHANGE_MARKERS[row.change.kind]}</span>
                )}
                {change.label}
              </span>
              {change.detail && <span className={styles.securityClass}>{change.detail}</span>}
            </>
          )}
        </td>
      </tr>
    );
  };

  return (
    <QuarterNavigation keep={{ ...filterQuery, ...(chartInvestor ? { investor: chartInvestor.slug } : {}) }}>
      <main className={styles.page}>
        <ResearchReturn from={returnTo} back={previousView} />
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={researchHref("/stocks", { quarter: selected })}>Stocks</Link>
          <span aria-hidden="true">/</span>
          <span>{stock.name}</span>
        </nav>

        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>
              {stock.name} <span className={styles.secondary}>{stock.ticker}</span>
            </h1>
            <p className={styles.meta}>
              {stock.companyName && <span>{stock.companyName}</span>}
              <span>{stock.ticker} · {EXCHANGE_NAMES[stock.exchange] ?? stock.exchange}</span>
              <span>{kind}</span>
            </p>
            <details className={styles.disclosure}>
              <summary>Security identifiers</summary>
              <div className={styles.meta}>
                {currentCusips.length > 0 && <span>CUSIP {currentCusips.join(", ")}</span>}
                {otherCusips.length > 0 && <span>Also matched under CUSIP {otherCusips.join("; ")}</span>}
              </div>
            </details>
          </div>
          <QuarterSelect
            selected={selected}
            quarters={quarters.toReversed().map((quarter) => ({
              value: quarter,
              label: `${quarterLabel(quarter)}${quarter === latest ? " (latest)" : ""}`,
            }))}
          />
        </header>

        <PendingFrame>
          {!isLatest && (
            <p className={styles.notice}>
              <span>
                Showing {label}. The latest reported quarter is {quarterLabel(latest)}.
              </span>
              <Link href={pageHref(chartInvestor ? { investor: chartInvestor.slug } : {})} scroll={false}>
                View the latest quarter
              </Link>
            </p>
          )}

          <section className={styles.card} aria-labelledby="holders">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="holders" className={styles.cardTitle}>
                  Investor positioning, {label}
                </h2>
                <p className={styles.cardSubtitle}>
                  Quarter-end holdings at {formatDate(selected)}; changes from {quarterLabel(previousQuarter(selected))}.
                  Only the investors tracked here are included, not total institutional ownership.
                </p>
                <p className={styles.cardSubtitle}>
                  Share changes can be compared for {comparable} of {rows.length} tracked investors.
                </p>
              </div>
            </div>
            <nav className={`${styles.changeSummary} ${styles.stockSummary}`} aria-label="Stock positioning summary">
              {STOCK_FILTERS.filter((option) => option.primary).map((option) => (
                <Link key={option.value} href={filterHref(option.value)} scroll={false} className={styles.changeTile} aria-current={filter === option.value ? "true" : undefined}>
                  <span>{option.label}</span>
                  <strong>{countLabel(option.value)}</strong>
                </Link>
              ))}
            </nav>
            <nav className={styles.changeFilters} aria-label="Investor group filters">
              {STOCK_FILTERS.filter((option) => !option.primary).map((option) => (
                <Link key={option.value} href={filterHref(option.value)} scroll={false} className={styles.pageLink} aria-current={filter === option.value ? "true" : undefined}>
                  {option.label} <span>{countLabel(option.value)}</span>
                </Link>
              ))}
            </nav>
            <ul className={styles.holderCounts} aria-label="Investor reporting coverage">
              <li><strong>{rows.length - counts["no-report"]}/{rows.length}</strong> reported for {label}</li>
              <li><strong>{previousReports}/{rows.length}</strong> reported for {quarterLabel(previousQuarter(selected))}</li>
            </ul>
            <p className={styles.note}>
              Reported share changes are not proof of trades. Corporate actions and uncertain comparisons have their own groups.
            </p>
            <p className={styles.cardMeta} role="status">{filterLabel} · {visible.length} of {rows.length} tracked investors</p>
            {visible.length === 0 ? (
              <p className={styles.emptyState}>
                {comparable === 0 && comparisonFilters.includes(filter)
                  ? `No reliable share-count comparisons are available for ${label}. Check the reporting gaps and unclear holdings above.`
                  : <>No tracked investors match &ldquo;{filterLabel}&rdquo; for {label}.</>}
              </p>
            ) : (
              <div className={styles.tableScroll}>
                <table className={`${styles.table} ${styles.holderTable}`} role="table">
                  <caption className={styles.visuallyHidden}>
                    {filterLabel}: tracked investors&apos; reported {stock.ticker} holdings, {label}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Investor</th>
                      <th scope="col" className={styles.numeric}>Reported shares</th>
                      <th scope="col" className={styles.numeric}>Reported value</th>
                      <th scope="col" className={`${styles.numeric} ${styles.optional}`}>Share of portfolio</th>
                      <th scope="col">Change from {quarterLabel(previousQuarter(selected))}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHolders.map(holderRow)}
                    {notHeld.length + notHeldEither.length > 0 && (
                      <tr className={styles.groupRow}>
                        <th scope="colgroup" colSpan={5}>Reported for {label}, without {stock.ticker}</th>
                      </tr>
                    )}
                    {notHeld.map(holderRow)}
                    {notHeldEither.length > 0 && (
                      <tr className={styles.namesRow}>
                        <td colSpan={5}>
                          <span className={styles.namesLabel}>
                            Held none in {label} or {quarterLabel(previousQuarter(selected))} ({notHeldEither.length}):
                          </span>{" "}
                          {notHeldEither.map((row, i) => (
                            <Fragment key={row.investor.id}>
                              {i > 0 && ", "}
                              <Link href={investorHref(row.investor.slug)}>{row.investor.name}</Link>
                            </Fragment>
                          ))}
                        </td>
                      </tr>
                    )}
                    {unclear.length > 0 && (
                      <tr className={styles.groupRow}>
                        <th scope="colgroup" colSpan={5}>Reported for {label}, holding unclear or confidential</th>
                      </tr>
                    )}
                    {unclear.map(holderRow)}
                    {filter !== "all" && noReport.map(holderRow)}
                    {filter === "all" && noReport.length > 0 && (
                      <tr className={styles.namesRow}>
                        <td colSpan={5}>
                          <span className={styles.namesLabel}>No {label} report in our data, so holding unknown ({noReport.length}):</span>{" "}
                          {noReport.map((row, i) => (
                            <Fragment key={row.investor.id}>
                              {i > 0 && ", "}
                              <Link href={investorHref(row.investor.slug)}>{row.investor.name}</Link>
                            </Fragment>
                          ))}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <details className={styles.disclosure}>
              <summary>How the overview counts work</summary>
              <p className={styles.cardSubtitle}>
                Holding counts confirmed long share positions in this quarter. Changes require comparable reports for
                both quarters. Splits and shares received in corporate actions are counted separately; options are
                shown in notes and do not count as shares held. Unclear includes uncertain identifiers and confidential
                omissions. No comparison means the previous report is missing; No report means this quarter is missing.
                Groups can overlap: an investor can be holding shares while its change is unknown.
                A dash in an activity count means no reliable comparisons are available.
              </p>
            </details>
          </section>

          <section className={styles.card} aria-labelledby="share-history">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="share-history" className={styles.cardTitle}>
                  Reported {stock.ticker} shares by quarter{chartInvestor ? `, ${chartInvestor.name}` : ""}
                </h2>
                <p className={styles.cardSubtitle}>
                  Quarter-end shares as reported, without adjusting for stock splits. Select a bar to view that quarter.
                </p>
              </div>
              {charted.length > 0 && chartInvestor && (
                <LinkSelect
                  label="Investor"
                  selected={chartInvestor.slug}
                  options={charted.map((investor) => ({
                    value: investor.slug,
                    label: investor.name,
                    href: pageHref({ ...quarterQuery, investor: investor.slug }),
                  }))}
                />
              )}
            </div>
            {chartInvestor ? (
              <>
                <ValueChart quarters={chartQuarters} ticks={chartTicks} selected={selected} />
                <ul className={styles.legend} aria-label="Chart legend">
                  <li><span className={styles.swatch} aria-hidden="true" />Reported shares</li>
                  <li><span className={styles.swatch} data-state="zero" aria-hidden="true" />Reported, not held</li>
                  <li><span className={styles.swatch} data-state="missing" aria-hidden="true" />No report in our data, or unclear</li>
                </ul>
                <details className={styles.tableView}>
                  <summary>Show values as a table</summary>
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Quarter</th>
                          <th scope="col" className={styles.numeric}>Reported shares</th>
                          <th scope="col" className={styles.numeric}>Reported value</th>
                          <th scope="col">Change from the previous quarter</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chartSeries.map((holding, position) => ({ holding, change: changeAt(chartInvestor.id, position) }))
                          .toReversed()
                          .map(({ holding, change }) => {
                            const described = describeChange(change);
                            return (
                              <tr key={holding.reportPeriod}>
                                <th scope="row">{quarterLabel(holding.reportPeriod)}</th>
                                <td className={styles.numeric}>{stateLabel(holding)}</td>
                                <td className={styles.numeric}>{holding.state === "held" ? formatUsd(holding.valueUsd) : "—"}</td>
                                <td>
                                  {holding.state === "no-report" ? "—" : described.label}
                                  {holding.state !== "no-report" && described.detail ? `: ${described.detail}` : ""}
                                  {holding.unconfirmed ? `. ${unclearNote(holding.unconfirmed, stock.ticker)}` : ""}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <p className={styles.cardSubtitle}>No tracked investor has reported {stock.ticker} shares.</p>
            )}
          </section>

          <details className={`${styles.card} ${styles.sourceDetails}`}>
            <summary id="about-stock">About these numbers &amp; methodology</summary>
            <div>
              <ul className={styles.notes}>
                <li>
                  Shares and values are as reported on Form 13F at each quarter end. Reported value is the market value
                  at quarter-end prices, not an investment return.
                </li>
                <li>
                  &ldquo;Reported, not held&rdquo; means the investor filed a 13F for the quarter that does not list{" "}
                  {stock.ticker}: a reported zero. &ldquo;No report&rdquo; means there is no 13F from the investor for that
                  quarter in our data, so its holding is unknown.
                </li>
                <li>
                  &ldquo;Unclear&rdquo; means the investor reported shares under one of {stock.ticker}&apos;s CUSIPs in a
                  quarter that CUSIP is not yet confirmed for, so neither a holding nor a zero is shown.
                </li>
                <li>
                  Changes compare share counts with the previous quarter, only when the investor reported both. A change
                  in shares is a reported change, not proof of a trade.
                </li>
                <li>
                  &ldquo;Received in corporate action&rdquo; marks shares received when other shares the investor held were
                  converted or reclassified, such as in a merger, at the official ratio and based on its holdings reported for
                  the quarter before. Any difference is buying or selling around that date, or fractions paid in cash.
                </li>
                <li>
                  &ldquo;Stock split&rdquo; marks a split recorded from the company&apos;s official announcement: the shares
                  held before it, at the official ratio, became the shares shown, so only buying or selling beyond that is a
                  change.
                </li>
                <li>
                  &ldquo;Likely stock split&rdquo; marks a change by an exact whole-number ratio, such as 20 times the shares,
                  while the reported value per share fell by about as much. A reverse split (fewer shares) is marked only
                  when another tracked investor&apos;s holding changed by the same ratio, since selling exactly half looks
                  the same. Shares are shown as reported, not adjusted for splits.
                </li>
                <li>
                  Holdings are matched to {stock.ticker} by CUSIP, including, for the quarters shown above, an earlier CUSIP
                  converted one-for-one into {stock.ticker} or a CUSIP that filers mistyped. Options on {stock.ticker} are listed
                  separately and not counted as shares held; other share classes have their own pages.
                </li>
              </ul>
            </div>
          </details>
        </PendingFrame>
      </main>
    </QuarterNavigation>
  );
}
