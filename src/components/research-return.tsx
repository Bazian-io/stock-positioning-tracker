import Link from "next/link";
import { detailReturnTarget, returnTarget } from "@/lib/research";
import styles from "./dashboard/dashboard.module.css";

export function ResearchReturn({ from, back }: { from: unknown; back?: unknown }) {
  const target = returnTarget(from);
  const previous = detailReturnTarget(back);
  if (!previous && !target) return null;
  return <nav className={styles.pageActions} aria-label="Return to research">
    {previous && <Link href={previous.href} className={styles.returnLink}>← {previous.label}</Link>}
    {target && <Link href={target.href} className={styles.returnLink}>← {target.label}</Link>}
  </nav>;
}
