import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import dashboard from "@/components/dashboard/dashboard.module.css";
import styles from "@/components/research.module.css";
import { ResearchSearch } from "@/components/research-search";
import { formatNumber, formatUsdCompact, quarterLabel } from "@/lib/portfolio";
import { getInvestorSummaries } from "@/lib/portfolio-data";
import { matchingInvestors, reportingQuarter, researchHref, resultPage, searchQuery, type ResearchParams } from "@/lib/research";
import { getStockPage } from "@/lib/stock-data";

export const metadata: Metadata = { title: "Search", description: "Find stocks and institutional investors in the reported 13F data." };
const STOCKS_PER_PAGE = 20;

async function SearchResults({ query, quarter, page }: { query: string; quarter?: string; page: number }) {
  const [investorResult, stockResult] = await Promise.allSettled([
    getInvestorSummaries(), getStockPage(query, (page - 1) * STOCKS_PER_PAGE, STOCKS_PER_PAGE),
  ]);
  const investors = investorResult.status === "fulfilled" ? matchingInvestors(investorResult.value, query) : [];
  const stocks = stockResult.status === "fulfilled" ? stockResult.value.stocks : [];
  const totalStocks = stockResult.status === "fulfilled" ? stockResult.value.total : 0;
  const pageHref = (number: number) => researchHref("/search", { q: query, quarter, page: number > 1 ? String(number) : undefined });
  const resultsHref = pageHref(page);

  return (
    <div className={styles.results} id="search-results">
      <section className={dashboard.card} aria-labelledby="stock-results">
        <div className={dashboard.cardHeader}>
          <h2 id="stock-results" className={dashboard.cardTitle}>Stocks</h2>
          {stockResult.status === "fulfilled" && <span className={dashboard.cardMeta}>{formatNumber(totalStocks)} {totalStocks === 1 ? "match" : "matches"}</span>}
        </div>
        {stockResult.status === "rejected" ? <p className={dashboard.emptyState} role="alert">Stock results couldn&apos;t be loaded. <a href={resultsHref}>Try again</a>.</p>
          : stocks.length === 0 ? <p className={dashboard.emptyState}>{page > 1 && totalStocks > 0 ? <>No stocks on this page. <Link href={pageHref(1)}>Return to the first page</Link>.</> : "No verified stock matches. Try its ticker, company name or CUSIP."}</p>
          : <ul className={styles.resultList}>
            {stocks.map((stock) => (
              <li key={stock.securityId}>
                <Link id={`stock-${stock.ticker}`} className={styles.resultLink} href={researchHref(`/stocks/${encodeURIComponent(stock.ticker)}`, {
                  quarter, from: `${resultsHref}#stock-${stock.ticker}`,
                })}>
                  <strong>{stock.ticker} · {stock.name}</strong>
                  <span className={dashboard.note}>{stock.shareClass ?? "Verified stock"} · Explore tracked ownership</span>
                </Link>
              </li>
            ))}
          </ul>}
        {stocks.length > 0 && totalStocks > STOCKS_PER_PAGE && <nav className={dashboard.pagination} aria-label="Stock search pages">
          <span className={dashboard.secondary}>Page {formatNumber(page)} of {formatNumber(Math.ceil(totalStocks / STOCKS_PER_PAGE))}</span>
          <div className={dashboard.pageActions}>
            {page > 1 && <Link href={`${pageHref(page - 1)}#stock-results`} className={dashboard.pageLink}>← Previous</Link>}
            {page * STOCKS_PER_PAGE < totalStocks && <Link href={`${pageHref(page + 1)}#stock-results`} className={dashboard.pageLink}>Next →</Link>}
          </div>
        </nav>}
      </section>
      <section className={dashboard.card} aria-labelledby="investor-results">
        <div className={dashboard.cardHeader}>
          <h2 id="investor-results" className={dashboard.cardTitle}>Investors</h2>
          {investorResult.status === "fulfilled" && <span className={dashboard.cardMeta}>{formatNumber(investors.length)} {investors.length === 1 ? "match" : "matches"}</span>}
        </div>
        {investorResult.status === "rejected" ? <p className={dashboard.emptyState} role="alert">Investor results couldn&apos;t be loaded. <a href={resultsHref}>Try again</a>.</p>
          : investors.length === 0 ? <p className={dashboard.emptyState}>No tracked investor matches. Try its name or SEC CIK.</p>
          : <ul className={styles.resultList}>
            {investors.map((investor) => {
              const period = quarter ?? investor.latestQuarter;
              const value = investor.values.find((summary) => summary.reportPeriod === period);
              return (
                <li key={investor.id}>
                  <Link id={`investor-${investor.slug}`} className={styles.resultLink} href={researchHref(`/investors/${investor.slug}`, {
                    quarter, from: `${resultsHref}#investor-${investor.slug}`,
                  })}>
                    <strong>{investor.name}</strong>
                    <span className={dashboard.note}>{period ? `${quarterLabel(period)} · ${value ? `${formatUsdCompact(value.valueUsd)} reported` : "No report imported"}` : "No quarters imported"}</span>
                  </Link>
                </li>
              );
            })}
          </ul>}
      </section>
    </div>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<ResearchParams> }) {
  const params = await searchParams;
  const query = searchQuery(params.q);
  const quarter = reportingQuarter(params.quarter);
  const page = resultPage(params.page);
  return (
    <main className={dashboard.page}>
      <header>
        <h1 className={dashboard.title}>Search stocks &amp; investors</h1>
        <p className={dashboard.meta}>{quarter ? `Researching ${quarterLabel(quarter)}. Missing reports are marked as unavailable.` : "Start with a company, ticker or investor. Each result opens its reported holdings."}</p>
      </header>
      <ResearchSearch key={`${query}:${quarter ?? ""}`} query={query} quarter={quarter} />
      {query ? <>
        <p className={dashboard.note}>Results for &ldquo;{query}&rdquo;</p>
        <Suspense key={`${query}:${quarter}:${page}`} fallback={<p role="status" className={dashboard.cardSubtitle}>Finding stocks and investors…</p>}>
          <SearchResults query={query} quarter={quarter} page={page} />
        </Suspense>
      </> : <p className={dashboard.cardSubtitle}>Enter a name or identifier to search, or browse the research sections below.</p>}
      <nav className={dashboard.pageActions} aria-label="Browse research">
        <Link href={researchHref("/stocks", { quarter })}>Browse all stocks →</Link>
        <Link href={researchHref("/investors", { quarter })}>Browse all investors →</Link>
      </nav>
    </main>
  );
}
