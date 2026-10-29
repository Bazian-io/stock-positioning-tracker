// Checks that a CUSIP and a ticker identify the same listed security, using two independent sources:
// OpenFIGI (CUSIP → ticker) and SEC's company ticker file (ticker → company and exchange). Each share
// class has its own CUSIP and ticker, so classes become separate securities.

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
export const OPENFIGI_URL = "https://api.openfigi.com/v3/mapping";

// Exchange names in SEC's ticker file and their ISO 10383 market identifier codes (MICs).
export const EXCHANGE_MICS: Record<string, string> = { Nasdaq: "XNAS", NYSE: "XNYS" };

// OpenFIGI security types that are stocks. Funds and ETFs (ETP), preferred shares and units are not.
export const STOCK_TYPES = ["Common Stock", "ADR", "REIT", "MLP", "NY Reg Shrs", "Tracking Stk"];

// The CUSIP check digit (ANSI X9.6): characters 1–8 weighted 1, 2, 1, 2, …, digits of each product summed.
export function isValidCusip(cusip: string): boolean {
  if (!/^[0-9A-Z*@#]{8}[0-9]$/.test(cusip)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const char = cusip[i];
    let value = /\d/.test(char) ? Number(char) : /[A-Z]/.test(char) ? char.charCodeAt(0) - 55 : 36 + "*@#".indexOf(char);
    if (i % 2 === 1) value *= 2;
    sum += Math.floor(value / 10) + (value % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(cusip[8]);
}

// Tickers in SEC's style: upper case, share classes after a hyphen ("brk.b" and "BRK/B" → "BRK-B").
export function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[./]/g, "-");
}

// An OpenFIGI mapping job for a CUSIP. Issuers incorporated outside the US have CINS numbers, CUSIPs
// that start with a letter ("H1467J104" for Chubb), which OpenFIGI looks up as their own type.
export function openFigiJob(cusip: string) {
  return { idType: /^[A-Z]/.test(cusip) ? "ID_CINS" : "ID_CUSIP", idValue: cusip };
}

export type FigiListing = { ticker: string; name: string; securityType: string; marketSector: string; compositeFigi: string };

// The US composite listing in OpenFIGI's result for one mapping job, if there is one. OpenFIGI maps
// only listed securities by default, so a delisted CUSIP has none.
export function usListing(result: unknown): FigiListing | null {
  const data = (result as { data?: unknown } | null)?.data;
  const row = Array.isArray(data) ? data.find((entry) => entry?.exchCode === "US") : undefined;
  if (!row) return null;
  return {
    ticker: normalizeTicker(String(row.ticker)),
    name: String(row.name),
    securityType: String(row.securityType),
    marketSector: String(row.marketSector),
    compositeFigi: String(row.compositeFIGI),
  };
}

export type SecListing = { cik: string; name: string; ticker: string; exchange: string };

// A ticker's row in SEC's company ticker file ({ fields: [cik, name, ticker, exchange], data: [...] }).
export function secListing(file: { fields: string[]; data: unknown[][] }, ticker: string): SecListing | null {
  const column = (field: string) => file.fields.indexOf(field);
  const row = file.data.find((entry) => normalizeTicker(String(entry[column("ticker")])) === ticker);
  if (!row) return null;
  return {
    cik: String(row[column("cik")]).padStart(10, "0"),
    name: String(row[column("name")]),
    ticker,
    exchange: String(row[column("exchange")]),
  };
}

// The share class at the end of an OpenFIGI name ("ALPHABET INC-CL A", "LENNAR CORP - B SHS",
// "LIBERTY MEDIA CORP-C"), if it names one.
export function shareClassOf(figiName: string): string | null {
  const match = /-\s*(?:CL(?:ASS)?\s+)?([A-Z])(?:\s+SH(?:S|ARES))?$/.exec(figiName.trim());
  return match ? `Class ${match[1]}` : null;
}

// Words that say what kind of company a name is, not which one.
const GENERIC_WORDS = new Set([
  "THE", "OF", "AND", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COS", "COMPANY", "LTD", "LIMITED",
  "PLC", "LLC", "LP", "NV", "SA", "AG", "SE", "NEW", "DEL", "DE", "CL", "CLASS", "COM", "SHS", "SHARES",
  "HOLDINGS", "HOLDING", "GROUP", "TRUST", "TR",
]);

function nameWords(name: string): Set<string> {
  const words = name.toUpperCase().replace(/['’]/g, "").split(/[^A-Z0-9]+/);
  return new Set(words.filter((word) => word.length > 1 && !GENERIC_WORDS.has(word)));
}

// Whether two sources' names for a company share a distinctive word ("MOODY'S CORP" and
// "MOODYS CORP /DE/"). Names are abbreviated differently, so this only catches clear mismatches, such as
// a ticker that now belongs to another company.
export function sameCompany(a: string, b: string): boolean {
  const words = nameWords(b);
  return [...nameWords(a)].some((word) => words.has(word));
}

// Where our filings report the CUSIP: the earliest quarter (with a filing as evidence) and the
// names filers used for it.
export type FilingEvidence = { firstPeriod: string; firstSourceUrl: string; latestPeriod: string; reportedNames: string[] };

export type Evidence = { cusip: string; ticker: string; figi: FigiListing | null; sec: SecListing | null; filings: FilingEvidence | null };

export type PlannedIdentifier = {
  identifier_type: string;
  identifier_value: string;
  namespace: string;
  valid_from: string;
  valid_to?: string; // Exclusive; open-ended when absent.
  source_reference: string;
};

export type PlannedSecurity = {
  security: { issuer_name: string; share_class: string | null; security_type: string };
  identifiers: PlannedIdentifier[];
};

// The rows to add, or the reasons the sources do not support the mapping. The CUSIP applies from the
// earliest quarter our filings report it (evidenced by that filing); the ticker from the day SEC's
// file was read. Validity is never extended past what the evidence shows.
export function planSecurity(evidence: Evidence, today: string, shareClass: string | null): { plan: PlannedSecurity | null; problems: string[] } {
  const { cusip, ticker, figi, sec, filings } = evidence;
  const problems: string[] = [];
  if (!isValidCusip(cusip)) problems.push(`${cusip} is not a valid CUSIP (check digit)`);
  if (!figi) problems.push(`OpenFIGI has no US listing for CUSIP ${cusip}`);
  else {
    if (figi.ticker !== ticker) problems.push(`OpenFIGI maps CUSIP ${cusip} to ${figi.ticker}, not ${ticker}`);
    if (!STOCK_TYPES.includes(figi.securityType)) problems.push(`OpenFIGI lists ${cusip} as ${figi.securityType}, not a stock`);
  }
  if (!sec) problems.push(`${ticker} is not in SEC's company ticker file`);
  else if (!EXCHANGE_MICS[sec.exchange]) problems.push(`${ticker} trades on ${sec.exchange}; only ${Object.keys(EXCHANGE_MICS).join(" and ")} are supported`);
  if (!filings) problems.push(`No tracked filing reports CUSIP ${cusip}`);
  if (problems.length > 0 || !figi || !sec || !filings) return { plan: null, problems };
  return {
    problems,
    plan: {
      security: {
        issuer_name: sec.name.replace(/\s*\/(?:[A-Z]{2,3}\/?)?$/, ""), // without SEC's tag ("MOODYS CORP /DE/", "LENNAR CORP /NEW/")
        share_class: shareClass,
        security_type: figi.securityType.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      },
      identifiers: [
        { identifier_type: "cusip", identifier_value: cusip, namespace: "", valid_from: filings.firstPeriod, source_reference: filings.firstSourceUrl },
        { identifier_type: "ticker", identifier_value: ticker, namespace: EXCHANGE_MICS[sec.exchange], valid_from: today, source_reference: SEC_TICKERS_URL },
      ],
    },
  };
}

export type Candidate = { cusip: string; ticker: string | null; plan: PlannedSecurity | null; problems: string[] };

// A ticker identifies one stock at a time. A planned ticker that is already recorded, or that two CUSIPs
// map to (as after a reorganization that changed the CUSIP), needs a person to decide which CUSIP it
// belongs to, so those candidates are not added.
export function markTickerConflicts(candidates: Candidate[], recordedTickers: Set<string>): void {
  const planned = candidates.filter((candidate) => candidate.plan && candidate.ticker);
  for (const candidate of planned) {
    const others = planned.filter((other) => other !== candidate && other.ticker === candidate.ticker).map((other) => other.cusip);
    if (recordedTickers.has(candidate.ticker ?? "")) candidate.problems.push(`${candidate.ticker} is already recorded for another CUSIP`);
    else if (others.length > 0) candidate.problems.push(`CUSIPs ${[candidate.cusip, ...others].join(", ")} all map to ${candidate.ticker}`);
  }
  for (const candidate of planned) if (candidate.problems.length > 0) candidate.plan = null;
}

// The day after a date: the exclusive end of a validity window that includes that date.
export function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// A CUSIP that filers mistyped for a stock (Berkshire filed Nu Holdings' G6683N103 as G6693N103 for
// four quarters), recorded as an extra CUSIP of the stock for exactly the quarters filings used it.
// It must not be a security OpenFIGI knows, listed or delisted, and every name filers reported under it
// must match the stock's.
export function planAlias(
  alias: string,
  stockName: string,
  openFigiResult: unknown,
  filings: FilingEvidence | null,
): { identifier: PlannedIdentifier | null; problems: string[] } {
  const problems: string[] = [];
  if (!/^[0-9A-Z*@#]{9}$/.test(alias)) problems.push(`${alias} is not a 9-character CUSIP`);
  const known = (openFigiResult as { data?: { name?: string }[] } | null)?.data ?? [];
  if (known.length > 0) problems.push(`OpenFIGI knows ${alias} as ${known[0].name}: it is a real security, not a typo`);
  if (!filings) problems.push(`No tracked filing reports CUSIP ${alias}`);
  for (const name of filings?.reportedNames ?? []) {
    if (!sameCompany(name, stockName)) problems.push(`Filers reported ${alias} as "${name}", which does not match ${stockName}`);
  }
  if (problems.length > 0 || !filings) return { identifier: null, problems };
  return {
    problems,
    identifier: {
      identifier_type: "cusip",
      identifier_value: alias,
      namespace: "",
      valid_from: filings.firstPeriod,
      valid_to: dayAfter(filings.latestPeriod),
      source_reference: filings.firstSourceUrl,
    },
  };
}

// A recorded CUSIP's start date is the earliest quarter our filings reported it when it was added. Once
// older quarters are imported, filings may report it earlier; its start then moves back to that quarter,
// with that filing as evidence, as long as every name filers used matches the stock. A CUSIP recorded
// more than once (for different periods) is left for a person.
export function planEarlierStart(
  recorded: { validFrom: string; recordedTimes: number },
  stockName: string,
  filings: FilingEvidence | null,
): { validFrom: string; sourceReference: string } | { problem: string } | null {
  if (!filings || filings.firstPeriod >= recorded.validFrom) return null;
  if (recorded.recordedTimes > 1) return { problem: "the CUSIP is recorded for more than one period" };
  const mismatch = filings.reportedNames.find((name) => !sameCompany(name, stockName));
  if (mismatch) return { problem: `filers reported it as "${mismatch}", which does not match ${stockName}` };
  return { validFrom: filings.firstPeriod, sourceReference: filings.firstSourceUrl };
}

// One investor's shares under the old CUSIP in the last quarter it was reported, and of the stock in the
// next quarter.
export type Continuity = { investor: string; before: number; after: number };

// An earlier CUSIP of a stock, replaced in a corporate action that converted it one-for-one (Liberty
// Media's Liberty Live tracking stock into Liberty Live Holdings on 15 December 2025): recorded as a CUSIP
// of the stock from the earliest quarter our filings report it until the conversion date. It must be a
// real security that is no longer listed, the conversion must have an official source, and at least
// one investor's share count must carry over unchanged, which shows the conversion was one-for-one.
// Conversions at other ratios are not linked: their share counts are not comparable.
export function planPredecessor(input: {
  cusip: string;
  stockName: string;
  stockCusips: { cusip: string; validFrom: string; validTo: string | null }[];
  listed: FigiListing | null; // OpenFIGI's current US listing of the old CUSIP.
  known: unknown; // OpenFIGI's result including delisted securities.
  filings: FilingEvidence | null;
  until: string; // The conversion date; the old CUSIP identifies the stock before it.
  source: string; // An official record of the conversion.
  continuity: Continuity[];
}): { identifier: PlannedIdentifier | null; problems: string[] } {
  const { cusip, stockName, stockCusips, listed, known, filings, until, source, continuity } = input;
  const problems: string[] = [];
  if (!isValidCusip(cusip)) problems.push(`${cusip} is not a valid CUSIP`);
  const record = (known as { data?: { name?: string }[] } | null)?.data ?? [];
  if (record.length === 0) problems.push(`OpenFIGI does not know ${cusip} as a security`);
  if (listed) problems.push(`${cusip} is still listed (${listed.ticker}); only a CUSIP that is no longer listed can be a predecessor`);
  if (!/^https:\/\/\S+$/.test(source)) problems.push("The source must be the https address of an official record, such as the company's release or SEC filing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until))) problems.push(`${until} is not a date (YYYY-MM-DD)`);
  if (!filings) problems.push(`No tracked filing reports CUSIP ${cusip}`);
  else {
    if (filings.latestPeriod >= until) problems.push(`Filings report ${cusip} for ${filings.latestPeriod}, on or after the conversion date ${until}`);
    for (const name of filings.reportedNames) {
      if (!sameCompany(name, stockName)) problems.push(`Filers reported ${cusip} as "${name}", which does not match ${stockName}`);
    }
    const overlapping = stockCusips.filter((window) => window.validFrom < until && (window.validTo === null || window.validTo > filings.firstPeriod));
    for (const window of overlapping) problems.push(`The stock's CUSIP ${window.cusip} already applies from ${window.validFrom}, before ${until}`);
  }
  if (continuity.length === 0) problems.push("No investor reported both the old CUSIP's last quarter and the next quarter, so the conversion cannot be checked");
  else if (!continuity.some((row) => row.before === row.after)) {
    problems.push(`No investor's share count carried over unchanged (${continuity.map((row) => `${row.investor}: ${row.before} → ${row.after}`).join(", ")}); the conversion may not be one-for-one`);
  }
  if (problems.length > 0 || !filings) return { identifier: null, problems };
  return {
    problems,
    identifier: {
      identifier_type: "cusip",
      identifier_value: cusip,
      namespace: "",
      valid_from: filings.firstPeriod,
      valid_to: until,
      source_reference: source,
    },
  };
}

export type PlannedConversion = {
  from_cusip: string;
  shares_per_share: string; // Exact, as the official record states it.
  effective_date: string;
  description: string;
  source_reference: string;
};

// A corporate action in which holders of another security received shares of the stock at a fixed
// ratio (Sirius XM's 9 September 2024 merger: 0.1 new share per Sirius XM share), recorded with its
// official source. The converted security must be real and reported by our filings in the quarter
// before the conversion, and the stock must be identified in the quarter of the conversion, so stock
// pages can show the shares received. heldBefore: investors' shares of the converted security then.
export function planConversion(input: {
  fromCusip: string;
  ratio: string;
  effectiveDate: string;
  description: string;
  source: string;
  known: unknown; // OpenFIGI's result for the converted security, including delisted securities.
  heldBefore: { investor: string; shares: number }[];
  stockIdentified: boolean; // The stock has a CUSIP for the quarter that includes the conversion.
  fromIsStock: boolean; // The converted CUSIP already identifies the stock then.
}): { conversion: PlannedConversion | null; problems: string[] } {
  const { fromCusip, ratio, effectiveDate, description, source, known, heldBefore, stockIdentified, fromIsStock } = input;
  const problems: string[] = [];
  if (!isValidCusip(fromCusip)) problems.push(`${fromCusip} is not a valid CUSIP`);
  if (((known as { data?: unknown[] } | null)?.data ?? []).length === 0) problems.push(`OpenFIGI does not know ${fromCusip} as a security`);
  if (!/^\d+(\.\d+)?$/.test(ratio) || !(Number(ratio) > 0)) problems.push(`${ratio} is not a positive number of shares per share`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(Date.parse(effectiveDate))) problems.push(`${effectiveDate} is not a date (YYYY-MM-DD)`);
  if (description.trim() === "") problems.push("The description is empty");
  if (!/^https:\/\/\S+$/.test(source)) problems.push("The source must be the https address of an official record, such as the company's release or SEC filing");
  if (heldBefore.length === 0) problems.push(`No tracked filing reports ${fromCusip} for the quarter before ${effectiveDate}, so no holding would change`);
  if (!stockIdentified) problems.push(`The stock has no CUSIP for the quarter that includes ${effectiveDate}, so received shares would not be matched`);
  if (fromIsStock) problems.push(`${fromCusip} already identifies the stock at that time`);
  if (problems.length > 0) return { conversion: null, problems };
  return {
    problems,
    conversion: { from_cusip: fromCusip, shares_per_share: ratio, effective_date: effectiveDate, description: description.trim(), source_reference: source },
  };
}
