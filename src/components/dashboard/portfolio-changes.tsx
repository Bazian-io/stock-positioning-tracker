import Link from "next/link";
import { describeChange } from "@/lib/change-description";
import { getPortfolioChanges } from "@/lib/portfolio-changes-data";
import { CHANGE_FILTERS, matchesChange, type ChangeFilter, type ComparisonQuarter, type PortfolioChange } from "@/lib/portfolio-changes";
import { formatNumber, formatPercent, quarterLabel } from "@/lib/portfolio";
import { previousQuarter, type QuarterHolding } from "@/lib/stock";
import { detailReturnTarget, researchHref, returnTarget } from "@/lib/research";
import styles from "./dashboard.module.css";

const PAGE_SIZE = 25;
const SUMMARY_FILTERS: ChangeFilter[] = ["opened", "increased", "decreased", "closed"];

function shares(holding: QuarterHolding): string {
  if (holding.state === "held") return formatNumber(holding.shares);
  if (holding.state === "not-held") return holding.confidentialOmissions ? "Uncertain" : "0";
  return holding.state === "unclear" ? "Unclear" : "No report";
}

export function PortfolioChangesLoading() {
  return (
    <section className={styles.card} aria-busy="true" aria-label="Quarterly position changes">
      <h2 className={styles.cardTitle}>What changed this quarter?</h2>
      <p className={styles.cardSubtitle} role="status">Comparing reported share positions…</p>
    </section>
  );
}

