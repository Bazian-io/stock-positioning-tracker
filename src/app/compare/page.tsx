import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import styles from "@/components/dashboard/dashboard.module.css";
import comparison from "@/components/dashboard/investor-comparison.module.css";
import { InvestorComparison, InvestorComparisonLoading } from "@/components/dashboard/investor-comparison";
import { ResearchReturn } from "@/components/research-return";
import { COMPARISON_FILTERS, COMPARISON_SORTS, comparisonPeriods } from "@/lib/investor-comparison";
import { quarterLabel } from "@/lib/portfolio";
import { getInvestorSummaries } from "@/lib/portfolio-data";
import { detailReturnTarget, reportingQuarter, researchHref, resultPage, returnTarget, searchQuery, type ResearchParams } from "@/lib/research";

export const metadata: Metadata = { title: "Compare investors", description: "Compare two institutional investors' reported holdings and portfolio weights in the same quarter." };

export default async function ComparePage({ searchParams }: { searchParams: Promise<ResearchParams> }) {
  const params = await searchParams;
  const investors = await getInvestorSummaries();
  const left = investors.find((investor) => investor.slug === params.a);
  const right = investors.find((investor) => investor.slug === params.b);
  const requested = reportingQuarter(params.quarter);
  const plan = comparisonPeriods(left?.values.map((quarter) => quarter.reportPeriod) ?? [], right?.values.map((quarter) => quarter.reportPeriod) ?? [], requested);
  const period = left && right ? plan.selected : requested;
  const periods = left || right ? plan.periods : [...new Set(investors.flatMap((investor) => investor.values.map((quarter) => quarter.reportPeriod)))].sort().toReversed();
  const context: Record<string, string> = {};
  const from = returnTarget(params.from)?.href;
  const back = detailReturnTarget(params.back)?.href;
  if (from) context.from = from;
  if (back) context.back = back;
  const validation = (params.a && !left) || (params.b && !right) ? "Choose a tracked investor in each list."
    : left && right && left.id === right.id ? "Choose two different investors to compare."
    : params.quarter !== undefined && params.quarter !== "" && !requested ? "Choose a valid reporting quarter." : undefined;
  const filter = COMPARISON_FILTERS.find((value) => value === params.filter) ?? "shared";
  const sort = COMPARISON_SORTS.find((option) => option.value === params.sort)?.value ?? "weight";
  const query = searchQuery(params.q);
  const page = resultPage(params.page);
  if (!validation && left && right && period && !requested) redirect(researchHref("/compare", {
    ...context, a: left.slug, b: right.slug, quarter: period, filter, q: query, sort, page: page > 1 ? String(page) : undefined,
  }));

  return <main className={styles.page}>
    <ResearchReturn from={from} back={back} />
    <header><h1 className={styles.title}>Compare investors</h1>
      <p className={styles.meta}>See where two investors overlap and how much weight each gives the same security.</p>
    </header>
    <form key={`${left?.id}:${right?.id}:${period}`} action="/compare" className={comparison.selection} aria-label="Choose investors and quarter">
      {Object.entries(context).map(([name, value]) => <input type="hidden" key={name} name={name} value={value} />)}
      {[{ name: "a", label: "Investor A", selected: left }, { name: "b", label: "Investor B", selected: right }].map(({ name, label, selected }) => (
        <label key={name} className={styles.quarterSelect}>{label}<span className={styles.selectWrap}>
          <select name={name} defaultValue={selected?.slug ?? ""} required><option value="" disabled>Choose an investor</option>
            {investors.map((investor) => <option key={investor.id} value={investor.slug}>{investor.name}</option>)}
          </select>
        </span></label>
      ))}
      <label className={styles.quarterSelect}>Reporting quarter<span className={styles.selectWrap}>
        <select name="quarter" defaultValue={period ?? ""}>
          <option value="">Latest available for both</option>
          {period && !periods.includes(period) && <option value={period}>{quarterLabel(period)} (no reports)</option>}
          {periods.map((value) => <option key={value} value={value}>{quarterLabel(value)}{left && right && value === plan.latestCommon ? " (latest for both)" : ""}</option>)}
        </select>
      </span></label>
      <button className={styles.button} type="submit">Compare</button>
    </form>
    {validation ? <p className={styles.notice} role="alert">{validation}</p>
      : !left || !right ? <section className={styles.card}><h2 className={styles.cardTitle}>Choose two investors to begin</h2>
        <p className={styles.cardSubtitle}>Compare shared holdings, positions unique to either investor, and portfolio weights. The default is the latest quarter reported by both investors.</p></section>
      : !period ? <p className={styles.notice}>No reporting quarters have been imported for this pair yet.</p>
      : <Suspense key={`${left.id}:${right.id}:${period}:${filter}:${query}:${sort}:${page}`} fallback={<InvestorComparisonLoading />}>
        <InvestorComparison left={left} right={right} period={period} latestCommon={plan.latestCommon} filter={filter} query={query} sort={sort} requestedPage={page} context={context} />
      </Suspense>}
  </main>;
}
