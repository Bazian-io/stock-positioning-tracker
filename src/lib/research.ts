import type { PortfolioChange } from "./portfolio-changes.ts";

export type ResearchParams = Record<string, string | string[] | undefined>;

export function reportingQuarter(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:19|20)\d{2}-(?:03-31|06-30|09-30|12-31)$/.test(value) ? value : undefined;
}

export function searchQuery(value: unknown): string {
  return typeof value === "string" ? value.replace(/[%_*\\]/g, "").trim().slice(0, 100) : "";
}

export function resultPage(value: unknown): number {
  return typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
}

export function researchHref(path: string, query: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  return `${path}${params.size ? `?${params}` : ""}`;
}

const RETURN_LABELS: Record<string, string> = {
  "/": "Back to research updates", "/search": "Back to search results",
  "/stocks": "Back to stocks", "/investors": "Back to investors", "/compare": "Back to investor comparison",
};

// Only results pages can be return destinations. Detail links carry this one destination,
// rather than nesting an ever-growing chain of previous dashboard URLs.
export function returnTarget(value: unknown): { href: string; label: string } | undefined {
  if (typeof value !== "string" || value.length > 2000 || !value.startsWith("/")
    || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  const url = new URL(value, "https://research.invalid");
  const label = RETURN_LABELS[url.pathname];
  if (!label || url.origin !== "https://research.invalid") return undefined;
  const query: Record<string, string | undefined> = { quarter: reportingQuarter(url.searchParams.get("quarter")) };
  if (url.pathname === "/search" || url.pathname === "/stocks" || url.pathname === "/compare") {
    query.q = searchQuery(url.searchParams.get("q"));
    const page = resultPage(url.searchParams.get("page"));
    if (page > 1) query.page = String(page);
  }
  if (url.pathname === "/compare") {
    for (const key of ["a", "b", "filter", "sort"]) {
      const value = url.searchParams.get(key);
      if (value && /^[a-z0-9-]{1,100}$/.test(value)) query[key] = value;
    }
  }
  const hash = /^#(?:research-updates|search-results|stock-list|tracked-investors|comparison-holdings|(?:stock|investor)-[a-zA-Z0-9.-]+)$/.test(url.hash) ? url.hash : "";
  return { href: `${researchHref(url.pathname, query)}${hash}`, label };
}

// A single previous research view, including its filters. Drop its own back link to keep
// repeated stock/investor navigation from growing the URL; retain the original results link.
export function detailReturnTarget(value: unknown): { href: string; label: string } | undefined {
  if (typeof value !== "string" || value.length > 4000 || !value.startsWith("/")
    || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  const url = new URL(value, "https://research.invalid");
  const investor = /^\/investors\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname);
  const ticker = /^\/stocks\/([A-Z0-9-]{1,10})$/.exec(url.pathname)?.[1];
  if (url.origin !== "https://research.invalid" || (!investor && !ticker)) return undefined;
  const query: Record<string, string | undefined> = {
    quarter: reportingQuarter(url.searchParams.get("quarter")), from: returnTarget(url.searchParams.get("from"))?.href,
  };
  for (const key of investor ? ["holdings", "q", "sort", "page", "change", "changePage"] : ["investor", "filter"]) {
    const value = url.searchParams.get(key);
    if (value && value.length <= 100) query[key] = value;
  }
  const hash = /^(?:#holdings|#changes|#holders)$/.test(url.hash) ? url.hash : "";
  return { href: `${researchHref(url.pathname, query)}${hash}`, label: investor ? "Back to investor portfolio" : `Back to ${ticker} overview` };
}

type SearchableInvestor = { name: string; filedName: string; slug: string; cik: string };
const searchable = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function matchingInvestors<T extends SearchableInvestor>(investors: T[], query: string): T[] {
  const needle = searchable(query);
  if (!needle) return [];
  return investors.filter((investor) => [investor.name, investor.filedName, investor.slug, investor.cik]
    .some((value) => searchable(value).includes(needle))
    || (/^\d+$/.test(query) && investor.cik.replace(/^0+/, "") === query.replace(/^0+/, "")));
}

export type ManagerChanges = { investor: { id: string; name: string; slug: string }; changes: PortfolioChange[] };
export type ResearchHighlight = { investor: ManagerChanges["investor"]; position: PortfolioChange; weightShift: number };

// One ordinary share change per manager, ranked by its absolute portfolio-weight shift.
// Missing weights, corporate actions and uncertain comparisons cannot become highlights.
export function notableChanges(comparisons: ManagerChanges[], limit = 6): ResearchHighlight[] {
  const highlights: ResearchHighlight[] = [];
  for (const { investor, changes } of comparisons) {
    const candidates = changes.flatMap((position) => {
      if (!["opened", "closed", "increased", "decreased"].includes(position.category)
        || !["opened", "closed", "increased", "decreased"].includes(position.change.kind)
        || position.previousWeight === null || position.currentWeight === null) return [];
      const weightShift = Math.abs(position.currentWeight - position.previousWeight);
      return Number.isFinite(weightShift) && weightShift > 0 ? [{ investor, position, weightShift }] : [];
    }).sort((a, b) => b.weightShift - a.weightShift || a.position.id.localeCompare(b.position.id));
    if (candidates[0]) highlights.push(candidates[0]);
  }
  return highlights.sort((a, b) => b.weightShift - a.weightShift || a.investor.slug.localeCompare(b.investor.slug))
    .slice(0, limit);
}
