"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useTransition, type ReactNode } from "react";
import styles from "./dashboard.module.css";

type QuarterNavigationState = {
  pending: boolean;
  navigate: (href: string) => void;
  quarterHref: (reportPeriod: string) => string;
  showQuarter: (reportPeriod: string) => void;
};

const QuarterNavigationContext = createContext<QuarterNavigationState | null>(null);

export function useQuarterNavigation(): QuarterNavigationState {
  const state = use(QuarterNavigationContext);
  if (!state) throw new Error("useQuarterNavigation must be used inside <QuarterNavigation>");
  return state;
}

// Switches quarters through the URL (?quarter=YYYY-MM-DD), so every view can be shared or
// bookmarked. `keep` lists other query parameters that stay when the quarter changes, such as the
// investor selected on a stock page. The current view stays on screen, dimmed, until the next one
// has loaded.
export function QuarterNavigation({ children, keep = {} }: { children: ReactNode; keep?: Record<string, string> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = (href: string) => startTransition(() => router.push(href, { scroll: false }));
  const quarterHref = (reportPeriod: string) => `?${new URLSearchParams({ ...keep, quarter: reportPeriod })}`;
  const showQuarter = (reportPeriod: string) => navigate(quarterHref(reportPeriod));
  return <QuarterNavigationContext value={{ pending, navigate, quarterHref, showQuarter }}>{children}</QuarterNavigationContext>;
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

// A select whose options are links, such as the investor shown on a stock page.
export function LinkSelect({ label, options, selected }: {
  label: string;
  options: { value: string; label: string; href: string }[];
  selected: string;
}) {
  const { navigate } = useQuarterNavigation();
  return (
    <label className={styles.quarterSelect}>
      {label}
      <span className={styles.selectWrap}>
        {/* Remounts with the server's selection after each navigation. */}
        <select
          key={selected}
          defaultValue={selected}
          onChange={(event) => {
            const option = options.find((candidate) => candidate.value === event.target.value);
            if (option) navigate(option.href);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
