import { formatUsdCompact, quarterLabel } from "@/lib/portfolio";
import styles from "./dashboard.module.css";

const WIDTH = 120;
const HEIGHT = 32;
const PAD = 4; // Room for the latest quarter's dot.

type SparklineProps = { values: { reportPeriod: string; valueUsd: number }[] }; // Oldest first.

// A small line of an investor's reported portfolio value by quarter, on its own scale, with the latest
// quarter marked in the accent. Hovering anywhere above a quarter shows its value.
export function ValueSparkline({ values }: SparklineProps) {
  if (values.length < 2) return <span className={styles.secondary}>{values.length === 1 ? "1 quarter" : "—"}</span>;
  const amounts = values.map((quarter) => quarter.valueUsd);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const step = (WIDTH - 2 * PAD) / (values.length - 1);
  const x = (index: number) => PAD + index * step;
  const y = (value: number) => (max === min ? HEIGHT / 2 : PAD + (1 - (value - min) / (max - min)) * (HEIGHT - 2 * PAD));
  const first = values[0];
  const last = values[values.length - 1];
  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={`Reported value by quarter: ${quarterLabel(first.reportPeriod)} ${formatUsdCompact(first.valueUsd)}, `
        + `${quarterLabel(last.reportPeriod)} ${formatUsdCompact(last.valueUsd)}`}
    >
      <polyline className={styles.sparklineLine} points={values.map((quarter, index) => `${x(index)},${y(quarter.valueUsd)}`).join(" ")} />
      <circle className={styles.sparklineLatest} cx={x(values.length - 1)} cy={y(last.valueUsd)} r={3} />
      {values.map((quarter, index) => (
        <rect key={quarter.reportPeriod} className={styles.sparklineHit} x={x(index) - step / 2} y={0} width={step} height={HEIGHT}>
          <title>{`${quarterLabel(quarter.reportPeriod)}: ${formatUsdCompact(quarter.valueUsd)}`}</title>
        </rect>
      ))}
    </svg>
  );
}
