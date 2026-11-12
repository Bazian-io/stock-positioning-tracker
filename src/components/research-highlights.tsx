import { Link } from "@/components/link";
import { PendingFrame, QuarterSelect } from "@/components/dashboard/quarter-navigation";
import { describeChange } from "@/lib/change-description";
import { formatNumber, formatPercent, quarterLabel } from "@/lib/portfolio";
import { researchHref } from "@/lib/research";
import { getHighlights } from "@/lib/research-highlights-data";
import { previousQuarter } from "@/lib/stock";
import dashboard from "./dashboard/dashboard.module.css";
import styles from "./research.module.css";

export function ResearchHighlightsLoading() {
  return (
    <section className={dashboard.card} aria-busy="true" aria-label="Notable reported changes">
      <h2 className={dashboard.cardTitle}>Notable reported changes</h2>
      <p className={dashboard.cardSubtitle} role="status">Comparing active managers’ reported holdings…</p>
    </section>
  );
}

export async function ResearchHighlights({ quarter }: { quarter?: string }) {
  let overview: Awaited<ReturnType<typeof getHighlights>>;
  try {
    overview = await getHighlights(quarter);
  } catch {
    return (
      <section className={dashboard.card} aria-labelledby="research-updates">
        <h2 id="research-updates" className={dashboard.cardTitle}>Notable reported changes</h2>
        <p className={dashboard.cardSubtitle} role="alert">
          Highlights couldn&apos;t be loaded. <a href={researchHref("/", { quarter })}>Try again</a>.
        </p>
      </section>
    );
  }
  const { period, periods, highlights, compared, failed, eligible, total } = overview;
  if (!period) return <section className={dashboard.card}><h2 className={dashboard.cardTitle}>Notable reported changes</h2><p className={dashboard.emptyState}>No reporting quarters have been imported yet.</p></section>;
  const priorLabel = quarterLabel(previousQuarter(period));
  const label = quarterLabel(period);
  const from = `${researchHref("/", { quarter: period })}#research-updates`;

  return (
    <section className={dashboard.card} aria-labelledby="research-updates">
      <div className={dashboard.cardHeader}>
        <div>
          <h2 id="research-updates" className={dashboard.cardTitle}>Notable reported changes</h2>
          <p className={dashboard.cardSubtitle}>Active managers · {priorLabel} → {label}</p>
        </div>
        <QuarterSelect selected={period} quarters={[
          ...(!periods.includes(period) ? [{ value: period, label: `${label} (no reports)` }] : []),
          ...periods.map((value, index) => ({ value, label: `${quarterLabel(value)}${index === 0 ? " (latest)" : ""}` })),
        ]} />
      </div>
      <PendingFrame>
        <p className={dashboard.note}>
          {formatNumber(compared)} of {formatNumber(total)} active managers compared.
          {eligible < total && <> {formatNumber(total - eligible)} {total - eligible === 1 ? "manager lacks" : "managers lack"} a report for one or both quarters.</>}
          {failed > 0 && <> Comparisons for {formatNumber(failed)} {failed === 1 ? "manager" : "managers"} couldn&apos;t be loaded.</>}
          {" "}One change per manager, ranked by the shift in portfolio weight.
        </p>
        {highlights.length === 0 ? (
          <p className={dashboard.emptyState}>
            {compared === 0 ? "No complete comparisons are available for these quarters." : "No qualifying share-position changes in the available comparisons."}
          </p>
        ) : (
          <div className={styles.highlights}>
            {highlights.map(({ investor, position }) => {
              const described = describeChange(position.change);
              const investorHref = `${researchHref(`/investors/${investor.slug}`, { quarter: period, from })}#changes`;
              const stockHref = position.ticker ? researchHref(`/stocks/${encodeURIComponent(position.ticker)}`, { quarter: period, investor: investor.slug, from }) : undefined;
              return (
                <article key={investor.id} className={styles.highlight} data-highlight-kind={position.change.kind}>
                  <Link href={investorHref} className={styles.manager}>{investor.name}</Link>
                  <p className={styles.changeLabel}>{described.label} · {label}</p>
                  <h3><Link href={stockHref ?? investorHref}>{position.name}{position.ticker && <span className={styles.ticker}> {position.ticker}</span>}</Link></h3>
                  <p className={dashboard.note}>{described.detail}</p>
                  <div className={styles.weight}>
                    <span className={dashboard.note}>Portfolio weight · {priorLabel} → {label}</span>
                    <strong>{formatPercent(position.previousWeight!)} → {formatPercent(position.currentWeight!)}</strong>
                  </div>
                  <Link href={investorHref} className={styles.explore}>Explore manager&apos;s changes →</Link>
                </article>
              );
            })}
          </div>
        )}
        <details className={dashboard.disclosure}>
          <summary>How highlights are selected</summary>
          <p className={dashboard.cardSubtitle}>
            Up to six changes, using consecutive imported reports for active managers. Each manager&apos;s largest absolute
            shift in portfolio weight among new, increased, reduced or closed long share positions is considered.
            Weights use the full reported 13F value and reflect both holdings and prices. Corporate actions and uncertain
            comparisons are excluded. These are quarter-end disclosures, not proof of trades.
          </p>
        </details>
      </PendingFrame>
    </section>
  );
}
