import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { getInvestorSummaries } from "@/lib/portfolio-data";
import { SITE_URL } from "@/lib/site";
import { getStockTickers } from "@/lib/stock-data";

// The clean address of every research page. robots.txt keeps crawlers off links with a "?", which
// includes the links between pages, so this list is how search engines find each stock and investor.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Read on request through the research cache, so building the site never needs the database.
  await connection();
  const [investors, tickers] = await Promise.all([getInvestorSummaries(), getStockTickers()]);
  return [
    "/", "/investors", "/stocks",
    ...investors.map((investor) => `/investors/${investor.slug}`),
    ...tickers.map((ticker) => `/stocks/${encodeURIComponent(ticker)}`),
  ].map((path) => ({ url: `${SITE_URL}${path}` }));
}
