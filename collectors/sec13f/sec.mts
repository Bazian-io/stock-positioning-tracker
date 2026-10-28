import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// SEC fair access (https://www.sec.gov/os/accessing-edgar-data): declare who is asking in the
// User-Agent and stay under 10 requests per second. Overloading clients are blocked by SEC.
const MIN_REQUEST_INTERVAL_MS = 200;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export type SecDocument = { url: string; text: string; sha256: string };

export type FilingIndexEntry = {
  accessionNumber: string;
  form: string;
  acceptedAt: string;
  reportDate: string;
};

// The selected original filing plus the amendments SEC lists for the same report period, oldest first.
export type FilingSelection = FilingIndexEntry & { amendments: FilingIndexEntry[] };

type IndexColumns = Record<"form" | "accessionNumber" | "acceptanceDateTime" | "reportDate", string[]>;

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

function indexEntries(columns: IndexColumns): FilingIndexEntry[] {
  return columns.form.map((form, i) => ({
    accessionNumber: columns.accessionNumber[i],
    form,
    acceptedAt: columns.acceptanceDateTime[i],
    reportDate: columns.reportDate[i],
  }));
}

// Finds the latest original filing of a form, optionally for one report period (YYYY-MM-DD).
// SEC's submissions index lists recent filings first and older ones in extra pages, newest
// first; those pages are fetched only when the requested period is not found earlier.
export async function findFiling(sec: SecClient, cik: string, form: string, reportDate?: string): Promise<FilingSelection> {
  const index: { filings: { recent: IndexColumns; files: { name: string }[] } } = JSON.parse(
    (await sec.get(`https://data.sec.gov/submissions/CIK${cik}.json`)).text,
  );
  const olderPages = index.filings.files.map((file) => file.name);
  const seen = indexEntries(index.filings.recent);
  for (;;) {
    const originals = seen.filter((entry) => entry.form === form && (!reportDate || entry.reportDate === reportDate));
    if (originals.length > 0) {
      const filing = originals.reduce((latest, entry) => (entry.acceptedAt > latest.acceptedAt ? entry : latest));
      // Amendments are filed after the original, so they are in the pages already read.
      const amendments = seen
        .filter((entry) => entry.form === `${form}/A` && entry.reportDate === filing.reportDate)
        .sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
      return { ...filing, amendments };
    }
    const page = olderPages.shift();
    if (!page) throw new Error(`No ${form} filing${reportDate ? ` for ${reportDate}` : ""} in SEC's index for CIK ${cik}`);
    seen.push(...indexEntries(JSON.parse((await sec.get(`https://data.sec.gov/submissions/${page}`)).text)));
  }
}

export function fullSubmissionUrl(cik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}/${accessionNumber}.txt`;
}
