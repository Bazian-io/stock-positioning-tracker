import Link from "next/link";

export default function HomePage() {
  return (
    <main className="home">
      <p className="eyebrow">Investment research</p>
      <h1>Stock Positioning Tracker</h1>
      <p className="description">
        Quarterly institutional holdings, as reported to the SEC on Form 13F.
      </p>
      <h2 className="home-section">Investors</h2>
      <Link href="/investors/berkshire-hathaway" className="investor-card">
        <span className="investor-name">Berkshire Hathaway Inc</span>
        <span className="investor-detail">Reported portfolio value by quarter and largest holdings</span>
        <span className="investor-arrow" aria-hidden="true">
          →
        </span>
      </Link>
    </main>
  );
}
