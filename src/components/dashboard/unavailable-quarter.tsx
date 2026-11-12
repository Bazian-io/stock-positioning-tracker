import { Link } from "@/components/link";
import { ResearchReturn } from "@/components/research-return";
import { quarterLabel } from "@/lib/portfolio";
import type { Investor, QuarterSummary } from "@/lib/portfolio-data";
import { detailReturnTarget, researchHref } from "@/lib/research";
import { QuarterNavigation, QuarterSelect } from "./quarter-navigation";
import styles from "./dashboard.module.css";

export function UnavailableInvestorQuarter({ investor, quarters, period, from, back }: {
  investor: Investor; quarters: QuarterSummary[]; period?: string; from?: string; back?: string;
}) {
  const latest = quarters.at(-1);
  const label = period ? quarterLabel(period) : undefined;
  return (
    <QuarterNavigation keep={{ ...(from ? { from } : {}), ...(back ? { back } : {}) }}>
      <main className={styles.page}>
        <ResearchReturn from={from} back={back} />
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={researchHref("/investors", { quarter: period })}>Investors</Link><span aria-hidden="true">/</span><span>{investor.name}</span>
        </nav>
        <header className={styles.header}>
          <div><h1 className={styles.title}>{investor.name}</h1><p className={styles.meta}>Holdings reported to the SEC on Form 13F</p></div>
          {period && <QuarterSelect selected={period} quarters={[
            { value: period, label: `${label} (no report)` },
            ...quarters.toReversed().map((quarter) => ({ value: quarter.reportPeriod, label: `${quarterLabel(quarter.reportPeriod)}${quarter === latest ? " (latest)" : ""}` })),
          ]} />}
        </header>
        <section className={styles.card} aria-labelledby="unavailable-quarter">
          <h2 id="unavailable-quarter" className={styles.cardTitle}>{label ? `No ${label} report available` : "No reporting quarters available"}</h2>
          <p className={styles.emptyState}>
            A validated report {label ? `for ${label} ` : ""}has not been imported for {investor.name}.
            Holdings and changes for this period are unknown.
          </p>
          {latest && <Link href={researchHref(`/investors/${investor.slug}`, { quarter: latest.reportPeriod, from, back })}>
            View {quarterLabel(latest.reportPeriod)}, the latest reported quarter →
          </Link>}
          <p className={styles.cardSubtitle}><Link href={researchHref("/compare", {
            a: investor.slug, quarter: period, from,
            back: detailReturnTarget(researchHref(`/investors/${investor.slug}`, { quarter: period, from }))?.href,
          })}>Compare with another investor →</Link></p>
        </section>
      </main>
    </QuarterNavigation>
  );
}
