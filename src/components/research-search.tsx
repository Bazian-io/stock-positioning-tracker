import dashboard from "@/components/dashboard/dashboard.module.css";
import styles from "./research.module.css";

export function ResearchSearch({ query = "", quarter }: { query?: string; quarter?: string }) {
  return (
    <form action="/search" role="search" aria-label="Search stocks and investors" className={styles.searchForm}>
      <label htmlFor="research-search" className={styles.searchLabel}>Find a stock or investor</label>
      {quarter && <input type="hidden" name="quarter" value={quarter} />}
      <div className={styles.searchRow}>
        <input id="research-search" name="q" type="search" defaultValue={query} maxLength={100}
          placeholder="AAPL, Apple or Berkshire Hathaway" className={dashboard.searchInput} />
        <button type="submit" className={dashboard.button}>Search</button>
      </div>
      <p className={dashboard.note}>Search by ticker, company, investor name, CUSIP or investor CIK.</p>
    </form>
  );
}
