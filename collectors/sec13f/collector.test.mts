import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedPortfolio } from "./amendments.mts";
import { amendmentText, newRows, sample, sampleRows, sourceFiling, variant } from "./fixtures/filings.mts";
import { parseFullSubmission, toUnits, valueMultiplier } from "./parse.mts";
import {
  createSecClient, findFiling, fullSubmissionUrl, normalizeCik, normalizeQuarter, type SecClient,
} from "./sec.mts";
import { comparePortfolio, compareStored, filingRow, holdingRow, type FilingIds, type SourceFiling } from "./store.mts";

const ids: FilingIds = { investorId: "investor-1", runId: "run-1", originalFilingId: null };

// Stand-in for SEC's submissions index: recent filings (newest first) plus one older page.
function fakeSecIndex() {
  const columns = (rows: [form: string, accession: string, reportDate: string, acceptedAt: string][]) => ({
    form: rows.map((row) => row[0]),
    accessionNumber: rows.map((row) => row[1]),
    reportDate: rows.map((row) => row[2]),
    acceptanceDateTime: rows.map((row) => row[3]),
  });
  const responses: Record<string, unknown> = {
    "https://data.sec.gov/submissions/CIK0000000001.json": {
      filings: {
        recent: columns([
          ["4", "0000000000-26-000009", "", "2026-09-01T20:00:00.000Z"],
          ["13F-HR", "0000000000-26-000008", "2026-06-30", "2026-08-14T20:05:04.000Z"],
          ["13F-HR", "0000000000-26-000005", "2026-03-31", "2026-05-15T20:06:05.000Z"],
          ["13F-HR/A", "0000000000-25-000006", "2025-03-31", "2025-11-14T21:00:00.000Z"],
          ["13F-HR/A", "0000000000-25-000004", "2025-03-31", "2025-08-14T20:10:02.000Z"],
          ["13F-HR", "0000000000-25-000002", "2025-03-31", "2025-05-15T20:06:43.000Z"],
        ]),
        files: [{ name: "CIK0000000001-submissions-001.json" }],
      },
    },
    "https://data.sec.gov/submissions/CIK0000000001-submissions-001.json": columns([
      ["13F-HR", "0000000000-16-000001", "2015-12-31", "2016-02-16T21:00:00.000Z"],
    ]),
  };
  const requested: string[] = [];
  const sec: SecClient = {
    async get(url) {
      requested.push(url);
      return { url, text: JSON.stringify(responses[url]), sha256: "" };
    },
  };
  return { sec, requested };
}

