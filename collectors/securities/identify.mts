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

export type PlannedSecurity = {
  security: { issuer_name: string; share_class: string | null; security_type: string };
  identifiers: { identifier_type: string; identifier_value: string; namespace: string; valid_from: string; source_reference: string }[];
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
