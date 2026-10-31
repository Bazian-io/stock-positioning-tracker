"use client";

import styles from "@/components/dashboard/dashboard.module.css";

export default function ComparisonError({ retry }: { error: unknown; retry: () => void }) {
  return <main className={styles.page}><div className={styles.message} role="alert">
    <h1>The investor comparison couldn&apos;t be loaded</h1>
    <p>The database didn&apos;t respond as expected. Please try again.</p>
    <button className={styles.button} type="button" onClick={() => retry()}>Try again</button>
  </div></main>;
}