// The same filing as the Supabase API returns it: numeric(24,4) text and timestamps with offsets.
function storedCopy(source: SourceFiling, filingIds = ids) {
  const filing = filingRow(source, filingIds);
  return {
    filing: {
      ...filing,
      import_status: "complete",
      filed_at: source.filedAt.replace(".000Z", "+00:00"),
      reported_total_value: `${filing.reported_total_value}.0000`,
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
  assert.equal(filing.amendmentType, "none");
  assert.equal(filing.amendmentNumber, 0);
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

test("rejects unsupported forms, inconsistent amendment flags and malformed amounts", () => {
  assert.throws(
    () => parseFullSubmission(sample.replace("<submissionType>13F-HR<", "<submissionType>13F-NT<")),
    /Only 13F-HR filings and their amendments are supported, not 13F-NT/,
  );
  assert.throws(
    () => parseFullSubmission(sample.replace("<submissionType>13F-HR<", "<submissionType>13F-HR/A<")),
    /13F-HR\/A cover page has isAmendment=false/,
  );
  assert.throws(() => parseFullSubmission("ACCESSION NUMBER: 0000000000-26-000001"), /Missing 13F-HR/);
  assert.throws(
    () => parseFullSubmission(sample.replace("<ns1:value>1000<", "<ns1:value>1,000<")),
    /Invalid value in information table row 1/,
  );
});

test("reads the amendment type and number from 13F-HR/A cover pages", () => {
  const newHoldings = parseFullSubmission(amendmentText("NEW HOLDINGS", 2));
  assert.equal(newHoldings.formType, "13F-HR/A");
  assert.equal(newHoldings.amendmentType, "new_holdings");
  assert.equal(newHoldings.amendmentNumber, 2);
  assert.equal(parseFullSubmission(amendmentText("RESTATEMENT", 1)).amendmentType, "restatement");
  assert.throws(() => parseFullSubmission(amendmentText("CORRECTION", 1)), /Unsupported amendment type: CORRECTION/);
  assert.throws(() => parseFullSubmission(amendmentText("RESTATEMENT", null)), /Invalid amendmentNo/);
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

test("quarters can be given as quarter-end dates or labels", () => {
  assert.equal(normalizeQuarter("2026-03-31"), "2026-03-31");
  assert.equal(normalizeQuarter("2026Q1"), "2026-03-31");
  assert.equal(normalizeQuarter("2025-q4"), "2025-12-31");
  assert.throws(() => normalizeQuarter("2026-03-30"), /Invalid quarter/);
  assert.throws(() => normalizeQuarter("2026Q5"), /Invalid quarter/);
});

test("selects a quarter's original 13F-HR together with its amendments, oldest first", async () => {
  const { sec, requested } = fakeSecIndex();
  const latest = await findFiling(sec, "0000000001", "13F-HR");
  assert.equal(latest.accessionNumber, "0000000000-26-000008");
  assert.deepEqual(latest.amendments, []);
  assert.deepEqual(await findFiling(sec, "0000000001", "13F-HR", "2026-03-31"), {
    accessionNumber: "0000000000-26-000005",
    form: "13F-HR",
    acceptedAt: "2026-05-15T20:06:05.000Z",
    reportDate: "2026-03-31",
    amendments: [],
  });
  const amended = await findFiling(sec, "0000000001", "13F-HR", "2025-03-31");
  assert.equal(amended.accessionNumber, "0000000000-25-000002");
  assert.deepEqual(amended.amendments.map((entry) => [entry.form, entry.accessionNumber]), [
    ["13F-HR/A", "0000000000-25-000004"],
    ["13F-HR/A", "0000000000-25-000006"],
  ]);
  // Each lookup read only the recent index; the older page was not needed.
  assert.equal(requested.length, 3);
});

test("historical quarters outside the recent index are found in older index pages", async () => {
  const { sec, requested } = fakeSecIndex();
  assert.equal((await findFiling(sec, "0000000001", "13F-HR", "2015-12-31")).accessionNumber, "0000000000-16-000001");
  assert.equal(requested.at(-1), "https://data.sec.gov/submissions/CIK0000000001-submissions-001.json");
  await assert.rejects(findFiling(sec, "0000000001", "13F-HR", "2014-12-31"), /No 13F-HR filing for 2014-12-31/);
});

test("new-holdings amendments add their rows to the original report", () => {
  const original = variant("0000000000-26-000001", "2026-08-14T20:05:04.000Z", "none", 0, sampleRows);
  const addition = variant("0000000000-26-000002", "2026-11-14T21:00:00.000Z", "new_holdings", 1, newRows);
  const portfolio = reportedPortfolio([addition, original]);
  assert.deepEqual(portfolio.filings, [original, addition]);
  assert.equal(portfolio.rows, 6);
  assert.equal(portfolio.valueUnits, toUnits("6050"));
  assert.deepEqual(portfolio.warnings, []);
  // Each filing keeps its own unit: an original in thousands plus an amendment in dollars.
  const inThousands = { ...original, valueMultiplier: 1000 as const };
  assert.equal(reportedPortfolio([inThousands, addition]).valueUnits, toUnits("4551500"));
});

test("a restatement replaces everything filed before it; later new holdings still add", () => {
  // Same shape as Berkshire Hathaway's Q3 2023 filings: original, restatement, then new holdings.
  const original = variant("0000000000-26-000001", "2026-08-14T20:05:04.000Z", "none", 0, sampleRows);
  const earlyAddition = variant("0000000000-26-000002", "2026-08-15T20:00:00.000Z", "new_holdings", 1, [newRows[0]]);
  const restatement = variant("0000000000-26-000003", "2026-08-16T20:00:00.000Z", "restatement", 2, sampleRows);
  const lateAddition = variant("0000000000-26-000004", "2027-05-15T20:00:00.000Z", "new_holdings", 3, [newRows[1]]);
  const portfolio = reportedPortfolio([lateAddition, restatement, original, earlyAddition]);
  assert.deepEqual(portfolio.filings.map((filing) => filing.accessionNumber), ["0000000000-26-000003", "0000000000-26-000004"]);
  assert.equal(portfolio.rows, 5);
  assert.equal(portfolio.valueUnits, toUnits("5150"));
  assert.deepEqual(portfolio.warnings, []);
});

test("warns about amendments that would double-count or drop holdings", () => {
  const original = variant("0000000000-26-000001", "2026-08-14T20:05:04.000Z", "none", 0, sampleRows);
  const repeat = variant("0000000000-26-000002", "2026-08-15T20:00:00.000Z", "new_holdings", 1, [sampleRows[0], newRows[0]]);
  assert.deepEqual(reportedPortfolio([original, repeat]).warnings, [
    "0000000000-26-000002: new-holdings amendment repeats 1 row(s) already reported; totals may double-count",
  ]);
  const partial = variant("0000000000-26-000003", "2026-08-16T20:00:00.000Z", "restatement", 1, [sampleRows[0]]);
  assert.deepEqual(reportedPortfolio([original, partial]).warnings, [
    "0000000000-26-000003: restatement reports 1 rows but replaces 4; check that it is complete",
  ]);
});

test("verification accepts an exact stored copy, including amendment links", () => {
  const original = sourceFiling();
  assert.deepEqual(compareStored(original, storedCopy(original), ids), []);
  const amendment = sourceFiling(amendmentText("NEW HOLDINGS", 1));
  const linked = { ...ids, originalFilingId: "original-filing-id" };
  assert.deepEqual(compareStored(amendment, storedCopy(amendment, linked), linked), []);
});

test("verification reports changed, missing and incomplete stored data", () => {
  const source = sourceFiling(amendmentText("NEW HOLDINGS", 1));
  const linked = { ...ids, originalFilingId: "original-filing-id" };
  const stored = storedCopy(source, linked);
  stored.filing.import_status = "pending";
  stored.filing.amendment_type = "restatement";
  stored.filing.original_filing_id = "another-filing-id";
  stored.holdings[2].quantity = "11.0000";
  stored.holdings[1].raw_row = { ...stored.holdings[1].raw_row, cusip: "999999999" };
  stored.holdings.pop();
  const problems = compareStored(source, stored, linked);
  assert.ok(problems.some((problem) => problem.startsWith("Filing import_status")));
  assert.ok(problems.some((problem) => problem.startsWith('Filing amendment_type: SEC "new_holdings"')));
  assert.ok(problems.some((problem) => problem.startsWith("Filing original_filing_id")));
  assert.ok(problems.some((problem) => problem.startsWith("Row 3 quantity")));
  assert.ok(problems.some((problem) => problem.startsWith("Row 2 raw_row")));
  assert.ok(problems.some((problem) => problem === "SEC filing has 4 rows; database has 3"));
  assert.ok(problems.some((problem) => problem.startsWith("Stored rows sum to 3800")));
});

test("portfolio check catches replaced filings and double counting in the research views", () => {
  const original = variant("0000000000-26-000001", "2026-08-14T20:05:04.000Z", "none", 0, sampleRows);
  const restatement = variant("0000000000-26-000002", "2026-08-16T20:00:00.000Z", "restatement", 1, sampleRows);
  const addition = variant("0000000000-26-000003", "2027-05-15T20:00:00.000Z", "new_holdings", 2, [newRows[0]]);
  const expected = reportedPortfolio([original, restatement, addition]);
  const filingIds = new Map([["0000000000-26-000001", "id-1"], ["0000000000-26-000002", "id-2"], ["0000000000-26-000003", "id-3"]]);
  const correct = { filingIds: ["id-3", "id-2"], summary: { holding_row_count: 5, value_usd: "5450.0000" } };
  assert.deepEqual(comparePortfolio(expected, filingIds, correct), []);

  const doubleCounted = { filingIds: ["id-1", "id-2", "id-3"], summary: { holding_row_count: 9, value_usd: "10000.0000" } };
  assert.deepEqual(comparePortfolio(expected, filingIds, doubleCounted), [
    "portfolio_filings uses 3 filing(s); expected 0000000000-26-000002 + 0000000000-26-000003",
    "quarterly_portfolios rows: expected 5, database 9",
    "quarterly_portfolios value: expected 5450, database 10000.0000",
  ]);
  assert.deepEqual(comparePortfolio(expected, filingIds, { filingIds: [], summary: null }), [
    "portfolio_filings uses 0 filing(s); expected 0000000000-26-000002 + 0000000000-26-000003",
    "quarterly_portfolios has no row for this quarter",
  ]);
});
