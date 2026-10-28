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

export async function findLatestFiling(sec: SecClient, cik: string, form: string): Promise<FilingIndexEntry> {
  const { text } = await sec.get(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent: Record<"form" | "accessionNumber" | "acceptanceDateTime" | "reportDate", string[]> =
    JSON.parse(text).filings.recent;
  const matches = recent.form.flatMap((entryForm, i) =>
    entryForm === form
      ? [{
          accessionNumber: recent.accessionNumber[i],
          form: entryForm,
          acceptedAt: recent.acceptanceDateTime[i],
          reportDate: recent.reportDate[i],
        }]
      : [],
  );
  if (matches.length === 0) throw new Error(`No ${form} filing in SEC's recent filings for CIK ${cik}`);
  return matches.reduce((latest, entry) => (entry.acceptedAt > latest.acceptedAt ? entry : latest));
}

export function fullSubmissionUrl(cik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}/${accessionNumber}.txt`;
}
