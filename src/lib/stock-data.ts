import "server-only";
import { cache } from "react";
import { companyName, investorName, stockName } from "./names";
import { load, PAGE_SIZE } from "./portfolio-data";
import { identifiesStock, lastQuarterBefore, type Conversion, type CusipPeriod } from "./stock";
import { readOnlySupabase } from "./supabase";

// A stock (one share class of one issuer) from the securities and security_identifiers tables.
export type Stock = {
  securityId: string;
  ticker: string; // Current ticker.
  exchange: string; // MIC of the ticker's exchange, e.g. XNAS.
  name: string; // Short name for pages, e.g. "Bank of America".
  companyName: string | null; // Full name from Nasdaq's directory, e.g. "Bank of America Corporation".
  issuerName: string; // As identified from SEC's company list, e.g. "BANK OF AMERICA CORP".
  shareClass: string | null;
  securityType: string;
  cusips: CusipPeriod[];
};

type IdentifierRow = {
  security_id: string;
  identifier_type: "cusip" | "ticker";
  identifier_value: string;
  namespace: string;
  valid_from: string;
  valid_to: string | null;
};
type SecurityRow = { id: string; issuer_name: string; listing_name: string | null; share_class: string | null; security_type: string };
const SECURITY_COLUMNS = "id, issuer_name, listing_name, share_class, security_type";

const IDENTIFIER_COLUMNS = "security_id, identifier_type, identifier_value, namespace, valid_from, valid_to";
const today = () => new Date().toISOString().slice(0, 10);
const validOn = (row: { valid_from: string; valid_to: string | null }, date: string) =>
  row.valid_from <= date && (row.valid_to === null || date < row.valid_to);

// Every page of a query whose results can exceed one response.
async function loadAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const data = await load<T[]>(page(from, from + PAGE_SIZE - 1), what);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

// Stocks need a current ticker; their CUSIPs match them to reported holdings.
function toStock(security: SecurityRow, identifiers: IdentifierRow[]): Stock | null {
  const ticker = identifiers.find((row) => row.identifier_type === "ticker" && validOn(row, today()));
  if (!ticker) return null;
  return {
    securityId: security.id,
    ticker: ticker.identifier_value,
    exchange: ticker.namespace,
    name: stockName({ listingName: security.listing_name, issuerName: security.issuer_name }),
    companyName: security.listing_name ? companyName(security.listing_name) : null,
    issuerName: security.issuer_name,
    shareClass: security.share_class,
    securityType: security.security_type,
    cusips: identifiers
      .filter((row) => row.identifier_type === "cusip")
      .map((row) => ({ cusip: row.identifier_value, validFrom: row.valid_from, validTo: row.valid_to })),
  };
}

type TickerRow = IdentifierRow & { securities: SecurityRow };
// Each ticker belongs to one security, so the embedded security is a row, not a list.
type TickerRows = { merge: false };

// Current tickers, one per stock, each with its security.
function currentTickers(count?: "exact") {
  const date = today();
  return readOnlySupabase().from("security_identifiers")
    .select(`${IDENTIFIER_COLUMNS}, securities!inner(${SECURITY_COLUMNS})`, { count })
    .eq("identifier_type", "ticker")
    .lte("valid_from", date)
    .or(`valid_to.is.null,valid_to.gt.${date}`);
}

const byTicker = (a: TickerRow, b: TickerRow) =>
  a.identifier_value.localeCompare(b.identifier_value) || a.namespace.localeCompare(b.namespace) || a.security_id.localeCompare(b.security_id);

export type StockPage = { stocks: Stock[]; total: number };

