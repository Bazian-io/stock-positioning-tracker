// Shared test data: a synthetic 13F-HR in the EDGAR full-submission format (no real investor
// data) and helpers that derive amendments from it.
import { readFile } from "node:fs/promises";
import { parseFullSubmission, type Holding } from "../parse.mts";
import type { SourceFiling } from "../store.mts";

export const sample = await readFile(new URL("./sample-13f-hr.txt", import.meta.url), "utf8");

export function sourceFiling(text = sample, overrides: Partial<SourceFiling> = {}): SourceFiling {
  return {
    ...parseFullSubmission(text),
    filedAt: "2026-08-14T20:05:04.000Z",
    valueMultiplier: 1,
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000026000001/0000000000-26-000001.txt",
    sourceChecksum: "a".repeat(64),
    ...overrides,
  };
}

// The sample as a 13F-HR/A cover page; amendmentNo is omitted when number is null.
export function amendmentText(type: string, number: number | null): string {
  const amendmentNo = number === null ? "" : `<amendmentNo>${number}</amendmentNo>`;
  return sample
    .replace("<TYPE>13F-HR\n", "<TYPE>13F-HR/A\n")
    .replace("<submissionType>13F-HR<", "<submissionType>13F-HR/A<")
    .replace(
      "<isAmendment>false</isAmendment>",
      `<isAmendment>true</isAmendment>${amendmentNo}<amendmentInfo><amendmentType>${type}</amendmentType></amendmentInfo>`,
    );
}

export const sampleRows = sourceFiling().holdings;

// Positions the sample does not report, for new-holdings amendments.
export const newRows: Holding[] = [
  { ...sampleRows[0], issuer: "NEW HOLDING ONE", cusip: "11111A111", quantity: "30", value: "900", raw: { cusip: "11111A111" } },
  { ...sampleRows[0], issuer: "NEW HOLDING TWO", cusip: "22222B222", quantity: "20", value: "600", raw: { cusip: "22222B222" } },
];

// A filing by the sample manager for the sample quarter, with chosen rows and amendment details.
export function variant(
  accessionNumber: string,
  filedAt: string,
  amendmentType: SourceFiling["amendmentType"],
  amendmentNumber: number,
  holdings: Holding[],
  valueMultiplier: 1 | 1000 = 1,
): SourceFiling {
  const rows = holdings.map((holding, index) => ({ ...holding, sourceRow: index + 1 }));
  return sourceFiling(sample, {
    accessionNumber,
    filedAt,
    formType: amendmentType === "none" ? "13F-HR" : "13F-HR/A",
    amendmentType,
    amendmentNumber,
    valueMultiplier,
    holdings: rows,
    entryTotal: rows.length,
    valueTotal: String(rows.reduce((sum, holding) => sum + Number(holding.value), 0)),
  });
}
