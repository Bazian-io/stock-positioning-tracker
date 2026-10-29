import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import styles from "@/components/dashboard/dashboard.module.css";
import { LinkSelect, PendingFrame, QuarterNavigation, QuarterSelect } from "@/components/dashboard/quarter-navigation";
import { ValueChart, type ChartQuarter } from "@/components/dashboard/value-chart";
import {
  axisTicks, formatDate, formatNumber, formatNumberAxis, formatNumberCompact, formatPercent, formatUsd, formatUsdCompact, quarterLabel,
  quarterParts,
} from "@/lib/portfolio";
import {
  EXCHANGE_NAMES, exactShareRatio, holdingSeries, lastQuarterBefore, previousQuarter, quarterChange, receivedInQuarter, type Change,
  type QuarterHolding,
  type Received, type Unconfirmed,
} from "@/lib/stock";
import { getStock, getStockOwnership, type StockPosition } from "@/lib/stock-data";

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

// "20-for-1" or "1-for-10".
function splitLabel(ratio: number): string {
  return ratio >= 1 ? `${formatNumber(ratio)}-for-1` : `1-for-${formatNumber(Math.round(1 / ratio))}`;
}

// "About 101,380,356 shares from Sirius XM's merger … on Sep 9, 2024, based on Q2 2024 holdings; +3,774,673 more than that".
function receivedNote(received: Received, change?: Change): string {
  const note = `About ${formatNumber(Math.round(received.shares))} shares from ${received.description} on ${formatDate(received.effectiveDate)}`;
  if (!change) return note;
  // Fractions of shares are paid in cash, so a difference of a few shares is not a trade.
  const beyond = Math.round(change.shares);
  const traded = Math.abs(beyond) > Math.max(10, received.shares * 1e-4);
  return `${note}, based on ${quarterLabel(change.previousPeriod)} holdings${traded
    ? `; ${beyond > 0 ? "+" : "−"}${formatNumber(Math.abs(beyond))} shares ${beyond > 0 ? "more" : "fewer"} than that` : ""}`;
}

// "Increased" with "+1,234 shares (+2.3%)", and so on. A change needs reports for both quarters.
function describeChange(change: Change): { label: string; detail?: string } {
  const sign = (value: number) => (value > 0 ? "+" : value < 0 ? "−" : "");
  const percent = change.fraction === null ? "" : ` (${sign(change.fraction)}${formatPercent(Math.abs(change.fraction))})`;
  const shares = `${sign(change.shares)}${formatNumber(Math.abs(change.shares))} shares`;
  switch (change.kind) {
    case "increased":
    case "decreased":
      return { label: change.kind === "increased" ? "Increased" : "Decreased", detail: `${shares}${percent}` };
    case "unchanged":
      return { label: "Unchanged" };
    case "received":
      return { label: "Received in corporate action", detail: change.received ? receivedNote(change.received, change) : undefined };
    case "split":
      return {
        label: "Likely stock split",
        detail: `${splitLabel(change.splitRatio ?? 1)}: reported shares ${(change.splitRatio ?? 1) >= 1
          ? `×${formatNumber(change.splitRatio ?? 1)}`
          : `÷${formatNumber(Math.round(1 / (change.splitRatio ?? 1)))}`}`,
      };
    case "opened":
      return { label: "New position", detail: `Not held in ${quarterLabel(change.previousPeriod)}` };
    case "closed":
      return { label: "Closed", detail: shares };
    case "not-held":
      return { label: "Not held", detail: `Also not held in ${quarterLabel(change.previousPeriod)}` };
    case "not-comparable":
      return {
        label: "Not comparable",
        detail: change.blocker?.reason === "unclear"
          ? `Holding unclear in ${quarterLabel(change.blocker.reportPeriod)}`
          : `No ${quarterLabel(change.blocker?.reportPeriod ?? change.previousPeriod)} report in our data`,
      };
  }
}

