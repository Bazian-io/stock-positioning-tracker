import Link from "next/link";
import { PendingFrame, QuarterSelect } from "@/components/dashboard/quarter-navigation";
import { describeChange } from "@/lib/change-description";
import { formatNumber, formatPercent, quarterLabel } from "@/lib/portfolio";
import { getInvestorSummaries } from "@/lib/portfolio-data";
import { getPortfolioChanges } from "@/lib/portfolio-changes-data";
import type { ComparisonQuarter } from "@/lib/portfolio-changes";
import { notableChanges, researchHref, type ManagerChanges } from "@/lib/research";
import { previousQuarter } from "@/lib/stock";
import { loadAll } from "@/lib/stock-data";
import { readOnlySupabase } from "@/lib/supabase";
import dashboard from "./dashboard/dashboard.module.css";
import styles from "./research.module.css";

async function getHighlights(requested?: string) {
  const investors = await getInvestorSummaries();
  const periods = [...new Set(investors.flatMap((investor) => investor.values.map((quarter) => quarter.reportPeriod)))].sort().toReversed();
  const period = requested ?? periods[0];
  const managers = investors.filter((investor) => investor.segment === "active_manager");
  if (!period || managers.length === 0) return { period, periods, total: managers.length, eligible: 0, comparisons: [], failed: 0 };
  const prior = previousQuarter(period);
  const quarters = await loadAll<{ investor_id: string; report_period: string; value_usd: string; has_confidential_omissions: boolean }>(
    (from, to) => readOnlySupabase().from("quarterly_portfolios")
      .select("investor_id, report_period, value_usd::text, has_confidential_omissions")
      .in("investor_id", managers.map((investor) => investor.id)).in("report_period", [prior, period])
      .order("investor_id").order("report_period").range(from, to), "homepage reporting coverage",
  );
  const summary = (id: string, reportPeriod: string): ComparisonQuarter | undefined => {
    const row = quarters.find((quarter) => quarter.investor_id === id && quarter.report_period === reportPeriod);
    return row ? { reportPeriod, valueUsd: Number(row.value_usd), confidentialOmissions: row.has_confidential_omissions } : undefined;
  };
  const eligible = managers.flatMap((investor) => {
    const current = summary(investor.id, period);
    const previous = summary(investor.id, prior);
    return current && previous ? [{ investor, current, previous }] : [];
  });
  const comparisons: ManagerChanges[] = [];
  let failed = 0;
  // Concentrated active-manager portfolios keep this preview bounded. Use the same comparison
  // and corporate-action rules as the dashboards, with at most three managers loading at once.
  for (let start = 0; start < eligible.length; start += 3) {
    const results = await Promise.allSettled(eligible.slice(start, start + 3).map(async ({ investor, current, previous }) => ({
      investor, changes: await getPortfolioChanges(investor.id, current, previous),
    })));
    for (const result of results) {
      if (result.status === "fulfilled") comparisons.push(result.value);
      else failed += 1;
    }
  }
  return { period, periods, total: managers.length, eligible: eligible.length, comparisons, failed };
}

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
  const { period, periods, comparisons, failed, eligible, total } = overview;
  if (!period) return <section className={dashboard.card}><h2 className={dashboard.cardTitle}>Notable reported changes</h2><p className={dashboard.emptyState}>No reporting quarters have been imported yet.</p></section>;
  const priorLabel = quarterLabel(previousQuarter(period));
  const label = quarterLabel(period);
  const highlights = notableChanges(comparisons);
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
          {formatNumber(comparisons.length)} of {formatNumber(total)} active managers compared.
          {eligible < total && <> {formatNumber(total - eligible)} {total - eligible === 1 ? "manager lacks" : "managers lack"} a report for one or both quarters.</>}
          {failed > 0 && <> Comparisons for {formatNumber(failed)} {failed === 1 ? "manager" : "managers"} couldn&apos;t be loaded.</>}
          {" "}One change per manager, ranked by the shift in portfolio weight.
        </p>
        {highlights.length === 0 ? (
          <p className={dashboard.emptyState}>
            {comparisons.length === 0 ? "No complete comparisons are available for these quarters." : "No qualifying share-position changes in the available comparisons."}
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
