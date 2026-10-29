import Link from "next/link";

export default function HomePage() {
  return (
    <main className="home">
      <p className="eyebrow">Investment research</p>
      <h1>Stock Positioning Tracker</h1>
      <p className="description">
        How major institutional investors are positioned in U.S. stocks, from their quarterly SEC Form 13F
        filings.
      </p>
      <h2 className="home-section">Research sections</h2>
      <div className="section-cards">
        <Link href="/investors" className="section-card">
          <span className="section-name">Investor Analysis</span>
          <span className="section-detail">
            Browse tracked institutional investors, their reported holdings and how their portfolios change
            from quarter to quarter.
          </span>
          <span className="section-arrow" aria-hidden="true">
            →
          </span>
        </Link>
        <Link href="/stocks" className="section-card">
          <span className="section-name">
            Stock Analysis <span className="section-status">In development</span>
          </span>
          <span className="section-detail">
            See which tracked investors own a stock and how their reported holdings change across quarters,
            alongside short interest.
          </span>
          <span className="section-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      </div>
    </main>
  );
}
