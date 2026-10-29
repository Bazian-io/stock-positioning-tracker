import { XMLParser } from "fast-xml-parser";

export type Holding = {
  sourceRow: number;
  issuer: string;
  titleOfClass: string | null;
  cusip: string | null;
  value: string;
  quantity: string;
  quantityType: "SH" | "PRN";
  positionType: "long" | "put" | "call";
  investmentDiscretion: string | null;
  otherManagers: string[];
  votingSole: string;
  votingShared: string;
  votingNone: string;
  raw: Record<string, unknown>;
};

export type OtherManager = {
  // "included": holdings of this manager are in the report; "reports_for_this_manager": another filer reports them.
  relation: "included" | "reports_for_this_manager";
  sequenceNumber: string | null;
  cik: string | null;
  fileNumber: string | null;
  name: string | null;
};

export type Filing13F = {
  accessionNumber: string;
  formType: "13F-HR" | "13F-HR/A";
  // Form 13F amendments either restate the whole report or add new holdings entries to it.
  amendmentType: "none" | "restatement" | "new_holdings";
  amendmentNumber: number;
  cik: string;
  managerName: string;
  reportPeriod: string;
  reportType: "holdings" | "combination";
  entryTotal: number;
  valueTotal: string;
  confidentialOmitted: boolean;
  otherManagers: OtherManager[];
  holdings: Holding[];
};

// Fits the database columns: numeric(24,4) for amounts and bigint for voting counts.
const DECIMAL = /^\d{1,20}(\.\d{1,4})?$/;
const INTEGER = /^\d{1,18}$/;

const REPORT_TYPES: Record<string, Filing13F["reportType"]> = {
  "13F HOLDINGS REPORT": "holdings",
  "13F COMBINATION REPORT": "combination",
};

const AMENDMENT_TYPES: Record<string, Filing13F["amendmentType"]> = {
  RESTATEMENT: "restatement",
  "NEW HOLDINGS": "new_holdings",
};

const REPEATED_ELEMENTS = new Set([
  "informationTable.infoTable",
  "edgarSubmission.formData.coverPage.otherManagersInfo.otherManager",
  "edgarSubmission.formData.summaryPage.otherManagers2Info.otherManager2",
]);

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // Keep source text exact, e.g. leading zeros in CIKs and CUSIPs.
  htmlEntities: true, // Also decode numeric character references such as &#38;.
  isArray: (_name, jpath) => REPEATED_ELEMENTS.has(String(jpath)),
});

function fail(message: string): never {
  throw new Error(message);
}

function path(node: unknown, ...names: string[]): unknown {
  return names.reduce<unknown>(
    (current, name) => (typeof current === "object" && current !== null ? (current as Record<string, unknown>)[name] : undefined),
    node,
  );
}

function text(node: unknown, ...names: string[]): string | null {
  const value = path(node, ...names);
  return typeof value === "string" && value !== "" ? value : null;
}

function list(node: unknown, ...names: string[]): unknown[] {
  const value = path(node, ...names);
  return Array.isArray(value) ? value : [];
}

