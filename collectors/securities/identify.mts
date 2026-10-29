// Checks that a CUSIP and a ticker identify the same listed security, using two independent sources:
// OpenFIGI (CUSIP → ticker) and SEC's company ticker file (ticker → company and exchange). Each share
// class has its own CUSIP and ticker, so classes become separate securities.

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
export const OPENFIGI_URL = "https://api.openfigi.com/v3/mapping";

// Exchange names in SEC's ticker file and their ISO 10383 market identifier codes (MICs).
export const EXCHANGE_MICS: Record<string, string> = { Nasdaq: "XNAS", NYSE: "XNYS" };

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

export type FigiListing = { ticker: string; name: string; securityType: string; marketSector: string; compositeFigi: string };

// The US composite listing in an OpenFIGI mapping response for one identifier, if there is one.
export function usListing(response: unknown): FigiListing | null {
  const data = (Array.isArray(response) ? response[0] : null)?.data;
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
    if (figi.marketSector !== "Equity") problems.push(`OpenFIGI lists ${cusip} as ${figi.marketSector}, not Equity`);
  }
  if (!sec) problems.push(`${ticker} is not in SEC's company ticker file`);
  else if (!EXCHANGE_MICS[sec.exchange]) problems.push(`${ticker} trades on ${sec.exchange}; only ${Object.keys(EXCHANGE_MICS).join(" and ")} are supported`);
  if (!filings) problems.push(`No tracked filing reports CUSIP ${cusip}`);
  if (problems.length > 0 || !figi || !sec || !filings) return { plan: null, problems };
  return {
    problems,
    plan: {
      security: {
        issuer_name: sec.name,
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
