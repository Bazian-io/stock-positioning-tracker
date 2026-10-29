"use client"; // Error boundaries must be Client Components.

import styles from "@/components/dashboard/dashboard.module.css";

export default function InvestorsError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className={styles.page}>
      <div className={styles.message} role="alert">
        <h1>The investor list couldn&apos;t be loaded</h1>
        <p>The database didn&apos;t respond as expected. This is usually temporary.</p>
        <button type="button" className={styles.button} onClick={() => retry()}>
          Try again
        </button>
      </div>
    </main>
  );
}
