import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import styles from "@/components/dashboard/dashboard.module.css";
import { formatNumber } from "@/lib/portfolio";
import { EXCHANGE_NAMES } from "@/lib/stock";
import { getStock, getStockPage } from "@/lib/stock-data";

export const metadata: Metadata = {
  title: "Stocks",
  description: "Search stocks and see which tracked institutional investors report holding them.",
};

const STOCKS_PER_PAGE = 50;

// The stocks we can match to reported holdings, a page at a time, with search by ticker, company name
// or CUSIP.
export default async function StocksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const pageNumber = typeof page === "string" && /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1;
  // An exact ticker goes straight to its page.
  const ticker = query.toUpperCase().replace(/[./]/g, "-");
  if (/^[A-Z0-9-]{1,10}$/.test(ticker) && (await getStock(ticker))) redirect(`/stocks/${encodeURIComponent(ticker)}`);
  const { stocks, total } = await getStockPage(query, (pageNumber - 1) * STOCKS_PER_PAGE, STOCKS_PER_PAGE);
  if (stocks.length === 0 && pageNumber > 1) notFound();

  // Page links keep the search.
  const pageHref = (number: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (number > 1) params.set("page", String(number));
    return params.size > 0 ? `/stocks?${params}` : "/stocks";
  };
  const pageCount = Math.ceil(total / STOCKS_PER_PAGE);
  const first = (pageNumber - 1) * STOCKS_PER_PAGE + 1;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Stocks</h1>
          <p className={styles.meta}>
            <span>Which tracked investors report holding a stock, quarter by quarter</span>
          </p>
        </div>
      </header>

      <section className={styles.card} aria-labelledby="stock-list">
        <div className={styles.cardHeader}>
          <div>
            <h2 id="stock-list" className={styles.cardTitle}>
              {query ? `Stocks matching “${query}”` : "Stocks"}
            </h2>
            <p className={styles.cardSubtitle}>
              Stocks appear here once their CUSIP and ticker have been verified, so holdings can be matched to them.
              Each share class has its own page.
            </p>
          </div>
          <p className={styles.cardMeta}>{total === 1 ? "1 stock" : `${formatNumber(total)} stocks`}</p>
        </div>
        <form className={styles.search} action="/stocks" role="search">
          <label htmlFor="stock-search" className={styles.visuallyHidden}>
            Search stocks
          </label>
          <input
            id="stock-search"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Ticker, company name or CUSIP"
            className={styles.searchInput}
          />
          <button type="submit" className={styles.button}>
            Search
          </button>
        </form>
        {stocks.length === 0 ? (
          <p className={styles.cardSubtitle}>
            No stock matches “{query}”. <Link href="/stocks">Show all stocks</Link>
          </p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Stocks</caption>
              <thead>
                <tr>
                  <th scope="col">Ticker</th>
                  <th scope="col">Company</th>
                  <th scope="col" className={styles.optional}>Exchange</th>
                  <th scope="col" className={styles.wideOnly}>CUSIP</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((stock) => (
                  <tr key={stock.securityId}>
                    <th scope="row">
                      <Link href={`/stocks/${encodeURIComponent(stock.ticker)}`} className={styles.issuer}>
                        {stock.ticker}
                      </Link>
                    </th>
                    <td className={styles.security}>
                      <span className={styles.issuer}>{stock.name}</span>
                      {stock.shareClass && <span className={styles.securityClass}>{stock.shareClass}</span>}
                    </td>
                    <td className={styles.optional}>{EXCHANGE_NAMES[stock.exchange] ?? stock.exchange}</td>
                    <td className={`${styles.cusip} ${styles.wideOnly}`}>
                      {stock.cusips.filter((period) => period.validTo === null).map((period) => period.cusip).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pageCount > 1 && (
          <nav className={styles.tableLinks} aria-label="Stock list pages">
            <span className={styles.secondary}>
              Stocks {formatNumber(first)}–{formatNumber(first + stocks.length - 1)} of {formatNumber(total)}
            </span>
            {pageNumber > 1 && (
              <Link href={pageHref(pageNumber - 1)} className={styles.tableToggle}>
                ← Previous
              </Link>
            )}
            {pageNumber < pageCount && (
              <Link href={pageHref(pageNumber + 1)} className={styles.tableToggle}>
                Next →
              </Link>
            )}
          </nav>
        )}
      </section>
    </main>
  );
}
