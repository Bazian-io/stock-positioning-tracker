import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseFullSubmission, toUnits, valueMultiplier } from "./parse.mts";
import { createSecClient, fullSubmissionUrl, normalizeCik } from "./sec.mts";
import { compareStored, holdingRow, type SourceFiling } from "./store.mts";

// Synthetic filing in the EDGAR full-submission format; no real investor data.
const sample = await readFile(new URL("./fixtures/sample-13f-hr.txt", import.meta.url), "utf8");

function sourceFiling(text = sample): SourceFiling {
  return {
    ...parseFullSubmission(text),
    filedAt: "2026-08-14T20:05:04.000Z",
    valueMultiplier: 1,
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000026000001/0000000000-26-000001.txt",
    sourceChecksum: "a".repeat(64),
  };
}

// The same filing as the database returns it: numeric(24,4) text and an extra filing_id column.
function storedCopy(source: SourceFiling) {
  return {
    filing: {
      import_status: "complete",
      report_period: source.reportPeriod,
      reported_entry_count: source.entryTotal,
      reported_total_value: `${source.valueTotal}.0000`,
      value_multiplier: source.valueMultiplier,
      source_checksum: source.sourceChecksum,
    },
    holdings: source.holdings.map((holding) => {
      const row = holdingRow("stored-filing-id", holding);
      return { ...row, quantity: `${row.quantity}.0000`, reported_value: `${row.reported_value}.0000` };
    }),
  };
}

test("parses filing identity, summary totals and other managers", () => {
  const filing = parseFullSubmission(sample);
  assert.equal(filing.accessionNumber, "0000000000-26-000001");
  assert.equal(filing.formType, "13F-HR");
  assert.equal(filing.cik, "0000000001");
  assert.equal(filing.managerName, "Example Capital Management LLC");
  assert.equal(filing.reportPeriod, "2026-06-30");
  assert.equal(filing.reportType, "holdings");
  assert.equal(filing.entryTotal, 4);
  assert.equal(filing.valueTotal, "4550");
  assert.equal(filing.confidentialOmitted, true);
  assert.deepEqual(filing.otherManagers, [
    { relation: "included", sequenceNumber: "1", cik: null, fileNumber: "28-00001", name: "Example Insurance & Annuity Co" },
    { relation: "included", sequenceNumber: "2", cik: "0000000002", fileNumber: "28-00002", name: "Example Re Corp" },
  ]);
});

test("keeps every source row with exact identifiers, units and option flags", () => {
  const { holdings } = parseFullSubmission(sample);
  assert.deepEqual(holdings.map((holding) => holding.sourceRow), [1, 2, 3, 4]);
  assert.equal(holdings[0].issuer, "SMITH & JONES CO");
  assert.equal(holdings[0].otherManagers.length, 0);
  assert.equal(holdings[1].cusip, "012345678");
  assert.deepEqual(holdings[1].otherManagers, ["1", "2"]);
  assert.deepEqual(holdings.map((holding) => holding.positionType), ["long", "long", "put", "long"]);
  assert.deepEqual(holdings.map((holding) => holding.quantityType), ["SH", "SH", "SH", "PRN"]);
  assert.deepEqual(holdings.map((holding) => holding.value), ["1000", "2500", "300", "750"]);
  assert.deepEqual(
    [holdings[1].votingSole, holdings[1].votingShared, holdings[1].votingNone],
    ["0", "100", "0"],
  );
  assert.equal(holdings[1].raw.figi, "BBG000000001");
});

test("rejects filings whose information table disagrees with the summary page", () => {
  assert.throws(
    () => parseFullSubmission(sample.replace("<tableValueTotal>4550<", "<tableValueTotal>4551<")),
    /values sum to 4550; the summary page reports 4551/,
  );
  assert.throws(
    () => parseFullSubmission(sample.replace("<tableEntryTotal>4<", "<tableEntryTotal>5<")),
    /has 4 rows; the summary page reports 5/,
  );
});

test("rejects amendments, unknown documents and malformed amounts", () => {
  assert.throws(
    () => parseFullSubmission(sample.replace("<submissionType>13F-HR<", "<submissionType>13F-HR/A<")),
    /Only original 13F-HR/,
  );
  assert.throws(() => parseFullSubmission("ACCESSION NUMBER: 0000000000-26-000001"), /Missing 13F-HR/);
  assert.throws(
    () => parseFullSubmission(sample.replace("<ns1:value>1000<", "<ns1:value>1,000<")),
    /Invalid value in information table row 1/,
  );
});

test("value units follow the filing date, not the reporting quarter", () => {
  assert.equal(valueMultiplier("2022-11-14T21:01:07.000Z"), 1000);
  assert.equal(valueMultiplier("2023-01-03T15:00:00.000Z"), 1);
  assert.equal(toUnits("12.5"), BigInt(125_000));
  assert.equal(toUnits("577211815.0000"), toUnits("577211815"));
});

test("SEC requests require a contact User-Agent and use EDGAR archive paths", () => {
  assert.throws(() => createSecClient("Example Research"), /contact email/);
  assert.equal(normalizeCik("1067983"), "0001067983");
  assert.throws(() => normalizeCik("BRK"), /Invalid CIK/);
  assert.equal(
    fullSubmissionUrl("0001067983", "0001193125-26-352200"),
    "https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/0001193125-26-352200.txt",
  );
});

test("verification accepts an exact stored copy", () => {
  const source = sourceFiling();
  assert.deepEqual(compareStored(source, storedCopy(source)), []);
});

test("verification reports changed, missing and incomplete stored data", () => {
  const source = sourceFiling();
  const stored = storedCopy(source);
  stored.filing.import_status = "pending";
  stored.holdings[2].quantity = "11.0000";
  stored.holdings[1].raw_row = { ...stored.holdings[1].raw_row, cusip: "999999999" };
  stored.holdings.pop();
  const problems = compareStored(source, stored);
  assert.ok(problems.some((problem) => problem.startsWith("Filing import_status")));
  assert.ok(problems.some((problem) => problem.startsWith("Row 3 quantity")));
  assert.ok(problems.some((problem) => problem.startsWith("Row 2 raw_row")));
  assert.ok(problems.some((problem) => problem === "SEC filing has 4 rows; database has 3"));
  assert.ok(problems.some((problem) => problem.startsWith("Stored rows sum to 3800")));
});
