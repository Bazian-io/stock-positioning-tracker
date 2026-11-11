import Link from "next/link";
import { COMPARISON_FILTERS, COMPARISON_SORTS, investorComparisonPage, type ComparisonFilter, type ComparisonSort } from "@/lib/investor-comparison";
import { formatNumber, formatPercent, formatUsdCompact, quarterLabel } from "@/lib/portfolio";
import type { Investor } from "@/lib/portfolio-data";
import { getInvestorComparison } from "@/lib/portfolio-changes-data";
import { researchHref } from "@/lib/research";
import { uncertainZero, type QuarterHolding } from "@/lib/stock";
import styles from "./dashboard.module.css";
import comparison from "./investor-comparison.module.css";

export function InvestorComparisonLoading() {
  return <section className={styles.card} aria-busy="true" aria-label="Investor comparison">
    <h2 className={styles.cardTitle}>Comparing reported portfolios</h2>
    <p className={styles.cardSubtitle} role="status">Loading both investors’ long share positions…</p>
  </section>;
}

function Holding({ value, weight }: { value: QuarterHolding; weight: number | null }) {
  if (value.state !== "held") return <span>{value.state === "no-report" ? "No report" : value.state === "unclear" ? "Unclear identity" : uncertainZero(value) ? "Uncertain" : "Not reported"}</span>;
  return <>
    <strong className={comparison.positionWeight}>{weight === null ? "—" : formatPercent(weight)}</strong>
    <span className={styles.securityClass}>{formatNumber(value.shares)} shares</span>
    <span className={styles.securityClass}>{formatUsdCompact(value.valueUsd)}</span>
  </>;
}

