// Reading the sources that identify stocks: OpenFIGI, SEC's company ticker file, Nasdaq's directory of
// US-listed securities and our filings.
// Shared by add-security.mts (which writes) and the read-only data check.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSecClient } from "../sec13f/sec.mts";
import {
  listingDirectory, NASDAQ_LISTED_URL, OPENFIGI_URL, openFigiJob, OTHER_LISTED_URL, SEC_TICKERS_URL, type FilingEvidence, type Listing,
} from "./identify.mts";

export const PAGE_SIZE = 1000; // Supabase's default maximum rows per API response.
// OpenFIGI without an API key: 25 requests a minute, 10 identifiers per request.
export const OPENFIGI_BATCH = 10;
export const OPENFIGI_SPACING_MS = 2_500;

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

// supabase-js reports failures in the result instead of throwing.
export async function must<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, action: string) {
  const { data, error } = await request;
  if (error) throw new Error(`${action}: ${error.message}`);
  return data as T;
}

export async function loadAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, action: string) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const data = await must<T[]>(page(from, from + PAGE_SIZE - 1), action);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// OpenFIGI's result for each CUSIP, in order. By default only listed securities are mapped;
// includeUnlisted also finds delisted ones. Requests are spaced to stay within the rate limit; a
// rate-limited request waits a minute and is retried.
export async function openFigi(cusips: string[], { includeUnlisted = false } = {}): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let i = 0; i < cusips.length; i += OPENFIGI_BATCH) {
    if (i > 0) await wait(OPENFIGI_SPACING_MS);
    const jobs = cusips.slice(i, i + OPENFIGI_BATCH).map((cusip) => ({
      ...openFigiJob(cusip),
      ...(includeUnlisted ? { includeUnlistedEquities: true } : {}),
    }));
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(OPENFIGI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobs),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt < 4) {
        await wait(60_000);
        continue;
      }
      if (!response.ok) throw new Error(`OpenFIGI returned HTTP ${response.status}`);
      results.push(...(await response.json() as unknown[]));
      break;
    }
  }
  return results;
}

// Where our filings report each CUSIP: the quarters, the names filers used, and the earliest filing as
// evidence.
export async function filingEvidence(db: SupabaseClient, cusips: string[]): Promise<Map<string, FilingEvidence>> {
  type Row = { reported_cusip: string; report_period: string; reported_issuer: string; reported_class: string | null; filing_id: string };
  const rows: Row[] = [];
  for (let i = 0; i < cusips.length; i += 100) {
    rows.push(...await loadAll<Row>((from, to) => db.from("portfolio_holdings")
      .select("reported_cusip, report_period, reported_issuer, reported_class, filing_id")
      .in("reported_cusip", cusips.slice(i, i + 100))
      .order("report_period").order("filed_at").order("filing_id").order("source_row")
      .range(from, to), "Read holdings"));
  }
  const firstFilings = [...new Set(cusips.map((cusip) => rows.find((row) => row.reported_cusip === cusip)?.filing_id).filter((id) => id !== undefined))];
  const filings = firstFilings.length === 0 ? [] : await must<{ id: string; source_url: string }[]>(
    db.from("filings").select("id, source_url").in("id", firstFilings),
    "Read filings",
  );
  const evidence = new Map<string, FilingEvidence>();
  for (const cusip of cusips) {
    const reported = rows.filter((row) => row.reported_cusip === cusip);
    const sourceUrl = filings.find((filing) => filing.id === reported[0]?.filing_id)?.source_url;
    if (!sourceUrl) continue;
    evidence.set(cusip, {
      firstPeriod: reported[0].report_period,
      firstSourceUrl: sourceUrl,
      latestPeriod: reported[reported.length - 1].report_period,
      reportedNames: [...new Set(reported.map((row) => [row.reported_issuer, row.reported_class].filter(Boolean).join(" ")))],
    });
  }
  return evidence;
}

export async function secTickers() {
  return JSON.parse((await createSecClient(requireEnv("SEC_USER_AGENT")).get(SEC_TICKERS_URL)).text);
}

// Nasdaq's directory of every US-listed security, with its listing exchange, by ticker.
export async function listings(): Promise<Map<string, Listing>> {
  const read = async (url: string) => {
    const response = await fetch(url, { headers: { "User-Agent": "stock-positioning-tracker" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Nasdaq's symbol directory returned HTTP ${response.status}`);
    return response.text();
  };
  const [nasdaqListed, otherListed] = await Promise.all([read(NASDAQ_LISTED_URL), read(OTHER_LISTED_URL)]);
  const directory = listingDirectory(nasdaqListed, otherListed);
  if (directory.size < 1000) throw new Error(`Nasdaq's symbol directory lists only ${directory.size} securities; it may be incomplete`);
  return directory;
}

export const today = () => new Date().toISOString().slice(0, 10);