function matching(value: string | null, pattern: RegExp, label: string): string {
  if (value === null || !pattern.test(value)) fail(`Invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

// Exact decimal arithmetic at the database scale, avoiding floating-point rounding.
export function toUnits(decimal: string): bigint {
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt(whole + fraction.padEnd(4, "0"));
}

// Filers round each row's value to a whole dollar (or thousand), so the summary page's total can
// differ from the sum of the rows by up to half a unit per row (ValueAct, Elliott and TCI by 1 or 2).
// The database applies the same rule when a filing is completed.
export function totalMatchesRows(valueSum: bigint, valueTotal: bigint, rows: number): boolean {
  const difference = valueSum > valueTotal ? valueSum - valueTotal : valueTotal - valueSum;
  return difference * BigInt(2) <= BigInt(rows) * toUnits("1");
}

// 13F values are whole dollars in filings made from 2023-01-03 (including amendments to older
// quarters) and thousands of dollars before that, so the unit follows the filing date.
export function valueMultiplier(filedAt: string): 1 | 1000 {
  return filedAt >= "2023-01-03" ? 1 : 1000;
}

export type ApparentUnit = { unit: "dollars" | "thousands" | "unclear"; valuePerShare: number | null };

// The unit a filing's values appear to be in, from its median value per share of long share rows:
// share prices are mostly $2 to $1,000, so in dollars that is the value per share, and in thousands of
// dollars it is below 0.5. Between 0.5 and 2, or with fewer than 5 share rows, the unit is unclear: a
// single cheap security proves nothing (D. E. Shaw's one-row amendment: warrants worth $0.11 each).
export function apparentValueUnit(holdings: Holding[]): ApparentUnit {
  const prices = holdings
    .filter((holding) => holding.positionType === "long" && holding.quantityType === "SH" && Number(holding.quantity) > 0)
    .map((holding) => Number(holding.value) / Number(holding.quantity))
    .sort((a, b) => a - b);
  if (prices.length === 0) return { unit: "unclear", valuePerShare: null };
  const valuePerShare = prices[Math.floor(prices.length / 2)];
  if (prices.length < 5) return { unit: "unclear", valuePerShare };
  return { unit: valuePerShare < 0.5 ? "thousands" : valuePerShare > 2 ? "dollars" : "unclear", valuePerShare };
}

// The unit to store for a filing: SEC's rule by filing date, checked against the values themselves.
// Some managers kept reporting thousands after 2023 (Baupost, Duquesne); storing those in dollars would
// make them a thousand times too small, so such a filing is refused until a person has checked it and
// confirmed values in thousands. A filing before 2023 that appears to be in dollars is refused too.
export function storedValueMultiplier(
  filedAt: string,
  apparent: ApparentUnit,
  thousandsConfirmed: boolean,
): { multiplier: 1 | 1000 } | { problem: string } {
  const rule = valueMultiplier(filedAt);
  const typical = apparent.valuePerShare?.toFixed(3) ?? "unknown";
  if (rule === 1 && apparent.unit === "thousands") {
    if (thousandsConfirmed) return { multiplier: 1000 };
    return {
      problem: `values appear to be in thousands of dollars (median value per share ${typical}), although filed after `
        + "2 January 2023, when SEC switched 13F values to dollars. Check the filing; if it reports thousands, run again with --values-in-thousands",
    };
  }
  if (rule === 1000 && apparent.unit === "dollars") {
    return { problem: `values appear to be in dollars (median value per share ${typical}), although filed before 3 January 2023, when 13F values were in thousands` };
  }
  return { multiplier: rule };
}

function toHolding(row: unknown, sourceRow: number): Holding {
  const label = (field: string) => `${field} in information table row ${sourceRow}`;
  const quantityType = text(row, "shrsOrPrnAmt", "sshPrnamtType");
  if (quantityType !== "SH" && quantityType !== "PRN") fail(`Invalid ${label("sshPrnamtType")}: ${quantityType}`);
  const putCall = text(row, "putCall")?.toLowerCase() ?? null;
  if (putCall !== null && putCall !== "put" && putCall !== "call") fail(`Invalid ${label("putCall")}: ${putCall}`);
  return {
    sourceRow,
    issuer: text(row, "nameOfIssuer") ?? fail(`Missing ${label("nameOfIssuer")}`),
    titleOfClass: text(row, "titleOfClass"),
    cusip: text(row, "cusip"),
    value: matching(text(row, "value"), DECIMAL, label("value")),
    quantity: matching(text(row, "shrsOrPrnAmt", "sshPrnamt"), DECIMAL, label("sshPrnamt")),
    quantityType,
    positionType: putCall ?? "long",
    investmentDiscretion: text(row, "investmentDiscretion"),
    otherManagers: text(row, "otherManager")?.split(/[\s,]+/).filter(Boolean) ?? [],
    votingSole: matching(text(row, "votingAuthority", "Sole"), INTEGER, label("Sole voting authority")),
    votingShared: matching(text(row, "votingAuthority", "Shared"), INTEGER, label("Shared voting authority")),
    votingNone: matching(text(row, "votingAuthority", "None"), INTEGER, label("None voting authority")),
    raw: JSON.parse(JSON.stringify(row)),
  };
}

// Parses an EDGAR full submission (<accession>.txt): an SGML header plus the cover/summary XML
// and the information table XML. Rejects filings whose table disagrees with their summary page by
// more than rounding.
export function parseFullSubmission(submissionText: string): Filing13F {
  const accessionNumber = /^ACCESSION NUMBER:\s*(\S+)/m.exec(submissionText)?.[1] ?? fail("Missing accession number");
  const documents = new Map<string, string>();
  for (const [, body] of submissionText.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g)) {
    const type = /<TYPE>([^\r\n<]+)/.exec(body)?.[1].trim();
    const xml = /<XML>([\s\S]*?)<\/XML>/.exec(body)?.[1].trim();
    if (type && xml) documents.set(type, xml);
  }

  const coverDocument = documents.get("13F-HR") ?? documents.get("13F-HR/A")
    ?? fail("Missing 13F-HR XML cover document (older text-format filings are not supported)");
  const submission = path(parser.parse(coverDocument), "edgarSubmission");
  const submissionType = text(submission, "headerData", "submissionType");
  if (submissionType !== "13F-HR" && submissionType !== "13F-HR/A") {
    fail(`Only 13F-HR filings and their amendments are supported, not ${submissionType}`);
  }
  const cover = path(submission, "formData", "coverPage");
  const summary = path(submission, "formData", "summaryPage");
  const isAmendment = ["true", "1"].includes(text(cover, "isAmendment") ?? "");
  if (isAmendment !== (submissionType === "13F-HR/A")) fail(`${submissionType} cover page has isAmendment=${isAmendment}`);
  const amendmentTypeText = text(cover, "amendmentInfo", "amendmentType") ?? "";

  const [, month, day, year] = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text(cover, "reportCalendarOrQuarter") ?? "")
    ?? fail("Invalid reportCalendarOrQuarter");
  const reportTypeText = text(cover, "reportType") ?? "";
  const infoTable = documents.get("INFORMATION TABLE");
  const holdings = (infoTable ? list(parser.parse(infoTable), "informationTable", "infoTable") : []).map(
    (row, index) => toHolding(row, index + 1),
  );

  const filing: Filing13F = {
    accessionNumber,
    formType: submissionType,
    amendmentType: isAmendment
      ? AMENDMENT_TYPES[amendmentTypeText] ?? fail(`Unsupported amendment type: ${amendmentTypeText}`)
      : "none",
    // Some filers pad the number ("01" in Pershing Square's Q4 2021 amendment).
    amendmentNumber: isAmendment ? Number(matching(text(cover, "amendmentNo"), /^0{0,3}[1-9]\d{0,3}$/, "amendmentNo")) : 0,
    cik: matching(text(submission, "headerData", "filerInfo", "filer", "credentials", "cik"), /^\d{10}$/, "filer CIK"),
    managerName: text(cover, "filingManager", "name") ?? fail("Missing filing manager name"),
    reportPeriod: `${year}-${month}-${day}`,
    reportType: REPORT_TYPES[reportTypeText] ?? fail(`Unsupported report type: ${reportTypeText}`),
    entryTotal: Number(matching(text(summary, "tableEntryTotal"), INTEGER, "tableEntryTotal")),
    valueTotal: matching(text(summary, "tableValueTotal"), DECIMAL, "tableValueTotal"),
    confidentialOmitted: ["true", "1"].includes(text(summary, "isConfidentialOmitted") ?? ""),
    otherManagers: [
      ...list(cover, "otherManagersInfo", "otherManager").map((manager) => ({
        relation: "reports_for_this_manager" as const,
        sequenceNumber: null,
        cik: text(manager, "cik"),
        fileNumber: text(manager, "form13FFileNumber"),
        name: text(manager, "name"),
      })),
      ...list(summary, "otherManagers2Info", "otherManager2").map((entry) => ({
        relation: "included" as const,
        sequenceNumber: text(entry, "sequenceNumber"),
        cik: text(entry, "otherManager", "cik"),
        fileNumber: text(entry, "otherManager", "form13FFileNumber"),
        name: text(entry, "otherManager", "name"),
      })),
    ],
    holdings,
  };

  if (holdings.length !== filing.entryTotal) {
    fail(`Information table has ${holdings.length} rows; the summary page reports ${filing.entryTotal}`);
  }
  const valueSum = holdings.reduce((sum, holding) => sum + toUnits(holding.value), BigInt(0));
  if (!totalMatchesRows(valueSum, toUnits(filing.valueTotal), holdings.length)) {
    fail(`Information table values sum to ${valueSum / BigInt(10_000)}; the summary page reports ${filing.valueTotal}`);
  }
  return filing;
}
