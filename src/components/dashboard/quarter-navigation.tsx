"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useTransition, type ReactNode } from "react";
import styles from "./dashboard.module.css";

type QuarterNavigationState = { pending: boolean; showQuarter: (reportPeriod: string) => void };

const QuarterNavigationContext = createContext<QuarterNavigationState | null>(null);

export function useQuarterNavigation(): QuarterNavigationState {
  const state = use(QuarterNavigationContext);
  if (!state) throw new Error("useQuarterNavigation must be used inside <QuarterNavigation>");
  return state;
}

// Switches quarters through the URL (?quarter=YYYY-MM-DD), so every view can be shared or
// bookmarked. The current view stays on screen, dimmed, until the next quarter has loaded.
export function QuarterNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const showQuarter = (reportPeriod: string) =>
    startTransition(() => router.push(`?quarter=${encodeURIComponent(reportPeriod)}`, { scroll: false }));
  return <QuarterNavigationContext value={{ pending, showQuarter }}>{children}</QuarterNavigationContext>;
}

export function PendingFrame({ children }: { children: ReactNode }) {
  const { pending } = useQuarterNavigation();
  return (
    <div className={styles.frame} data-pending={pending || undefined} aria-busy={pending}>
      {children}
    </div>
  );
}

export function QuarterSelect({ quarters, selected }: { quarters: { value: string; label: string }[]; selected: string }) {
  const { showQuarter } = useQuarterNavigation();
  return (
    <label className={styles.quarterSelect}>
      Reporting quarter
      <span className={styles.selectWrap}>
        {/* Remounts with the server's selection after each navigation. */}
        <select key={selected} defaultValue={selected} onChange={(event) => showQuarter(event.target.value)}>
          {quarters.map((quarter) => (
            <option key={quarter.value} value={quarter.value}>
              {quarter.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
