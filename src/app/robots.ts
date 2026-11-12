import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Crawlers may read every page at its clean address. A link with a "?" is a filtered, sorted or
// paginated view of a page they can already read; there are millions of combinations, and each one
// runs a server function with database queries. The sitemap lists the clean addresses instead.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: ["/*?", "/search", "/compare", "/api/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
