import Link from "next/link";
import { Suspense } from "react";
import { QuarterNavigation } from "@/components/dashboard/quarter-navigation";
import { ResearchHighlights, ResearchHighlightsLoading } from "@/components/research-highlights";
import { ResearchSearch } from "@/components/research-search";
import { reportingQuarter, researchHref, type ResearchParams } from "@/lib/research";

export default async function HomePage({ searchParams }: { searchParams: Promise<ResearchParams> }) {
  const quarter = reportingQuarter((await searchParams).quarter);
  return (
    <QuarterNavigation>
      <main className="home">
        <p className="eyebrow">Investment research</p>
        <h1>Follow institutional positioning</h1>
        <p className="description">
          Find a stock or investor. Explore reported holdings, see what changed, and follow the quarters behind the numbers.
        </p>
        <ResearchSearch quarter={quarter} />
        <Suspense key={quarter ?? "latest"} fallback={<ResearchHighlightsLoading />}>
          <ResearchHighlights quarter={quarter} />
        </Suspense>
        <h2 className="home-section">Research sections</h2>
        <div className="section-cards">
          <Link href={researchHref("/investors", { quarter })} className="section-card">
            <span className="section-name">Investor Analysis</span>
            <span className="section-detail">
              Browse tracked institutional investors, their reported holdings and how their portfolios change
              from quarter to quarter.
            </span>
            <span className="section-arrow" aria-hidden="true">
              →
            </span>
          </Link>
          <Link href={researchHref("/stocks", { quarter })} className="section-card">
            <span className="section-name">Stock Analysis</span>
            <span className="section-detail">
              Search a stock and see which tracked investors report holding it, and how their holdings change from
              quarter to quarter.
            </span>
            <span className="section-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </main>
    </QuarterNavigation>
  );
}
