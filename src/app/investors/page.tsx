import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Fragment } from "react";
import styles from "@/components/dashboard/dashboard.module.css";
import { ValueSparkline } from "@/components/dashboard/sparkline";
import { formatNumber, formatPercent, formatUsdCompact, quarterLabel } from "@/lib/portfolio";
import { getInvestorSummaries, getPositions, type InvestorSummary, type Segment } from "@/lib/portfolio-data";
import { getStockLinks } from "@/lib/stock-data";

export const metadata: Metadata = {
  title: "Investors",
  description: "Institutional investors tracked from their SEC Form 13F filings.",
};

// The groups of the table, in order. Investors without a segment are listed last.
const SEGMENTS: { segment: Segment | null; title: string; detail: string }[] = [
  { segment: "asset_manager", title: "Asset managers", detail: "Index and asset managers that hold thousands of stocks" },
  { segment: "active_manager", title: "Active managers", detail: "Concentrated fundamental and activist funds" },
  { segment: "quantitative", title: "Quantitative funds", detail: "Systematic funds that trade many stocks" },
  { segment: null, title: "Other investors", detail: "Not yet grouped" },
];

// "Q2 2026 · 20 quarters since Q3 2021"
function history(investor: InvestorSummary): string {
  if (!investor.firstQuarter || !investor.latestQuarter) return "No quarters imported yet";
  if (investor.quarterCount === 1) return `${quarterLabel(investor.latestQuarter)} · 1 quarter`;
  return `${quarterLabel(investor.latestQuarter)} · ${investor.quarterCount} quarters since ${quarterLabel(investor.firstQuarter)}`;
}

export default async function InvestorsPage() {
  // Rendered per request, like the dashboards, so newly imported investors and quarters appear at once.
  await connection();
  const investors = await getInvestorSummaries();
  // Each investor's latest quarter: how many positions, and the largest one.
  const latest = await Promise.all(investors.map((investor) => (investor.latestQuarter && investor.latestValueUsd !== null
    ? getPositions(investor.id, investor.latestQuarter, investor.latestValueUsd, 0, 1)
    : null)));
  const periods = [...new Set(investors.flatMap((investor) => (investor.latestQuarter ? [investor.latestQuarter] : [])))];
  const stocks = Object.assign({}, ...await Promise.all(periods.map((period) => getStockLinks(
    investors.flatMap((investor, index) => {
      const cusip = latest[index]?.largest?.cusip;
      return investor.latestQuarter === period && cusip ? [cusip] : [];
    }),
    period,
  ))));
  const rows = investors.map((investor, index) => ({ investor, positions: latest[index] }));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Investors</h1>
          <p className={styles.meta}>
            <span>Institutional investors tracked from their SEC Form 13F filings</span>
          </p>
        </div>
      </header>

      <section className={styles.card} aria-labelledby="tracked-investors">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="tracked-investors" className={styles.cardTitle}>
              Tracked investors
            </h2>
            <p className={styles.cardSubtitle}>
              Each investor&apos;s latest reported quarter. Select a name to explore its portfolio.
            </p>
          </div>
          <p className={styles.cardMeta}>
            {investors.length === 1 ? "1 investor" : `${formatNumber(investors.length)} investors`}
          </p>
        </div>
        {investors.length === 0 ? (
          <p className={styles.cardSubtitle}>No investors have been imported yet.</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Tracked investors by group, with their latest reported quarter</caption>
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col" className={styles.numeric}>Reported value</th>
                  <th scope="col" className={`${styles.numeric} ${styles.optional}`}>Positions</th>
                  <th scope="col" className={styles.wideOnly}>Largest holding</th>
                  <th scope="col" className={styles.optional}>Trend</th>
                </tr>
              </thead>
              <tbody>
                {SEGMENTS.map(({ segment, title, detail }) => {
                  const members = rows.filter((row) => row.investor.segment === segment)
                    .sort((a, b) => (b.investor.latestValueUsd ?? 0) - (a.investor.latestValueUsd ?? 0));
                  if (members.length === 0) return null;
                  return (
                    <Fragment key={title}>
                      <tr className={styles.groupRow}>
                        <th scope="colgroup" colSpan={5}>
                          {title} <span className={styles.groupDetail}>· {members.length} · {detail}</span>
                        </th>
                      </tr>
                      {members.map(({ investor, positions }) => {
                        const largest = positions?.largest ?? null;
                        const largestStock = largest?.cusip ? stocks[largest.cusip] : undefined;
                        return (
                          <tr key={investor.id}>
                            <th scope="row" className={styles.security}>
                              <Link href={`/investors/${investor.slug}`} className={styles.issuer}>
                                {investor.name}
                              </Link>
                              <span className={styles.securityClass}>{history(investor)}</span>
                            </th>
                            <td className={styles.numeric}>
                              {investor.latestValueUsd === null ? "—" : formatUsdCompact(investor.latestValueUsd)}
                            </td>
                            <td className={`${styles.numeric} ${styles.optional}`}>{positions ? formatNumber(positions.total) : "—"}</td>
                            <td className={`${styles.security} ${styles.wideOnly}`}>
                              {largest ? (
                                <>
                                  {largestStock ? (
                                    <Link href={`/stocks/${encodeURIComponent(largestStock.ticker)}`}>{largestStock.name}</Link>
                                  ) : (
                                    <span>{largest.issuer}</span>
                                  )}
                                  <span className={styles.securityClass}>{formatPercent(largest.portfolioShare)} of reported value</span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className={styles.optional}>
                              <ValueSparkline values={investor.values} />
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <details className={styles.disclosure}>
          <summary>About reported values &amp; trends</summary>
          <p className={styles.cardSubtitle}>
            Reported value is the market value of the 13F securities in each investor&apos;s latest reported quarter,
            not an investment return. The trend shows reported value by quarter, each on its own scale.
          </p>
        </details>
      </section>
    </main>
  );
}
