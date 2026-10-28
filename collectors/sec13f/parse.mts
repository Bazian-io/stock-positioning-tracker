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
  formType: "13F-HR";
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

// 13F values are whole dollars in filings made from 2023-01-03 (including amendments to older
// quarters) and thousands of dollars before that, so the unit follows the filing date.
export function valueMultiplier(filedAt: string): 1 | 1000 {
  return filedAt >= "2023-01-03" ? 1 : 1000;
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
// and the information table XML. Rejects filings whose table disagrees with their summary page.
export function parseFullSubmission(submissionText: string): Filing13F {
  const accessionNumber = /^ACCESSION NUMBER:\s*(\S+)/m.exec(submissionText)?.[1] ?? fail("Missing accession number");
  const documents = new Map<string, string>();
  for (const [, body] of submissionText.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g)) {
    const type = /<TYPE>([^\r\n<]+)/.exec(body)?.[1].trim();
    const xml = /<XML>([\s\S]*?)<\/XML>/.exec(body)?.[1].trim();
    if (type && xml) documents.set(type, xml);
  }

  const submission = path(parser.parse(documents.get("13F-HR") ?? fail("Missing 13F-HR XML cover document (older text-format filings are not supported)")), "edgarSubmission");
  const submissionType = text(submission, "headerData", "submissionType");
  if (submissionType !== "13F-HR") fail(`Only original 13F-HR filings are supported, not ${submissionType}`);
  const cover = path(submission, "formData", "coverPage");
  const summary = path(submission, "formData", "summaryPage");

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
  if (valueSum !== toUnits(filing.valueTotal)) {
    fail(`Information table values sum to ${valueSum / BigInt(10_000)}; the summary page reports ${filing.valueTotal}`);
  }
  return filing;
}
