import Link from "next/link";
import { formatNumber, formatPercent, formatUsd, formatUsdCompact, type Position } from "@/lib/portfolio";
import type { StockLink } from "@/lib/stock-data";
import styles from "./dashboard.module.css";

const OPTION_LABELS: Record<string, string> = { put: "Put option", call: "Call option" };

// keepScroll: stay at the same place on the page, e.g. when expanding the table.
export type TableLink = { href: string; label: string; keepScroll?: boolean };

type HoldingsTableProps = {
  positions: Position[]; // The positions shown, in the selected sort order.
  firstRank: number; // Row number of the first position in the current results.
  largestShare: number; // The quarter's largest portfolio share.
  caption: string;
  links: TableLink[];
  status?: string; // e.g. "Positions 201–400 of 5,696".
  pageLabel?: string;
  stocks: Record<string, StockLink>; // Ticker and readable name by CUSIP, for positions with a stock page.
};

// Share bars are scaled to the quarter's largest position; the
// percentages are shares of the quarter's total reported value.
// Positions in an identified stock show the stock's readable name and ticker, with the name as filed on
// hover; others show the name as filed.
export function HoldingsTable({ positions, firstRank, largestShare, caption, links, status, pageLabel, stocks }: HoldingsTableProps) {
  return (
    <>
      <div className={styles.tableScroll}>
        <table className={`${styles.table} ${styles.holdingsTable}`} role="table">
          <caption className={styles.visuallyHidden}>{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.rank} aria-label="Row number">#</th>
              <th scope="col">Security</th>
              <th scope="col" className={styles.wideOnly}>CUSIP</th>
              <th scope="col" className={`${styles.numeric} ${styles.optional}`}>Shares</th>
              <th scope="col" className={styles.numeric}>Reported value</th>
              <th scope="col" className={styles.numeric}>Share of portfolio</th>
              <th scope="col" className={`${styles.numeric} ${styles.wideOnly}`}>Filing rows</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position, index) => {
              const stock = position.cusip ? stocks[position.cusip] : undefined;
              const filed = [position.issuer, position.titleOfClass].filter(Boolean).join(" ");
              return (
              <tr key={[position.cusip, position.issuer, position.titleOfClass, position.positionType, position.quantityType].join("|")}>
                <td className={styles.rank}>{formatNumber(firstRank + index)}</td>
                <th scope="row" className={styles.security}>
                  {stock ? (
                    <Link href={`/stocks/${encodeURIComponent(stock.ticker)}`} className={styles.issuer} title={`Filed as ${filed}`}>
                      {stock.name}
                    </Link>
                  ) : (
                    <span className={styles.issuer}>{position.issuer}</span>
                  )}
                  <span className={styles.securityClass}>
                    {[stock ? stock.ticker : position.titleOfClass, OPTION_LABELS[position.positionType]].filter(Boolean).join(" · ")}
                  </span>
                </th>
                <td className={`${styles.cusip} ${styles.wideOnly}`}>{position.cusip ?? "—"}</td>
                <td className={`${styles.numeric} ${styles.optional}`}>
                  {formatNumber(position.shares)}
                  {position.quantityType === "PRN" && " principal"}
                </td>
                <td className={styles.numeric} data-label="Reported value" title={formatUsd(position.valueUsd)}>
                  {formatUsdCompact(position.valueUsd)}
                </td>
                <td className={styles.numeric} data-label="Share of portfolio">
                  <span className={styles.share}>
                    <span className={styles.shareTrack} aria-hidden="true">
                      <span
                        className={styles.shareBar}
                        style={{ width: `${largestShare > 0 ? (position.portfolioShare / largestShare) * 100 : 0}%` }}
                      />
                    </span>
                    <span className={styles.shareValue}>{formatPercent(position.portfolioShare)}</span>
                  </span>
                </td>
                <td className={`${styles.numeric} ${styles.secondary} ${styles.wideOnly}`}>{position.rowCount}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(status || links.length > 0) && (
        <nav className={styles.pagination} aria-label="Holdings pages">
          {status && <span className={styles.secondary}>{status}</span>}
          <div className={styles.pageActions}>
            {pageLabel && <span className={styles.secondary}>{pageLabel}</span>}
            {links.map((link) => (
              <Link key={link.label} href={link.href} scroll={link.keepScroll ? false : undefined} className={styles.pageLink}>
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </>
  );
}