export async function InvestorComparison({ left, right, period, latestCommon, filter, query, sort, requestedPage, context }: {
  left: Investor; right: Investor; period: string; latestCommon?: string;
  filter: ComparisonFilter; query: string; sort: ComparisonSort; requestedPage: number; context: Record<string, string>;
}) {
  const base = { ...context, a: left.slug, b: right.slug, quarter: period };
  const href = (selection = filter, page = 1, search = query, order = sort) => researchHref("/compare", {
    ...base, filter: selection, q: search, sort: order, page: page > 1 ? String(page) : undefined,
  });
  let data: Awaited<ReturnType<typeof getInvestorComparison>>;
  try {
    data = await getInvestorComparison(left.id, right.id, period);
  } catch {
    return <section className={styles.card} role="alert"><h2 className={styles.cardTitle}>Comparison unavailable</h2>
      <p className={styles.emptyState}>The holdings couldn&apos;t be loaded. <a href={href(filter, requestedPage)}>Try again</a>.</p>
    </section>;
  }
  const { rows, leftReport, rightReport } = data;
  const comparable = Boolean(leftReport && rightReport);
  const { rows: shown, total, counts, sharedWeights, pageCount, page, start } = investorComparisonPage(rows, filter, query, sort, requestedPage);
  const labels: Record<ComparisonFilter, string> = {
    all: "All holdings", shared: "Shared holdings", "left-only": `${left.name} only`, "right-only": `${right.name} only`, unclear: "Unclear comparisons",
  };
  const from = `${href(filter, page)}#comparison-holdings`;
  const weightInShared = (side: "leftWeight" | "rightWeight") => comparable
    ? formatPercent(sharedWeights[side]) : "—";

  return <>
    {!comparable && <p className={styles.notice} role="status">
      <span>{[...(!leftReport ? [left.name] : []), ...(!rightReport ? [right.name] : [])].join(" and ")} {leftReport || rightReport ? "has" : "have"} no {quarterLabel(period)} report imported. Holdings and overlap for the missing side are unknown.</span>
      {latestCommon && latestCommon !== period && <Link href={researchHref("/compare", { ...base, quarter: latestCommon })}>Use {quarterLabel(latestCommon)}, latest for both →</Link>}
    </p>}
    <div className={comparison.portfolios} aria-label="Reported portfolio summaries">
      {([{ investor: left, report: leftReport, side: "leftWeight", letter: "A" }, { investor: right, report: rightReport, side: "rightWeight", letter: "B" }] as const).map(({ investor, report, side, letter }) => (
        <section key={investor.id} className={`${styles.card} ${comparison.summary}`} aria-label={`${investor.name} summary`}>
          <p className={styles.label}>Investor {letter} · {quarterLabel(period)}</p>
          <h2 className={styles.cardTitle}><Link href={researchHref(`/investors/${investor.slug}`, { quarter: period, from })}>{investor.name}</Link></h2>
          <p className={comparison.portfolioValue}>{report ? formatUsdCompact(report.valueUsd) : "No report"}</p>
          <p className={styles.note}>Reported 13F value · USD</p>
          <p className={styles.cardSubtitle}>Weight in known shared holdings <strong>{weightInShared(side)}</strong></p>
          {report?.confidentialOmissions && <p className={styles.note}>This report omits some confidential holdings.</p>}
        </section>
      ))}
    </div>
    <section className={styles.card} aria-labelledby="comparison-holdings">
      <div className={styles.cardHeader}>
        <div><h2 id="comparison-holdings" className={styles.cardTitle}>Portfolio overlap, {quarterLabel(period)}</h2>
          <p className={styles.cardSubtitle}>Compare the same quarter. Weights use each investor&apos;s full reported 13F value.</p></div>
      </div>
      <nav className={styles.changeSummary} aria-label="Portfolio overlap summary">
        {COMPARISON_FILTERS.filter((value) => value !== "all").map((value) => (
          <Link key={value} href={`${href(value)}#comparison-holdings`} className={styles.changeTile} aria-current={filter === value ? "true" : undefined}>
            <span>{labels[value]}</span><strong>{comparable ? formatNumber(counts[value]) : "—"}</strong>
          </Link>
        ))}
      </nav>
      <nav className={styles.changeFilters} aria-label="All comparison holdings"><Link href={`${href("all")}#comparison-holdings`} className={styles.pageLink} aria-current={filter === "all" ? "true" : undefined}>All holdings <span>{formatNumber(counts.all)}</span></Link></nav>
      <form className={styles.tableControls} action="/compare#comparison-holdings" role="search" aria-label="Search comparison holdings">
        {Object.entries({ ...base, filter }).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <label className={styles.searchField}>Search holdings<input name="q" type="search" defaultValue={query} maxLength={100} placeholder="Security, ticker or CUSIP" className={styles.searchInput} /></label>
        <label className={styles.quarterSelect}>Sort by<span className={styles.selectWrap}><select name="sort" defaultValue={sort}>
          {COMPARISON_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></span></label>
        <button className={styles.button} type="submit">Apply</button>
        {query && <Link href={`${href(filter, 1, "")}#comparison-holdings`} className={styles.tableToggle}>Clear search</Link>}
      </form>
      {shown.length === 0 ? <p className={styles.emptyState}>
        {!comparable ? "A report for each investor is needed to establish shared or unique holdings. Choose All holdings to inspect the available side."
          : query ? "No positions match this search and filter." : rows.length === 0 ? "Neither report contains long share positions to compare." : "No confirmed positions in this group."}
        {rows.length > 0 && <> <Link href={`${href("all", 1, "")}#comparison-holdings`}>Show all holdings</Link>.</>}
      </p> : <div className={styles.tableScroll}>
        <table className={`${styles.table} ${styles.holderTable} ${comparison.table}`} role="table">
          <caption className={styles.visuallyHidden}>{left.name} and {right.name}, {quarterLabel(period)}. Shares, market value and full-portfolio weight.</caption>
          <thead><tr><th scope="col">Security</th><th scope="col" className={styles.numeric}>A · {left.name}</th><th scope="col" className={styles.numeric}>B · {right.name}</th><th scope="col" className={styles.numeric}>Weight gap<br />A − B</th></tr></thead>
          <tbody>{shown.map((row) => <tr key={row.id} data-comparison-category={row.category}>
            <th scope="row" className={`${styles.security} ${styles.wrapping}`}>
              {row.ticker ? <Link href={researchHref(`/stocks/${encodeURIComponent(row.ticker)}`, { quarter: period, investor: row.left.state === "held" ? left.slug : right.slug, from })} className={styles.issuer}>{row.name}</Link> : <span className={styles.issuer}>{row.name}</span>}
              <span className={styles.securityClass}>{row.ticker ?? (row.cusips.length ? row.cusips.join(", ") : "Missing CUSIP")} · {labels[row.category]}</span>
              {row.category === "unclear" && <span className={styles.securityClass}>A missing report, confidential omission or unconfirmed identity prevents a complete comparison.</span>}
            </th>
            <td className={styles.numeric} data-label={`A · ${left.name}`}><Holding value={row.left} weight={row.leftWeight} /></td>
            <td className={styles.numeric} data-label={`B · ${right.name}`}><Holding value={row.right} weight={row.rightWeight} /></td>
            <td className={`${styles.numeric} ${styles.changeCell}`} data-label="Weight gap · A − B">
              {row.weightGap === null ? "—" : `${row.weightGap > 0 ? "+" : row.weightGap < 0 ? "−" : ""}${formatPercent(Math.abs(row.weightGap)).replace("%", " pp")}`}
            </td>
          </tr>)}</tbody>
        </table>
      </div>}
      <nav className={styles.pagination} aria-label="Comparison holding pages">
        <span className={styles.secondary}>{total ? `${formatNumber(start + 1)}–${formatNumber(start + shown.length)} of ${formatNumber(total)}` : "0"} · {labels[filter]}</span>
        <div className={styles.pageActions}><span className={styles.secondary}>Page {formatNumber(page)} of {formatNumber(pageCount)}</span>
          {page > 1 && <Link href={`${href(filter, page - 1)}#comparison-holdings`} className={styles.pageLink}>← Previous</Link>}
          {page < pageCount && <Link href={`${href(filter, page + 1)}#comparison-holdings`} className={styles.pageLink}>Next →</Link>}
        </div>
      </nav>
      <details className={styles.disclosure}><summary>How this comparison works</summary>
        <p className={styles.cardSubtitle}>Only reported long share positions are compared. Options and principal amounts are excluded here but remain in the full portfolio value used for weights.
          Verified CUSIPs are joined only within their recorded dates; unlinked securities match only by exact CUSIP, and share classes stay separate.
          An absent holding is unique only when the other investor has a report without confidential omissions. Missing and uncertain holdings remain unknown.
          The weight gap is in percentage points (pp), A minus B. Shared weights count only known shared holdings. These snapshots describe reported positioning, not investment performance.</p>
      </details>
    </section>
  </>;
}
