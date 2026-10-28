import Link from "next/link";
import { formatNumber, formatPercent, formatUsd, formatUsdCompact, type Position } from "@/lib/portfolio";
import styles from "./dashboard.module.css";

const OPTION_LABELS: Record<string, string> = { put: "Put option", call: "Call option" };

type HoldingsTableProps = {
  positions: Position[];
  caption: string;
  limit: number;
  showAll: boolean;
  toggleHref: string;
};

// Largest positions first. Share bars are scaled to the largest position; the percentages are
// shares of the quarter's total reported value.
export function HoldingsTable({ positions, caption, limit, showAll, toggleHref }: HoldingsTableProps) {
  const visible = showAll ? positions : positions.slice(0, limit);
  const largestShare = positions[0]?.portfolioShare || 1;
  return (
    <>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.rank}>#</th>
              <th scope="col">Security, as reported</th>
              <th scope="col" className={styles.wideOnly}>CUSIP</th>
              <th scope="col" className={`${styles.numeric} ${styles.optional}`}>Shares</th>
              <th scope="col" className={styles.numeric}>Reported value</th>
              <th scope="col" className={styles.numeric}>Share of portfolio</th>
              <th scope="col" className={`${styles.numeric} ${styles.wideOnly}`}>Filing rows</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((position, index) => (
              <tr key={[position.cusip, position.issuer, position.positionType, position.quantityType].join("|")}>
                <td className={styles.rank}>{index + 1}</td>
                <th scope="row" className={styles.security}>
                  <span className={styles.issuer}>{position.issuer}</span>
                  <span className={styles.securityClass}>
                    {[position.titleOfClass, OPTION_LABELS[position.positionType]].filter(Boolean).join(" · ")}
                  </span>
                </th>
                <td className={`${styles.cusip} ${styles.wideOnly}`}>{position.cusip ?? "—"}</td>
                <td className={`${styles.numeric} ${styles.optional}`}>
                  {formatNumber(position.shares)}
                  {position.quantityType === "PRN" && " principal"}
                </td>
                <td className={styles.numeric} title={formatUsd(position.valueUsd)}>
                  {formatUsdCompact(position.valueUsd)}
                </td>
                <td className={styles.numeric}>
                  <span className={styles.share}>
                    <span className={styles.shareTrack} aria-hidden="true">
                      <span className={styles.shareBar} style={{ width: `${(position.portfolioShare / largestShare) * 100}%` }} />
                    </span>
                    <span className={styles.shareValue}>{formatPercent(position.portfolioShare)}</span>
                  </span>
                </td>
                <td className={`${styles.numeric} ${styles.secondary} ${styles.wideOnly}`}>{position.rowCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {positions.length > limit && (
        <Link href={toggleHref} scroll={false} className={styles.tableToggle}>
          {showAll ? `Show the top ${limit}` : `Show all ${positions.length} positions`}
        </Link>
      )}
    </>
  );
}
