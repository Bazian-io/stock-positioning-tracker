import Link from "next/link";
import styles from "@/components/dashboard/dashboard.module.css";

export default function QuarterNotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.message}>
        <h1>Quarter not found</h1>
        <p>That reporting quarter isn&apos;t in the database. Choose one of the quarters listed on the dashboard.</p>
        <Link href="/investors/berkshire-hathaway">View the latest quarter</Link>
      </div>
    </main>
  );
}
