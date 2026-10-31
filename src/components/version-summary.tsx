import styles from "./version-summary.module.css";

// Update this section only with the user's specific permission. Its version and notes are
// independent of package versions, commits, builds and deployments. See AGENTS.md.
const VERSION = "2.0";
const CHANGES = [
  {
    title: "Finding information",
    previous: "Search for stocks and browse investors separately.",
    current: "Find stocks and investors together through one search.",
  },
  {
    title: "Investor changes",
    previous: "Compare quarterly holdings yourself to understand the differences.",
    current: "See which holdings are new, larger, smaller or no longer reported.",
  },
  {
    title: "Stock overview",
    previous: "Scan the investor table to understand activity.",
    current: "See clear summaries of who holds a stock and whose holdings changed.",
  },
  {
    title: "Comparing investors",
    previous: "Open separate portfolio pages.",
    current: "Compare two investors side by side and identify their shared holdings.",
  },
  {
    title: "Returning to research",
    previous: "Some links reset your selected quarter or search.",
    current: "Return links preserve your quarter, search and filters.",
  },
  {
    title: "Missing reports",
    previous: "An unavailable quarter could look like a missing page.",
    current: "Clear messages explain when a report is unavailable and offer another quarter.",
  },
];

export function VersionSummary() {
  return (
    <section className={styles.section} aria-labelledby="site-version">
      <header className={styles.header}>
        <h2 id="site-version">You&apos;re viewing Version {VERSION}</h2>
        <p>What&apos;s improved since the previous version.</p>
      </header>
      <table className={styles.comparison} role="table">
        <caption className={styles.visuallyHidden}>Previous version compared with Version {VERSION}</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader" className={styles.previous}>Previous version</th>
            <th scope="col" role="columnheader" className={styles.current}>Current version · {VERSION}</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {CHANGES.map(({ title, previous, current }) => (
            <tr key={title} role="row">
              <th scope="row" role="rowheader" className={styles.previous} data-label="Previous version">
                <span className={styles.topic}>{title}</span>
                <p>{previous}</p>
              </th>
              <td role="cell" className={styles.current} data-label={`Version ${VERSION}`}>
                <span className={styles.topic} aria-hidden="true">{title}</span>
                <p>{current}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
