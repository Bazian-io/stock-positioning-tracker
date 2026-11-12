import styles from "./version-summary.module.css";

// Update this section only with the user's specific permission. Its versions and notes are
// independent of package versions, commits, builds and deployments. See AGENTS.md.
// Each column lists that version's own updates; the rows are not paired with each other.
const PREVIOUS = {
  version: "2.0",
  updates: [
    { title: "Finding information", detail: "Find stocks and investors together through one search." },
    { title: "Investor changes", detail: "See which holdings are new, larger, smaller or no longer reported." },
    { title: "Stock overview", detail: "See clear summaries of who holds a stock and whose holdings changed." },
    { title: "Comparing investors", detail: "Compare two investors side by side and identify their shared holdings." },
    { title: "Returning to research", detail: "Return links preserve your quarter, search and filters." },
    { title: "Missing reports", detail: "Clear messages explain when a report is unavailable and offer another quarter." },
  ],
};
const CURRENT = {
  version: "2.1",
  updates: [
    { title: "Site availability", detail: "Bot protection and clear rules for search engines keep the site available for readers." },
    { title: "Page loading", detail: "Pages load only what you open, and stock pages open faster." },
    { title: "Finding the site", detail: "A site map helps search engines find every stock and investor page." },
  ],
};

export function VersionSummary() {
  const columns = [
    { id: "previous-version", label: "Previous version", tone: styles.previous, ...PREVIOUS },
    { id: "current-version", label: "Current version", tone: styles.current, ...CURRENT },
  ];
  return (
    <section className={styles.section} aria-labelledby="site-version">
      <header className={styles.header}>
        <h2 id="site-version">What&apos;s new in Version {CURRENT.version}</h2>
        <p>
          You&apos;re viewing Version {CURRENT.version}. Each list shows what was added or improved in that version,
          compared with the version before it.
        </p>
      </header>
      <div className={styles.versions}>
        {columns.map(({ id, label, tone, version, updates }) => (
          <section key={id} className={`${styles.version} ${tone}`} aria-labelledby={id}>
            <h3 id={id}>
              {label}
              <span className={styles.badge}>Version {version}</span>
            </h3>
            <ul>
              {updates.map(({ title, detail }) => (
                <li key={title}>
                  <span className={styles.topic}>{title}</span>
                  <p>{detail}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