function stateLabel(holding: QuarterHolding): string {
  if (holding.state === "held") return `${formatNumber(holding.shares)} shares`;
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
  const [{ ticker: requestedTicker }, { quarter: requestedQuarter, investor: requestedInvestor }] = await Promise.all([params, searchParams]);
  const ticker = requestedTicker.toUpperCase();
  if (ticker !== requestedTicker) redirect(`/stocks/${encodeURIComponent(ticker)}`);
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
      const receivedThen = receivedInQuarter(conversions, heldBefore, quarter);
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
      change: changeAt(investor.id, index),
      portfolioShare: portfolio && portfolio.valueUsd > 0 ? current.valueUsd / portfolio.valueUsd : 0,
      options: positions.filter((position) => position.investorId === investor.id && position.reportPeriod === selected && position.positionType !== "long"),
    };
  });
  const holders = rows.filter((row) => row.current.state === "held").sort((a, b) => b.current.valueUsd - a.current.valueUsd);
  const notHeld = rows.filter((row) => row.current.state === "not-held");
  const unclear = rows.filter((row) => row.current.state === "unclear");
  const noReport = rows.filter((row) => row.current.state === "no-report");

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
    const { splitRatio } = chartInvestor ? changeAt(chartInvestor.id, position) : quarterChange(holding, chartSeries[position - 1]);
    const descriptions: Record<QuarterHolding["state"], string> = {
      held: `${formatNumber(holding.shares)} shares reported`,
      "not-held": "reported, not held",
      unclear: "holding unclear",
      "no-report": "no report in our data",
    };
    return {
      reportPeriod: holding.reportPeriod,
      label: quarter,
      ...quarterParts(holding.reportPeriod),
      valueLabel: held ? `${formatNumberCompact(holding.shares)} shares` : holding.state === "not-held" ? "0 shares" : stateLabel(holding),
      // A missing report or an unclear holding is drawn as a full-height hatched column; its label sits above it.
      height: held ? (holding.shares / scaleMax) * 100 : holding.state === "not-held" ? 0 : 100,
      description: `${quarter}: ${descriptions[holding.state]}`,
      details: held
        ? [
          `${quarter} reported shares`,
          `${formatUsdCompact(holding.valueUsd)} reported value`,
          ...(splitRatio !== null ? [`Likely ${splitLabel(splitRatio)} stock split`] : []),
          ...(holding.received ? [`Received in corporate action: ${receivedNote(holding.received)}`] : []),
        ]
        : holding.state === "not-held"
          ? [`${quarter}: reported, not held`]
          : holding.unconfirmed
            ? [`${quarter}: holding unclear`, unclearNote(holding.unconfirmed, stock.ticker)]
            : [`${quarter}: no 13F report in our data`],
      state: holding.state === "not-held" ? "zero" : held ? undefined : "missing",
    };
  });
  const chartTicks = ticks.map((tick) => ({ label: formatNumberAxis(tick), position: (tick / scaleMax) * 100 }));

  const pageHref = (query: Record<string, string>) => `/stocks/${encodeURIComponent(stock.ticker)}?${new URLSearchParams(query)}`;
  const quarterQuery: Record<string, string> = isLatest ? {} : { quarter: selected };
  const investorHref = (slug: string, reported: boolean) => `/investors/${slug}${reported ? `?quarter=${selected}` : ""}`;
  const currentCusips = stock.cusips.filter((period) => period.validTo === null).map((period) => period.cusip);
  // Earlier CUSIPs, such as one replaced in a corporate action, or one that filers mistyped: "531229748, Q3 2023–Q3 2025".
  const otherCusips = stock.cusips.flatMap((period) => period.validTo === null ? [] : [
    `${period.cusip}, ${quarterLabel(period.validFrom)}–${quarterLabel(lastQuarterBefore(period.validTo))}`,
  ]);
  const kind = stock.shareClass ?? stock.securityType.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());

  const holderRow = (row: (typeof rows)[number]) => {
    const change = describeChange(row.change);
    const note = row.current.unconfirmed
      ? unclearNote(row.current.unconfirmed, stock.ticker)
      : row.current.state === "not-held" && row.current.confidentialOmissions
        ? "This report omitted some holdings under confidential treatment, so the zero is not certain"
        : optionsNote(row.options);
    return (
      <tr key={row.investor.id}>
        <th scope="row" className={styles.security}>
          <Link href={investorHref(row.investor.slug, row.current.state !== "no-report")} className={styles.issuer}>
            {row.investor.name}
          </Link>
          {note && <span className={styles.securityClass}>{note}</span>}
        </th>
        <td className={styles.numeric}>
          {row.current.state === "held" ? formatNumber(row.current.shares) : row.current.state === "not-held" ? "0" : "—"}
        </td>
        <td className={styles.numeric} title={row.current.state === "held" ? formatUsd(row.current.valueUsd) : undefined}>
          {row.current.state === "held" ? formatUsdCompact(row.current.valueUsd) : "—"}
        </td>
        <td className={`${styles.numeric} ${styles.optional}`}>
          {row.current.state === "held" ? formatPercent(row.portfolioShare) : "—"}
        </td>
        <td className={styles.security}>
          {row.current.state === "no-report" || row.current.state === "unclear" ? (
            <span className={styles.secondary}>
              {row.current.state === "unclear" ? "Not comparable: holding unclear" : `No ${label} report in our data`}
            </span>
          ) : (
            <>
              <span>{change.label}</span>
              {change.detail && <span className={styles.securityClass}>{change.detail}</span>}
            </>
          )}
        </td>
      </tr>
    );
  };

  return (
    <QuarterNavigation keep={chartInvestor ? { investor: chartInvestor.slug } : {}}>
      <main className={styles.page}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href="/stocks">Stocks</Link>
          <span aria-hidden="true">/</span>
          <span>{stock.name}</span>
        </nav>

        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>
              {stock.name} <span className={styles.secondary}>{stock.ticker}</span>
            </h1>
            <p className={styles.meta}>
              <span>{stock.ticker} · {EXCHANGE_NAMES[stock.exchange] ?? stock.exchange}</span>
              <span>{kind}</span>
              {currentCusips.length > 0 && <span>CUSIP {currentCusips.join(", ")}</span>}
              {otherCusips.length > 0 && <span>Also matched under CUSIP {otherCusips.join("; ")}</span>}
            </p>
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
                  Tracked investors, {label}
                </h2>
                <p className={styles.cardSubtitle}>
                  Shares of {stock.ticker} reported on Form 13F for the quarter ended {formatDate(selected)}, and the change
                  from the quarter before. Only the investors tracked here are shown, not total institutional ownership.
                </p>
              </div>
              <p className={styles.cardMeta}>
                {holders.length} holding · {notHeld.length} reported without it
                {unclear.length > 0 ? ` · ${unclear.length} unclear` : ""} · {noReport.length} no report
              </p>
            </div>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.visuallyHidden}>
                  Tracked investors&apos; reported {stock.ticker} holdings, {label}
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
                  {holders.map(holderRow)}
                  {notHeld.length > 0 && (
                    <tr className={styles.groupRow}>
                      <th scope="colgroup" colSpan={5}>Reported for {label}, without {stock.ticker}</th>
                    </tr>
                  )}
                  {notHeld.map(holderRow)}
                  {unclear.length > 0 && (
                    <tr className={styles.groupRow}>
                      <th scope="colgroup" colSpan={5}>Reported for {label}, holding unclear</th>
                    </tr>
                  )}
                  {unclear.map(holderRow)}
                  {noReport.length > 0 && (
                    <tr className={styles.groupRow}>
                      <th scope="colgroup" colSpan={5}>No {label} report in our data: holding unknown</th>
                    </tr>
                  )}
                  {noReport.map(holderRow)}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card} aria-labelledby="share-history">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="share-history" className={styles.cardTitle}>
                  Reported {stock.ticker} shares by quarter{chartInvestor ? `, ${chartInvestor.name}` : ""}
                </h2>
                <p className={styles.cardSubtitle}>
                  Shares held at each quarter end, as reported. Changes reflect buying and selling, and corporate actions
                  such as stock splits; they are not investment returns. Select a bar to view that quarter.
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

          <section className={styles.card} aria-labelledby="about-stock">
            <div>
              <h2 id="about-stock" className={styles.cardTitle}>About these numbers</h2>
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
          </section>
        </PendingFrame>
      </main>
    </QuarterNavigation>
  );
}
