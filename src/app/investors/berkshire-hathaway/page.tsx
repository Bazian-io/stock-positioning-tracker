import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import styles from "@/components/dashboard/dashboard.module.css";
import { HoldingsTable } from "@/components/dashboard/holdings-table";
import { PendingFrame, QuarterNavigation, QuarterSelect } from "@/components/dashboard/quarter-navigation";
import { ValueChart } from "@/components/dashboard/value-chart";
import {
  axisTicks, combineHoldings, formatDate, formatFilingDate, formatNumber, formatPercent, formatUsd, formatUsdAxis,
  formatUsdCompact, quarterLabel, quarterParts,
} from "@/lib/portfolio";
import {
  BERKSHIRE_HATHAWAY_CIK, getHoldingRows, getInvestor, getQuarterFilings, getQuarterSummaries, type QuarterFiling,
} from "@/lib/portfolio-data";

export const metadata: Metadata = {
  title: "Berkshire Hathaway 13F portfolio",
  description: "Berkshire Hathaway's reported 13F holdings by quarter, from SEC filings.",
};

const PAGE_PATH = "/investors/berkshire-hathaway";
const TOP_HOLDINGS = 10;

function filingRole(filing: QuarterFiling): string {
  if (filing.amendmentType === "none") return "Original report";
  const role = filing.amendmentType === "restatement" ? "restatement" : "new holdings";
  return `Amendment ${filing.amendmentNumber}, ${role}`;
}

export default async function BerkshireHathawayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { quarter: requested, holdings } = await searchParams;
  const investor = await getInvestor(BERKSHIRE_HATHAWAY_CIK);
  if (!investor) notFound();
  const quarters = await getQuarterSummaries(investor.id);
  const latest = quarters.at(-1);
  const selected = requested === undefined ? latest : quarters.find((quarter) => quarter.reportPeriod === requested);
  if (!latest || !selected) notFound();

  const [rows, filings] = await Promise.all([
    getHoldingRows(investor.id, selected.reportPeriod),
    getQuarterFilings(investor, selected.reportPeriod),
  ]);
  const positions = combineHoldings(rows);
  const largest = positions[0];
  const original = filings.find((filing) => filing.amendmentType === "none");
  const amendments = filings.filter((filing) => filing.amendmentType !== "none");
  const label = quarterLabel(selected.reportPeriod);
  const isLatest = selected === latest;
  const quarterQuery = isLatest ? "" : `quarter=${selected.reportPeriod}`;
  const showAll = holdings === "all";

  const ticks = axisTicks(Math.max(...quarters.map((quarter) => quarter.valueUsd)));
  const scaleMax = ticks.at(-1) ?? 1;
  const chartQuarters = quarters.map((quarter) => ({
    reportPeriod: quarter.reportPeriod,
    label: quarterLabel(quarter.reportPeriod),
    ...quarterParts(quarter.reportPeriod),
    valueLabel: formatUsdCompact(quarter.valueUsd),
    height: (quarter.valueUsd / scaleMax) * 100,
    amended: quarter.amended,
  }));
  const chartTicks = ticks.map((tick) => ({ label: formatUsdAxis(tick), position: (tick / scaleMax) * 100 }));

  return (
    <QuarterNavigation>
      <main className={styles.page}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href="/">Investors</Link>
          <span aria-hidden="true">/</span>
          <span>Berkshire Hathaway</span>
        </nav>

        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>{investor.name}</h1>
            <p className={styles.meta}>
              <span>CIK {investor.cik}</span>
              <span>Holdings reported to the SEC on Form 13F</span>
              <a href={`https://www.sec.gov/edgar/browse/?CIK=${Number(investor.cik)}`}>SEC EDGAR filings ↗</a>
            </p>
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
              <Link href={PAGE_PATH} scroll={false}>
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
                {formatUsd(selected.valueUsd)}: the market value of the 13F securities held at quarter end, as
                reported to the SEC. A historical snapshot, not an investment return.
              </p>
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
                <p className={styles.tileValue}>{formatNumber(positions.length)} securities</p>
                <p className={styles.note}>Combined from {formatNumber(selected.holdingRowCount)} filing rows</p>
              </div>
              <div className={styles.tile}>
                <p className={styles.label}>Largest position</p>
                <p className={styles.tileValue}>{largest?.issuer ?? "None reported"}</p>
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
                  Total market value of the 13F securities reported at each quarter end,{" "}
                  {chartQuarters[0].label} to {chartQuarters[chartQuarters.length - 1].label}. Changes reflect
                  trading and price moves, not investment returns. Select a bar to view that quarter.
                </p>
              </div>
            </div>
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
          </section>

          <section className={styles.card} aria-labelledby="holdings">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="holdings" className={styles.cardTitle}>
                  Largest holdings, {label}
                </h2>
                <p className={styles.cardSubtitle}>
                  Ranked by reported value. Berkshire reports some positions in several rows, one per group of
                  subsidiaries; rows for the same security are combined here. Share classes stay separate.
                </p>
              </div>
              <p className={styles.cardMeta}>
                {formatNumber(positions.length)} securities · {formatUsdCompact(selected.valueUsd)}
              </p>
            </div>
            <HoldingsTable
              positions={positions}
              caption={`Largest holdings, ${label}, combined by security`}
              limit={TOP_HOLDINGS}
              showAll={showAll}
              toggleHref={`${PAGE_PATH}?${[quarterQuery, showAll ? "" : "holdings=all"].filter(Boolean).join("&")}`}
            />
          </section>

          <section className={`${styles.card} ${styles.split}`} aria-label="Sources and notes">
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
                  Reported value is the market value, at quarter-end prices, of the securities Berkshire Hathaway
                  listed on Form 13F. It leaves out cash, bonds, wholly owned businesses and anything else outside
                  the SEC&apos;s 13F list.
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
          </section>
        </PendingFrame>
      </main>
    </QuarterNavigation>
  );
}
