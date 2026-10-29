import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import styles from "@/components/dashboard/dashboard.module.css";
import { formatNumber, formatUsdCompact, quarterLabel } from "@/lib/portfolio";
import { BERKSHIRE_HATHAWAY_CIK, getInvestorSummaries, type InvestorSummary } from "@/lib/portfolio-data";

export const metadata: Metadata = {
  title: "Investors",
  description: "Institutional investors tracked from their SEC Form 13F filings.",
};

// Investors with a dashboard, by CIK. The others are listed until their dashboards are added.
const DASHBOARDS: Record<string, string> = {
  [BERKSHIRE_HATHAWAY_CIK]: "/investors/berkshire-hathaway",
};

// "20 quarters, Q3 2021 – Q2 2026"
function history(investor: InvestorSummary): string {
  if (!investor.firstQuarter || !investor.latestQuarter) return "—";
  if (investor.quarterCount === 1) return "1 quarter";
  return `${investor.quarterCount} quarters, ${quarterLabel(investor.firstQuarter)} – ${quarterLabel(investor.latestQuarter)}`;
}

export default async function InvestorsPage() {
  // Rendered per request, like the dashboards, so newly imported investors and quarters appear at once.
  await connection();
  const investors = await getInvestorSummaries();

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
              Reported value is the market value of the 13F securities in each investor&apos;s latest reported
              quarter. Select an investor to open its dashboard.
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
              <caption className={styles.visuallyHidden}>Tracked investors and their latest reported quarter</caption>
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col" className={styles.wideOnly}>CIK</th>
                  <th scope="col">Latest quarter</th>
                  <th scope="col" className={styles.numeric}>Reported value</th>
                  <th scope="col" className={styles.optional}>History</th>
                </tr>
              </thead>
              <tbody>
                {investors.map((investor) => {
                  const dashboard = DASHBOARDS[investor.cik];
                  return (
                    <tr key={investor.id}>
                      <th scope="row" className={styles.security}>
                        {dashboard ? (
                          <Link href={dashboard} className={styles.issuer}>
                            {investor.name}
                          </Link>
                        ) : (
                          <span className={styles.issuer}>{investor.name}</span>
                        )}
                        {!dashboard && <span className={styles.securityClass}>Dashboard coming soon</span>}
                      </th>
                      <td className={`${styles.cusip} ${styles.wideOnly}`}>{investor.cik}</td>
                      <td>{investor.latestQuarter ? quarterLabel(investor.latestQuarter) : "None yet"}</td>
                      <td className={styles.numeric}>
                        {investor.latestValueUsd === null ? "—" : formatUsdCompact(investor.latestValueUsd)}
                      </td>
                      <td className={`${styles.secondary} ${styles.optional}`}>{history(investor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
