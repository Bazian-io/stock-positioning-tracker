import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// SEC fair access (https://www.sec.gov/os/accessing-edgar-data): declare who is asking in the
// User-Agent and stay under 10 requests per second. Overloading clients are blocked by SEC.
const MIN_REQUEST_INTERVAL_MS = 200;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export type SecDocument = { url: string; text: string; sha256: string };

export type FilingIndexEntry = {
  cik: string; // The CIK whose index lists the filing: the filer.
  accessionNumber: string;
  form: string;
  acceptedAt: string;
  reportDate: string;
};

// What one CIK filed for a report period: the original (null if it filed none) and the
// amendments for that period, oldest first.
export type CikFilings = { original: FilingIndexEntry | null; amendments: FilingIndexEntry[] };

// A quarter's original filing and its amendments across all of an investor's CIKs.
export type QuarterFilings = { reportDate: string; original: FilingIndexEntry; amendments: FilingIndexEntry[] };

// An SEC entity's names over time and the quarters of its original 13F-HR reports.
export type CikHistory = {
  cik: string;
  name: string;
  formerNames: { name: string; until: string }[];
  reportPeriods: string[];
};

type IndexColumns = Record<"form" | "accessionNumber" | "acceptanceDateTime" | "reportDate", string[]>;
type Submissions = {
  name: string;
  formerNames?: { name: string; to: string }[];
  filings: { recent: IndexColumns; files: { name: string; filingTo?: string }[] };
};

export type SecClient = { get(url: string): Promise<SecDocument> };

export function createSecClient(userAgent: string): SecClient {
  if (!/\S+@\S+\.\S+/.test(userAgent)) {
    throw new Error('SEC_USER_AGENT must name the requester and a contact email, e.g. "Example Research contact@example.com"');
  }
  let nextRequestAt = 0;

  async function get(url: string): Promise<SecDocument> {
    for (let attempt = 1; ; attempt++) {
      await sleep(Math.max(0, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        return { url, text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") };
      }
      await response.body?.cancel();
      // 403 means a rejected User-Agent or a rate-limit block; retrying would only extend the block.
      if ((response.status !== 429 && response.status < 500) || attempt === MAX_ATTEMPTS) {
        throw new Error(`SEC returned HTTP ${response.status} for ${url}`);
      }
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      await sleep(retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 2 ** attempt * 1000);
    }
  }

  return { get };
}

export function normalizeCik(cik: string): string {
  if (!/^\d{1,10}$/.test(cik)) throw new Error(`Invalid CIK: ${cik}`);
  return cik.padStart(10, "0");
}

const QUARTER_ENDS = ["03-31", "06-30", "09-30", "12-31"];

// Accepts a quarter-end date (2026-03-31) or a quarter label (2026Q1, 2026-Q1).
export function normalizeQuarter(quarter: string): string {
  const label = /^(\d{4})-?Q([1-4])$/i.exec(quarter);
  if (label) return `${label[1]}-${QUARTER_ENDS[Number(label[2]) - 1]}`;
  if (/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(quarter)) return quarter;
  throw new Error(`Invalid quarter: ${quarter}. Use a quarter-end date (2026-03-31) or a label (2026Q1).`);
}

// Every quarter-end date from one quarter through another, in order.
export function quarterRange(from: string, to: string): string[] {
  const first = normalizeQuarter(from);
  const last = normalizeQuarter(to);
  if (first > last) throw new Error(`Invalid quarter range: ${from} is after ${to}`);
  const quarters: string[] = [];
  for (let year = Number(first.slice(0, 4)); year <= Number(last.slice(0, 4)); year++) {
    for (const end of QUARTER_ENDS) {
      const quarter = `${year}-${end}`;
      if (quarter >= first && quarter <= last) quarters.push(quarter);
    }
  }
  return quarters;
}

export function submissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${cik}.json`;
}

async function getJson<T>(sec: SecClient, url: string): Promise<T> {
  return JSON.parse((await sec.get(url)).text);
}

function indexEntries(cik: string, columns: IndexColumns): FilingIndexEntry[] {
  return columns.form.map((form, i) => ({
    cik,
    accessionNumber: columns.accessionNumber[i],
    form,
    acceptedAt: columns.acceptanceDateTime[i],
    reportDate: columns.reportDate[i],
  }));
}

const byAcceptance = (a: FilingIndexEntry, b: FilingIndexEntry) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt);

// Finds what one CIK filed: the latest original filing of a form, for a report period (YYYY-MM-DD)
// or its latest period, and its amendments for that period. SEC's submissions index lists recent
// filings first and older ones in extra pages, newest first. A page is read only when the filing
// was not found earlier and the page reaches past the period end, since reports follow the period.
export async function findFiling(sec: SecClient, cik: string, form: string, reportDate?: string): Promise<CikFilings> {
  const index = await getJson<Submissions>(sec, submissionsUrl(cik));
  const olderPages = index.filings.files
    .filter((file) => !reportDate || !file.filingTo || file.filingTo >= reportDate)
    .map((file) => file.name);
  const seen = indexEntries(cik, index.filings.recent);
  const amendmentsFor = (period: string) =>
    seen.filter((entry) => entry.form === `${form}/A` && entry.reportDate === period).sort(byAcceptance);
  for (;;) {
    const originals = seen.filter((entry) => entry.form === form && (!reportDate || entry.reportDate === reportDate));
    if (originals.length > 0) {
      const original = originals.reduce((latest, entry) => (entry.acceptedAt > latest.acceptedAt ? entry : latest));
      // Amendments are filed after the original, so they are in the pages already read.
      return { original, amendments: amendmentsFor(original.reportDate) };
    }
    const page = olderPages.shift();
    if (!page) return { original: null, amendments: reportDate ? amendmentsFor(reportDate) : [] };
    seen.push(...indexEntries(cik, await getJson<IndexColumns>(sec, `https://data.sec.gov/submissions/${page}`)));
  }
}

