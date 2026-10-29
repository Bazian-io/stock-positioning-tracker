import "server-only";
import { cache } from "react";
import { load, PAGE_SIZE } from "./portfolio-data";
import { identifiesStock, type CusipPeriod } from "./stock";
import { readOnlySupabase } from "./supabase";

// A stock (one share class of one issuer) from the securities and security_identifiers tables.
export type Stock = {
  securityId: string;
  ticker: string; // Current ticker.
  exchange: string; // MIC of the ticker's exchange, e.g. XNAS.
  name: string;
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
type SecurityRow = { id: string; issuer_name: string; share_class: string | null; security_type: string };

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
    name: security.issuer_name,
    shareClass: security.share_class,
    securityType: security.security_type,
    cusips: identifiers
      .filter((row) => row.identifier_type === "cusip")
      .map((row) => ({ cusip: row.identifier_value, validFrom: row.valid_from, validTo: row.valid_to })),
  };
}

// Every stock with a current ticker, by ticker.
export async function getStocks(): Promise<Stock[]> {
  const db = readOnlySupabase();
  const [securities, identifiers] = await Promise.all([
    loadAll<SecurityRow>((from, to) => db.from("securities").select("id, issuer_name, share_class, security_type").order("id").range(from, to), "securities"),
    loadAll<IdentifierRow>((from, to) => db.from("security_identifiers").select(IDENTIFIER_COLUMNS)
      .in("identifier_type", ["cusip", "ticker"]).order("id").range(from, to), "security identifiers"),
  ]);
  return securities
    .map((security) => toStock(security, identifiers.filter((row) => row.security_id === security.id)))
    .filter((stock): stock is Stock => stock !== null)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
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
    load<SecurityRow>(db.from("securities").select("id, issuer_name, share_class, security_type").eq("id", match.security_id).single(), "security"),
    load<IdentifierRow[]>(db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("security_id", match.security_id), "security identifiers"),
  ]);
  return toStock(security, identifiers);
});

// Current tickers for the reported CUSIPs that identify a stock at this quarter end, for linking
// holdings to stock pages. CUSIPs without a stock are left out.
export async function getStockTickers(cusips: string[], reportPeriod: string): Promise<Record<string, string>> {
  const unique = [...new Set(cusips)];
  if (unique.length === 0) return {};
  const db = readOnlySupabase();
  const matches = (await load<IdentifierRow[]>(
    db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("identifier_type", "cusip").in("identifier_value", unique),
    "CUSIP identifiers",
  )).filter((row) => validOn(row, reportPeriod));
  if (matches.length === 0) return {};
  const tickers = (await load<IdentifierRow[]>(
    db.from("security_identifiers").select(IDENTIFIER_COLUMNS).eq("identifier_type", "ticker")
      .in("security_id", [...new Set(matches.map((row) => row.security_id))]),
    "ticker identifiers",
  )).filter((row) => validOn(row, today()));
  const tickerBySecurity = new Map(tickers.map((row) => [row.security_id, row.identifier_value]));
  return Object.fromEntries(matches.flatMap((row) => {
    const ticker = tickerBySecurity.get(row.security_id);
    return ticker ? [[row.identifier_value, ticker]] : [];
  }));
}

export type StockPosition = {
  investorId: string;
  reportPeriod: string;
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
};

// Every tracked investor's reported positions in the stock, in every quarter. The database selects
// the stock's rows by CUSIP (portfolio_positions), so whole portfolios are never downloaded.
export async function getStockOwnership(stock: Stock): Promise<StockOwnership> {
  const db = readOnlySupabase();
  const cusips = [...new Set(stock.cusips.map((period) => period.cusip))];
  const [investors, reports, positions] = await Promise.all([
    load<StockOwnership["investors"]>(db.from("investors").select("id, name, slug").order("name"), "investors"),
    loadAll<{ investor_id: string; report_period: string; value_usd: string; has_confidential_omissions: boolean }>(
      (from, to) => db.from("quarterly_portfolios")
        .select("investor_id, report_period, value_usd::text, has_confidential_omissions")
        .order("investor_id").order("report_period").range(from, to),
      "quarterly portfolios",
    ),
    cusips.length === 0 ? [] : loadAll<{
      investor_id: string; report_period: string; reported_cusip: string; position_type: string; quantity_type: string; quantity: string; value_usd: string;
    }>(
      (from, to) => db.from("portfolio_positions")
        .select("investor_id, report_period, reported_cusip, position_type, quantity_type, quantity::text, value_usd::text")
        .in("reported_cusip", cusips)
        .order("investor_id").order("report_period").order("reported_cusip").order("position_type").order("quantity_type")
        .range(from, to),
      "positions",
    ),
  ]);
  return {
    investors,
    reports: reports.map((row) => ({
      investorId: row.investor_id,
      reportPeriod: row.report_period,
      valueUsd: Number(row.value_usd),
      confidentialOmissions: row.has_confidential_omissions,
    })),
    positions: positions
      .filter((row) => identifiesStock(stock.cusips, row.reported_cusip, row.report_period))
      .map((row) => ({
        investorId: row.investor_id,
        reportPeriod: row.report_period,
        positionType: row.position_type,
        quantityType: row.quantity_type,
        shares: Number(row.quantity),
        valueUsd: Number(row.value_usd),
      })),
  };
}