export async function PortfolioChanges({ investorId, slug, current, previous, filter, requestedPage, query }: {
  investorId: string;
  slug: string;
  current: ComparisonQuarter;
  previous?: ComparisonQuarter;
  filter: ChangeFilter;
  requestedPage: number;
  query: Record<string, string>;
}) {
  const currentLabel = quarterLabel(current.reportPeriod);
  const previousLabel = quarterLabel(previousQuarter(current.reportPeriod));
  const href = (selection: ChangeFilter, page = 1) => {
    const params = new URLSearchParams(query);
    params.delete("changePage");
    if (selection === "changed") params.delete("change");
    else params.set("change", selection);
    if (page > 1) params.set("changePage", String(page));
    return `/investors/${slug}?${params}#changes`;
  };
  if (!previous || previous.reportPeriod !== previousQuarter(current.reportPeriod)) {
    return (
      <section className={styles.card} aria-labelledby="changes">
        <h2 id="changes" className={styles.cardTitle}>What changed this quarter?</h2>
        <p className={styles.emptyState}>
          No {previousLabel} report is available to compare with {currentLabel}. Holdings are shown below;
          new positions and exits cannot be determined from a missing report.
        </p>
      </section>
    );
  }
  let rows: PortfolioChange[];
  try {
    rows = await getPortfolioChanges(investorId, current, previous);
  } catch {
    return (
      <section className={styles.card} aria-labelledby="changes">
        <h2 id="changes" className={styles.cardTitle}>What changed this quarter?</h2>
        <p className={styles.cardSubtitle} role="alert">
          The quarter comparison couldn&apos;t be loaded. <a href={href(filter)}>Reload this comparison</a>.
        </p>
      </section>
    );
  }
  const count = (selection: ChangeFilter) => rows.filter((row) => matchesChange(row, selection)).length;
  const filtered = rows.filter((row) => matchesChange(row, filter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const start = (page - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);
  const label = CHANGE_FILTERS.find((option) => option.value === filter)!.label;
  const value = (weight: number | null) => weight === null ? "—" : formatPercent(weight);
  const back = detailReturnTarget(href(filter, page))?.href;

  return (
    <section className={styles.card} aria-labelledby="changes">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="changes" className={styles.cardTitle}>What changed this quarter?</h2>
          <p className={styles.cardSubtitle}>
            {previousLabel} → {currentLabel} · Changes in reported long share positions, largest portfolio weights first.
          </p>
        </div>
      </div>
      <nav className={styles.changeSummary} aria-label="Position change summary">
        {CHANGE_FILTERS.filter((option) => SUMMARY_FILTERS.includes(option.value)).map((option) => (
          <Link key={option.value} href={href(option.value)} scroll={false} className={styles.changeTile} aria-current={filter === option.value ? "true" : undefined}>
            <span>{option.label}</span>
            <strong>{formatNumber(count(option.value))}</strong>
          </Link>
        ))}
      </nav>
      <nav className={styles.changeFilters} aria-label="Other position change filters">
        {CHANGE_FILTERS.filter((option) => !SUMMARY_FILTERS.includes(option.value)).map((option) => (
          <Link key={option.value} href={href(option.value)} scroll={false} className={styles.pageLink} aria-current={filter === option.value ? "true" : undefined}>
            {option.label} <span>{formatNumber(count(option.value))}</span>
          </Link>
        ))}
      </nav>
      <p className={styles.note}>
        Share changes are reported disclosures, not proof of trades. Splits and other corporate actions are shown separately.
      </p>
      {shown.length === 0 ? (
        <p className={styles.emptyState}>No {label.toLowerCase()} in this comparison.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={`${styles.table} ${styles.holderTable} ${styles.changesTable}`} role="table">
            <caption className={styles.visuallyHidden}>{label}, {previousLabel} to {currentLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Security</th>
                <th scope="col" className={styles.numeric}>{previousLabel} shares</th>
                <th scope="col" className={styles.numeric}>{currentLabel} shares</th>
                <th scope="col" className={styles.numeric}>Portfolio weight<br />{previousLabel} → {currentLabel}</th>
                <th scope="col">Reported change</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const described = row.note && row.category === "corporate-action"
                  ? { label: "Converted security", detail: row.note } : describeChange(row.change);
                return (
                  <tr key={row.id} data-change-kind={row.category}>
                    <th scope="row" className={`${styles.security} ${styles.wrapping}`}>
                      {row.ticker ? (
                        <Link href={researchHref(`/stocks/${encodeURIComponent(row.ticker)}`, { quarter: current.reportPeriod, investor: slug, from: returnTarget(query.from)?.href, back })} className={styles.issuer}>
                          {row.name}
                        </Link>
                      ) : <span className={styles.issuer}>{row.name}</span>}
                      <span className={styles.securityClass}>{row.ticker ?? (row.cusips.join(", ") || "CUSIP unavailable")}</span>
                    </th>
                    <td className={styles.numeric} data-label={`${previousLabel} shares`}>{shares(row.previous)}</td>
                    <td className={styles.numeric} data-label={`${currentLabel} shares`}>{shares(row.current)}</td>
                    <td className={styles.numeric} data-label={`Portfolio weight: ${previousLabel} → ${currentLabel}`}>
                      {value(row.previousWeight)} → {value(row.currentWeight)}
                    </td>
                    <td className={`${styles.security} ${styles.wrapping} ${styles.changeCell}`} data-label="Reported change">
                      <span className={styles.issuer}>{described.label}</span>
                      {described.detail && <span className={styles.securityClass}>{described.detail}</span>}
                      {row.note && row.category !== "corporate-action" && <span className={styles.securityClass}>{row.note}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <nav className={styles.pagination} aria-label="Position change pages">
        <span className={styles.secondary}>
          {filtered.length ? `${formatNumber(start + 1)}–${formatNumber(start + shown.length)} of ${formatNumber(filtered.length)}` : "0"} · {label}
        </span>
        <div className={styles.pageActions}>
          {pageCount > 1 && <span className={styles.secondary}>Page {formatNumber(page)} of {formatNumber(pageCount)}</span>}
          {page > 1 && <Link href={href(filter, page - 1)} className={styles.pageLink}>← Previous</Link>}
          {page < pageCount && <Link href={href(filter, page + 1)} className={styles.pageLink}>Next →</Link>}
        </div>
      </nav>
      <details className={styles.disclosure}>
        <summary>How this comparison works</summary>
        <p className={styles.cardSubtitle}>
          Only consecutive reported quarters are compared. Long share positions are combined using verified security
          identifiers or the same reported CUSIP. Options and principal amounts remain in the holdings table below.
          Weights use each quarter&apos;s full reported portfolio value and may change with prices as well as holdings.
          Uncertain identities and confidential omissions are flagged, and reported shares are never adjusted.
        </p>
      </details>
    </section>
  );
}