// One page of stocks by ticker, and how many there are. A search finds tickers and company names that
// contain the text, and exact CUSIPs, across all stocks. The database does the matching, so only the
// matches' tickers and the page's stocks are loaded.
export async function getStockPage(search: string, offset: number, limit: number): Promise<StockPage> {
  const db = readOnlySupabase();
  // Wildcard characters would change what a search matches.
  const text = search.replace(/[%_*\\]/g, "").trim();
  let rows: TickerRow[];
  let total: number;
  if (text === "") {
    const page = await currentTickers("exact")
      .order("identifier_value").order("namespace").order("security_id")
      .range(offset, offset + limit - 1)
      .overrideTypes<TickerRow[], TickerRows>();
    // PGRST103: the offset is past the last stock, e.g. a page number beyond the last page.
    if (page.error?.code === "PGRST103") return { stocks: [], total: 0 };
    if (page.error) throw new Error(`Could not load stocks: ${page.error.message}`);
    rows = page.data;
    total = page.count ?? 0;
  } else {
    const [tickerMatches, nameMatches, listedNameMatches, cusipMatches] = await Promise.all([
      loadAll<TickerRow>((from, to) => currentTickers().ilike("identifier_value", `*${text.toUpperCase().replace(/[./]/g, "-")}*`)
        .order("id").range(from, to).overrideTypes<TickerRow[], TickerRows>(), "stocks by ticker"),
      loadAll<TickerRow>((from, to) => currentTickers().ilike("securities.issuer_name", `*${text}*`)
        .order("id").range(from, to).overrideTypes<TickerRow[], TickerRows>(), "stocks by name"),
      loadAll<TickerRow>((from, to) => currentTickers().ilike("securities.listing_name", `*${text}*`)
        .order("id").range(from, to).overrideTypes<TickerRow[], TickerRows>(), "stocks by listed name"),
      load<{ security_id: string }[]>(db.from("security_identifiers").select("security_id")
        .eq("identifier_type", "cusip").eq("identifier_value", text.toUpperCase()), "stocks by CUSIP"),
    ]);
    const cusipSecurities = [...new Set(cusipMatches.map((row) => row.security_id))];
    const byCusip = cusipSecurities.length === 0 ? [] : await load<TickerRow[]>(
      currentTickers().in("security_id", cusipSecurities).overrideTypes<TickerRow[], TickerRows>(),
      "stocks by CUSIP",
    );
    const matches = new Map([...tickerMatches, ...nameMatches, ...listedNameMatches, ...byCusip].map((row) => [row.security_id, row]));
    const sorted = [...matches.values()].sort(byTicker);
    rows = sorted.slice(offset, offset + limit);
    total = sorted.length;
  }
  if (rows.length === 0) return { stocks: [], total };
  const cusips = await load<IdentifierRow[]>(
    db.from("security_identifiers").select(IDENTIFIER_COLUMNS)
      .eq("identifier_type", "cusip").in("security_id", rows.map((row) => row.security_id)),
    "CUSIPs",
  );
  const stocks = rows.map((row) => toStock(row.securities, [row, ...cusips.filter((cusip) => cusip.security_id === row.security_id)]));
  return { stocks: stocks.filter((stock): stock is Stock => stock !== null), total };
}

// The stock with this current ticker. Loaded once per request, for both the page and its metadata.
export const getStock = cache(async (ticker: string): Promise<Stock | null> => {
  const db = readOnlySupabase();
  const matches = await load<IdentifierRow[]>(
    db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("identifier_type", "ticker").eq("identifier_value", ticker),
    "ticker",
  );
  const match = matches.find((row) => validOn(row, today()));
  if (!match) return null;
  const [security, identifiers] = await Promise.all([
    load<SecurityRow>(db.from("securities").select(SECURITY_COLUMNS).eq("id", match.security_id).single(), "security"),
    load<IdentifierRow[]>(db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("security_id", match.security_id), "security identifiers"),
  ]);
  return toStock(security, identifiers);
});

export type StockLink = { ticker: string; name: string };

// Current tickers and names for the reported CUSIPs that identify a stock at this quarter end, for
// linking holdings to stock pages. CUSIPs without a stock are left out.
export async function getStockLinks(cusips: string[], reportPeriod: string): Promise<Record<string, StockLink>> {
  const unique = [...new Set(cusips)];
  if (unique.length === 0) return {};
  const db = readOnlySupabase();
  const matches = (await load<IdentifierRow[]>(
    db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("identifier_type", "cusip").in("identifier_value", unique),
    "CUSIP identifiers",
  )).filter((row) => validOn(row, reportPeriod));
  if (matches.length === 0) return {};
  const securityIds = [...new Set(matches.map((row) => row.security_id))];
  const [tickers, securities] = await Promise.all([
    load<IdentifierRow[]>(
      db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("identifier_type", "ticker").in("security_id", securityIds),
      "ticker identifiers",
    ),
    load<SecurityRow[]>(db.from("securities").select(SECURITY_COLUMNS).in("id", securityIds), "securities"),
  ]);
  const tickerBySecurity = new Map(tickers.filter((row) => validOn(row, today())).map((row) => [row.security_id, row.identifier_value]));
  return Object.fromEntries(matches.flatMap((row) => {
    const ticker = tickerBySecurity.get(row.security_id);
    const security = securities.find((candidate) => candidate.id === row.security_id);
    if (!ticker || !security) return [];
    return [[row.identifier_value, { ticker, name: stockName({ listingName: security.listing_name, issuerName: security.issuer_name }) }]];
  }));
}

