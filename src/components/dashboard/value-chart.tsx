"use client";

import type { CSSProperties, MouseEvent } from "react";
import styles from "./dashboard.module.css";
import { useQuarterNavigation } from "./quarter-navigation";

export type ChartQuarter = {
  reportPeriod: string;
  label: string; // "Q2 2026"
  quarter: number;
  year: number;
  valueLabel: string; // "$299.25B"
  height: number; // Bar height, percent of the plot.
  description: string; // Accessible name, e.g. "Q2 2026: $299.25B reported".
  details: string[]; // Further tooltip lines.
  state?: "zero" | "missing"; // A reported zero, or no report: drawn differently from a bar.
};

export type ChartTick = { label: string; position: number };

// A value per quarter as columns: the selected quarter in the accent color, the others in a
// recessive gray. A reported zero is a flat mark and a missing report a hatched column, so neither
// reads as the other. Each column is a link to its quarter, with a tooltip on hover and focus.
export function ValueChart({ quarters, ticks, selected }: { quarters: ChartQuarter[]; ticks: ChartTick[]; selected: string }) {
  const { quarterHref, showQuarter } = useQuarterNavigation();

  function onClick(event: MouseEvent<HTMLAnchorElement>, reportPeriod: string) {
    // Let modified clicks open the link in a new tab or window.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showQuarter(reportPeriod);
  }

  return (
    <div className={styles.chart}>
      <div className={styles.plot}>
        {ticks.map((tick) => (
          <div key={tick.label} className={styles.gridline} style={{ bottom: `${tick.position}%` }} aria-hidden="true">
            <span>{tick.label}</span>
          </div>
        ))}
        <ol className={styles.columns}>
          {quarters.map((quarter, index) => {
            const isSelected = quarter.reportPeriod === selected;
            // Tooltips in the outer thirds open inward, so they stay inside the chart.
            const edge = index < quarters.length / 3 ? "start" : index >= (quarters.length * 2) / 3 ? "end" : undefined;
            // The value label clears the neighboring bars, which may be taller.
            const labelHeight = Math.max(...quarters.slice(Math.max(0, index - 1), index + 2).map((neighbor) => neighbor.height));
            return (
              <li key={quarter.reportPeriod} className={styles.column} data-edge={edge}>
                <a
                  href={quarterHref(quarter.reportPeriod)}
                  className={styles.columnLink}
                  style={{ "--bar": `${quarter.height}%` } as CSSProperties}
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={quarter.description}
                  onClick={(event) => onClick(event, quarter.reportPeriod)}
                >
                  <span className={styles.bar} data-selected={isSelected || undefined} data-state={quarter.state} />
                  {isSelected && (
                    <span className={styles.capLabel} style={{ bottom: `calc(${labelHeight}% + 6px)` }} aria-hidden="true">
                      {quarter.valueLabel}
                    </span>
                  )}
                  <span className={styles.tooltip} aria-hidden="true">
                    <strong>{quarter.valueLabel}</strong>
                    {quarter.details.map((detail) => (
                      <span key={detail}>{detail}</span>
                    ))}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </div>
      <ol className={styles.xAxis} aria-hidden="true">
        {quarters.map((quarter, index) => (
          <li key={quarter.reportPeriod} data-selected={quarter.reportPeriod === selected || undefined}>
            <span className={styles.xQuarter}>Q{quarter.quarter}</span>
            <span className={styles.xYear} data-partial={(index === 0 && quarter.quarter !== 1) || undefined}>
              {quarter.quarter === 1 || index === 0 ? quarter.year : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
