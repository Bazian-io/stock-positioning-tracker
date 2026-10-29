import Link from "next/link";
import styles from "@/components/dashboard/dashboard.module.css";

export default function StockNotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.message}>
        <h1>Stock not found</h1>
        <p>That ticker or reporting quarter isn&apos;t in our data. Stocks appear once their CUSIP and ticker have been verified.</p>
        <Link href="/stocks">Browse stocks</Link>
      </div>
    </main>
  );
}
