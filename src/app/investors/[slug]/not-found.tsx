import Link from "next/link";
import styles from "@/components/dashboard/dashboard.module.css";

// Not-found pages receive no props, so this page can't link back to the requested investor.
export default function InvestorNotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.message}>
        <h1>Not found</h1>
        <p>That investor or reporting quarter isn&apos;t in the database. Choose an investor, then one of its quarters.</p>
        <Link href="/investors">Browse all investors</Link>
      </div>
    </main>
  );
}
