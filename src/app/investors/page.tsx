import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Fragment } from "react";
import styles from "@/components/dashboard/dashboard.module.css";
import { ValueSparkline } from "@/components/dashboard/sparkline";
import { formatNumber, formatPercent, formatUsdCompact, quarterLabel } from "@/lib/portfolio";
import type { InvestorSummary, Segment } from "@/lib/portfolio-data";
import { getInvestorDirectory } from "@/lib/investor-directory-data";
import { reportingQuarter, researchHref, type ResearchParams } from "@/lib/research";

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
function history(investor: InvestorSummary, period: string | null): string {
  if (!period) return "No quarters imported yet";
  if (!investor.values.some((quarter) => quarter.reportPeriod === period)) return `${quarterLabel(period)} · No report imported`;
  if (investor.quarterCount === 1) return `${quarterLabel(period)} · 1 quarter`;
  return `${quarterLabel(period)} · ${investor.quarterCount} quarters since ${quarterLabel(investor.firstQuarter!)}`;
}

export default async function InvestorsPage({ searchParams }: { searchParams: Promise<ResearchParams> }) {
  // Request-specific navigation surrounds shared directory data, invalidated after imports.
  await connection();
  const quarter = reportingQuarter((await searchParams).quarter);
  const rows = await getInvestorDirectory(quarter ?? null);
  const listHref = researchHref("/investors", { quarter });

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Investors</h1>
          <p className={styles.meta}>
            <span>Institutional investors tracked from their SEC Form 13F filings</span>
            {quarter && <span>Researching {quarterLabel(quarter)} · <Link href="/investors">Use latest quarters</Link></span>}
          </p>
        </div>
        <Link href={researchHref("/compare", { quarter, from: listHref })} className={styles.pageLink}>Compare investors →</Link>
      </header>

      <section className={styles.card} aria-labelledby="tracked-investors">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="tracked-investors" className={styles.cardTitle}>
              Tracked investors
            </h2>
            <p className={styles.cardSubtitle}>
              {quarter ? `Reports for ${quarterLabel(quarter)}. Missing reports are marked as unavailable.` : "Each investor’s latest reported quarter."} Select a name to explore its portfolio.
            </p>
          </div>
          <p className={styles.cardMeta}>
            {rows.length === 1 ? "1 investor" : `${formatNumber(rows.length)} investors`}
          </p>
        </div>
        {rows.length === 0 ? (
          <p className={styles.cardSubtitle}>No investors have been imported yet.</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Tracked investors by group, {quarter ? quarterLabel(quarter) : "latest reported quarters"}</caption>
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
                    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
                  if (members.length === 0) return null;
                  return (
                    <Fragment key={title}>
                      <tr className={styles.groupRow}>
                        <th scope="colgroup" colSpan={5}>
                          {title} <span className={styles.groupDetail}>· {members.length} · {detail}</span>
                        </th>
                      </tr>
                      {members.map(({ investor, positions, period, valueUsd, largestStock }) => {
                        const largest = positions?.largest ?? null;
                        const from = `${listHref}#investor-${investor.slug}`;
                        return (
                          <tr key={investor.id} id={`investor-${investor.slug}`}>
                            <th scope="row" className={styles.security}>
                              <Link href={researchHref(`/investors/${investor.slug}`, { quarter, from })} className={styles.issuer}>
                                {investor.name}
                              </Link>
                              <span className={styles.securityClass}>{history(investor, period)}</span>
                            </th>
                            <td className={styles.numeric}>
                              {valueUsd === null ? "—" : formatUsdCompact(valueUsd)}
                            </td>
                            <td className={`${styles.numeric} ${styles.optional}`}>{positions ? formatNumber(positions.total) : "—"}</td>
                            <td className={`${styles.security} ${styles.wideOnly}`}>
                              {largest ? (
                                <>
                                  {largestStock ? (
                                    <Link href={researchHref(`/stocks/${encodeURIComponent(largestStock.ticker)}`, { quarter: period ?? undefined, investor: investor.slug, from })}>{largestStock.name}</Link>
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
            Reported value is the market value of the 13F securities in {quarter ? "the selected quarter" : "each investor’s latest reported quarter"},
            not an investment return. The trend shows reported value by quarter, each on its own scale.
          </p>
        </details>
      </section>
    </main>
  );
}