// A quarter's original 13F-HR and its amendments across every CIK an investor has filed under,
// for example before and after a corporate reorganization; without a quarter, the latest quarter
// any of them reported. Exactly one CIK may have filed the quarter's original report.
export async function findQuarterFilings(sec: SecClient, ciks: string[], reportDate?: string): Promise<QuarterFilings> {
  const found: CikFilings[] = [];
  for (const cik of ciks) found.push(await findFiling(sec, cik, "13F-HR", reportDate));
  const quarter = reportDate ?? found.flatMap((filings) => (filings.original ? [filings.original] : [])).sort(byAcceptance).at(-1)?.reportDate;
  if (!quarter) throw new Error(`No 13F-HR filing in SEC's index for CIK ${ciks.join(", ")}`);
  for (const [i, filings] of found.entries()) {
    // Without a requested quarter each CIK was searched for its own latest report.
    if (!reportDate && filings.original?.reportDate !== quarter) found[i] = await findFiling(sec, ciks[i], "13F-HR", quarter);
  }
  const originals = found.flatMap((filings) => (filings.original ? [filings.original] : []));
  if (originals.length === 0) throw new Error(`No 13F-HR filing for ${quarter} in SEC's index for CIK ${ciks.join(", ")}`);
  if (originals.length > 1) {
    const listed = originals.map((original) => `${original.accessionNumber} (CIK ${original.cik})`).join(", ");
    throw new Error(`More than one CIK filed a 13F-HR for ${quarter}: ${listed}`);
  }
  return { reportDate: quarter, original: originals[0], amendments: found.flatMap((filings) => filings.amendments).sort(byAcceptance) };
}

// An SEC entity's names over time and every quarter it filed an original 13F-HR for, from all of
// its index pages. Used as evidence before linking a CIK to an investor.
export async function cikHistory(sec: SecClient, cik: string): Promise<CikHistory> {
  const index = await getJson<Submissions>(sec, submissionsUrl(cik));
  const entries = indexEntries(cik, index.filings.recent);
  for (const file of index.filings.files) {
    entries.push(...indexEntries(cik, await getJson<IndexColumns>(sec, `https://data.sec.gov/submissions/${file.name}`)));
  }
  return {
    cik,
    name: index.name,
    formerNames: (index.formerNames ?? []).map((former) => ({ name: former.name, until: former.to.slice(0, 10) })),
    reportPeriods: [...new Set(entries.filter((entry) => entry.form === "13F-HR").map((entry) => entry.reportDate))].sort(),
  };
}

export function fullSubmissionUrl(cik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}/${accessionNumber}.txt`;
}
