import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Stock Positioning Tracker", template: "%s · Stock Positioning Tracker" },
  description:
    "Research institutional ownership and short-interest trends in U.S.-listed stocks.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              <svg className="brand-mark" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <rect x="2" y="10" width="4" height="8" rx="1" />
                <rect x="8" y="6" width="4" height="12" rx="1" />
                <rect x="14" y="2" width="4" height="16" rx="1" />
              </svg>
              Stock Positioning Tracker
            </Link>
            <SiteNav />
          </div>
        </header>
        <div className="site-main">{children}</div>
        <footer className="site-footer">
          <div className="site-footer-inner">
            Data from SEC EDGAR Form 13F filings. Reported values are historical disclosures, not
            investment performance or advice.
          </div>
        </footer>
      </body>
    </html>
  );
}
