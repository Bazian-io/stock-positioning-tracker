import type { Metadata } from "next";
import Link from "next/link";
import styles from "@/components/dashboard/dashboard.module.css";

export const metadata: Metadata = {
  title: "Stocks",
  description: "Stock Analysis: which tracked institutional investors own each stock. In development.",
};

// Placeholder for the Stock Analysis section, which needs holdings mapped to stocks first.
export default function StocksPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Stocks</h1>
          <p className={styles.meta}>
            <span>Stock Analysis is in development</span>
          </p>
        </div>
      </header>

      <section className={styles.card} aria-labelledby="planned">
        <div>
          <h2 id="planned" className={styles.cardTitle}>
            What this section will show
          </h2>
          <ul className={styles.notes}>
            <li>Browse and search the stocks that tracked investors report on Form 13F.</li>
            <li>See which tracked investors own each stock, and how their reported holdings change across quarters.</li>
            <li>Short-interest history alongside institutional ownership.</li>
          </ul>
        </div>
        <p className={styles.cardSubtitle}>
          Until then, <Link href="/investors">browse the tracked investors</Link> and their holdings.
        </p>
      </section>
    </main>
  );
}
