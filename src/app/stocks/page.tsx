import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import styles from "@/components/dashboard/dashboard.module.css";
import { EXCHANGE_NAMES } from "@/lib/stock";
import { getStocks } from "@/lib/stock-data";

export const metadata: Metadata = {
  title: "Stocks",
  description: "Search stocks and see which tracked institutional investors report holding them.",
};

// The stocks we can match to reported holdings, with search by ticker, company name or CUSIP.
export default async function StocksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const stocks = await getStocks();
  const needle = query.toUpperCase();
  // An exact ticker goes straight to its page.
  const exact = stocks.find((stock) => stock.ticker === needle.replace(/[./]/g, "-"));
  if (exact) redirect(`/stocks/${encodeURIComponent(exact.ticker)}`);
  const matches = query
    ? stocks.filter((stock) => stock.ticker.includes(needle) || stock.name.toUpperCase().includes(needle)
      || stock.cusips.some((period) => period.cusip === needle))
    : stocks;

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
          <p className={styles.cardMeta}>{matches.length === 1 ? "1 stock" : `${matches.length} stocks`}</p>
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
        {matches.length === 0 ? (
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
                {matches.map((stock) => (
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
      </section>
    </main>
  );
}
