// Readable names for pages. Filings and listings name companies in many styles ("BANK OF AMER CORP",
// "Bank of America Corporation Common Stock"); pages show the company's name from Nasdaq's directory of
// US-listed securities without the share description ("Bank of America Corporation"), and shorter still
// without the legal form ("Bank of America"). The names as filed stay in the database unchanged.

// From the first word that describes the shares, to the end: "Common Stock", "Class A Ordinary
// Shares", "American Depositary Shares (each representing two (2) Ordinary Shares)".
const SHARE_DESCRIPTION = new RegExp(
  "\\s+(?:New\\s+)?(?:(?:Series|Class)\\s+[A-Z0-9]\\b|Common\\b|Ordinary\\b|American\\s+Deposit[ao]ry\\b|Deposit[ao]ry\\b|Spon\\w*\\b"
    + "|Subordinate\\b|Capital\\s+Stock\\b|Shares?\\s+of\\s+Beneficial\\b|Registered\\s+Shares?\\b|Units?\\b|Voting\\b|Shares\\b"
    + "|Warrants?\\b|Rights?\\b|ADRs?\\b|ADSs?\\b|REIT\\b).*$",
);
// Legal forms at the end of a name, such as ", Inc.", "Corporation" or "Company Ltd.".
const LEGAL_FORM = /(?:,?\s+(?:Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Company|Ltd\.?|Limited|plc|PLC|P\.L\.C\.|L\.P\.|LP|N\.V\.|NV|S\.A\.|SA|SE|AG|A\/S|ASA|AB|S\.p\.A\.|SpA|LLC|L\.L\.C\.))+\.?$/;

// "Coca-Cola Company (The) Common Stock" → the name "Coca-Cola Company", with "The" in front.
// Notes in brackets go: "(DE)", "(New)", "(Holding Company)".
function parse(listingName: string): { name: string; the: boolean } {
  const name = listingName.replace(/\)(?=\w)/g, ") ").split(" - ")[0].replace(SHARE_DESCRIPTION, "");
  const the = /\(The\)/.test(name);
  const cleaned = name.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").replace(/[\s,]+$/, "").trim();
  return cleaned === "" ? { name: listingName.trim(), the: false } : { name: cleaned, the };
}

// The company's name: "Bank of America Corporation", "The Coca-Cola Company".
export function companyName(listingName: string): string {
  const { name, the } = parse(listingName);
  return the ? `The ${name}` : name;
}

// The name pages show: "Bank of America", "Coca-Cola". Short brand names stay: "3M", "HP".
export function shortCompanyName(listingName: string): string {
  const { name } = parse(listingName);
  const short = name.replace(LEGAL_FORM, "").replace(/[\s,&]+$/, "").trim();
  return short.length >= 2 ? short : name;
}

// A stock's name on pages, from Nasdaq's directory when recorded, otherwise as identified.
export function stockName(stock: { listingName: string | null; issuerName: string }): string {
  return stock.listingName ? shortCompanyName(stock.listingName) : stock.issuerName;
}

// An investor's name on pages: its short display name when recorded, otherwise as filed.
export function investorName(investor: { displayName: string | null; name: string }): string {
  return investor.displayName ?? investor.name;
}