export type StockPosition = {
  investorId: string;
  reportPeriod: string;
  cusip: string;
  positionType: string; // "long", "put" or "call".
  quantityType: string; // "SH" or "PRN".
  shares: number;
  valueUsd: number;
};

export type StockOwnership = {
  investors: { id: string; name: string; slug: string }[];
  // Every quarter each investor reported (quarterly_portfolios), with its total reported value.
  reports: { investorId: string; reportPeriod: string; valueUsd: number; confidentialOmissions: boolean }[];
  positions: StockPosition[];
  // Positions under one of the stock's CUSIPs in a quarter that CUSIP is not recorded for, e.g. before
  // the earliest filing it was first seen in when it was added. They are not counted as the stock.
  unconfirmed: StockPosition[];
  // Corporate actions in which holders of other securities received the stock, and positions in those
  // securities in the quarter before each, to tell shares received from shares bought.
  conversions: Conversion[];
  convertedFrom: StockPosition[];
};

type PositionRow = {
  investor_id: string; report_period: string; reported_cusip: string; position_type: string; quantity_type: string; quantity: string; value_usd: string;
};
const POSITION_COLUMNS = "investor_id, report_period, reported_cusip, position_type, quantity_type, quantity::text, value_usd::text";
const toPosition = (row: PositionRow): StockPosition => ({
  investorId: row.investor_id,
  reportPeriod: row.report_period,
  cusip: row.reported_cusip,
  positionType: row.position_type,
  quantityType: row.quantity_type,
  shares: Number(row.quantity),
  valueUsd: Number(row.value_usd),
});

// Every tracked investor's reported positions in the stock, in every quarter. The database selects
// the stock's rows by CUSIP (portfolio_positions), so whole portfolios are never downloaded.
export async function getStockOwnership(stock: Stock): Promise<StockOwnership> {
  const db = readOnlySupabase();
  const cusips = [...new Set(stock.cusips.map((period) => period.cusip))];
  const [investors, reports, positions, conversions] = await Promise.all([
    load<{ id: string; name: string; display_name: string | null; slug: string }[]>(
      db.from("investors").select("id, name, display_name, slug"), "investors"),
    loadAll<{ investor_id: string; report_period: string; value_usd: string; has_confidential_omissions: boolean }>(
      (from, to) => db.from("quarterly_portfolios")
        .select("investor_id, report_period, value_usd::text, has_confidential_omissions")
        .order("investor_id").order("report_period").range(from, to),
      "quarterly portfolios",
    ),
    cusips.length === 0 ? [] : loadAll<PositionRow>(
      (from, to) => db.from("portfolio_positions")
        .select(POSITION_COLUMNS)
        .in("reported_cusip", cusips)
        .order("investor_id").order("report_period").order("reported_cusip").order("position_type").order("quantity_type")
        .range(from, to),
      "positions",
    ),
    load<{ from_cusip: string; shares_per_share: string; effective_date: string; description: string }[]>(
      db.from("security_conversions").select("from_cusip, shares_per_share::text, effective_date, description")
        .eq("security_id", stock.securityId).order("effective_date").order("from_cusip"),
      "conversions",
    ),
  ]);
  // The converted securities' positions in the quarter before each conversion.
  const convertedFrom = conversions.length === 0 ? [] : await loadAll<PositionRow>(
    (from, to) => db.from("portfolio_positions")
      .select(POSITION_COLUMNS)
      .in("reported_cusip", [...new Set(conversions.map((row) => row.from_cusip))])
      .in("report_period", [...new Set(conversions.map((row) => lastQuarterBefore(row.effective_date)))])
      .order("investor_id").order("report_period").order("reported_cusip").order("position_type").order("quantity_type")
      .range(from, to),
    "converted positions",
  );
  const all = positions.map(toPosition);
  const confirmed = (position: StockPosition) => identifiesStock(stock.cusips, position.cusip, position.reportPeriod);
  return {
    investors: investors
      .map((row) => ({ id: row.id, name: investorName({ displayName: row.display_name, name: row.name }), slug: row.slug }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    reports: reports.map((row) => ({
      investorId: row.investor_id,
      reportPeriod: row.report_period,
      valueUsd: Number(row.value_usd),
      confidentialOmissions: row.has_confidential_omissions,
    })),
    positions: all.filter(confirmed),
    unconfirmed: all.filter((position) => !confirmed(position)),
    conversions: conversions.map((row) => ({
      fromCusip: row.from_cusip,
      sharesPerShare: Number(row.shares_per_share),
      effectiveDate: row.effective_date,
      description: row.description,
    })),
    convertedFrom: convertedFrom.map(toPosition),
  };
}
