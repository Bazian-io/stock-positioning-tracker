import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedPortfolio } from "./amendments.mts";
import { amendmentText, newRows, sample, sampleRows, sourceFiling, variant } from "./fixtures/filings.mts";
import { apparentValueUnit, parseFullSubmission, storedValueMultiplier, toUnits, valueMultiplier, type Holding } from "./parse.mts";
import {
  cikHistory, ciksForQuarter, createSecClient, findFiling, findQuarterFilings, fullSubmissionUrl, normalizeCik, normalizeQuarter,
  quarterRange, type SecClient,
} from "./sec.mts";
import { sourceRow, unreportedFields } from "./source-row.mts";
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
        files: [{ name: "CIK0000000001-submissions-001.json", filingTo: "2017-02-09" }],
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

// Stand-in for an investor that moved its 13F reporting to a new legal entity: the former CIK
// (2) reported through Q2 2024, the current CIK (1) from Q3 2024 and also amended Q2 2024.
function reorganizedSec(currentAlsoReports = false) {
  const columns = (rows: [form: string, accession: string, reportDate: string, acceptedAt: string][]) => ({
    form: rows.map((row) => row[0]),
    accessionNumber: rows.map((row) => row[1]),
    reportDate: rows.map((row) => row[2]),
    acceptanceDateTime: rows.map((row) => row[3]),
  });
  const responses: Record<string, unknown> = {
    "https://data.sec.gov/submissions/CIK0000000001.json": {
      name: "EXAMPLE HOLDINGS INC",
      formerNames: [{ name: "EXAMPLE FUNDING INC", to: "2024-10-01T00:00:00.000Z" }],
      filings: {
        recent: columns([
          ["13F-HR", "0000000001-26-000002", "2026-06-30", "2026-08-07T16:00:00.000Z"],
          ["13F-HR", "0000000001-24-000003", "2024-09-30", "2024-11-13T16:00:00.000Z"],
          ["13F-HR/A", "0000000001-24-000002", "2024-06-30", "2024-10-15T16:00:00.000Z"],
          ...(currentAlsoReports ? [["13F-HR", "0000000001-24-000001", "2024-06-30", "2024-08-14T16:00:00.000Z"] as [string, string, string, string]] : []),
        ]),
        files: [],
      },
    },
    "https://data.sec.gov/submissions/CIK0000000002.json": {
      name: "EXAMPLE FINANCE INC",
      formerNames: [{ name: "EXAMPLE HOLDINGS INC", to: "2024-09-26T00:00:00.000Z" }],
      filings: {
        recent: columns([
          ["13F-HR", "0000000002-24-000002", "2024-06-30", "2024-08-13T16:00:00.000Z"],
          ["13F-HR", "0000000002-24-000001", "2024-03-31", "2024-05-10T16:00:00.000Z"],
        ]),
        files: [{ name: "CIK0000000002-submissions-001.json", filingTo: "2023-12-31" }],
      },
    },
    "https://data.sec.gov/submissions/CIK0000000002-submissions-001.json": columns([
      ["13F-HR", "0000000002-23-000004", "2023-09-30", "2023-11-13T16:00:00.000Z"],
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

test("raw_row keeps only what the columns cannot reproduce, and the SEC row is rebuilt exactly", () => {
  const { holdings } = parseFullSubmission(sample);
  // Row 2 has a field the parser does not read (figi) and a manager list written as "1, 2".
  assert.deepEqual(holdings.map((holding) => unreportedFields(holding)), [{}, { figi: "BBG000000001", otherManager: "1, 2" }, {}, {}]);
  // Padded numbers, other spellings and fields SEC may add later are kept as filed.
  const unusual = {
    ...holdings[2],
    value: "0300.00",
    raw: {
      ...holdings[2].raw,
      value: "0300.00",
      putCall: "PUT",
      votingAuthority: { ...(holdings[2].raw.votingAuthority as object), Note: "new field" },
    },
  };
  assert.deepEqual(unreportedFields(unusual), { value: "0300.00", putCall: "PUT", votingAuthority: { Note: "new field" } });
  for (const holding of [...holdings, unusual]) assert.deepEqual(sourceRow(holding, unreportedFields(holding)), holding.raw);
  // A source row that lacks a field its columns hold could not be rebuilt, so it is refused.
  assert.throws(() => unreportedFields({ ...holdings[0], raw: { cusip: holdings[0].cusip } }), /without losing source fields/);
});

test("rejects filings whose information table disagrees with the summary page by more than rounding", () => {
  // Each of the 4 rows is rounded to a whole unit, so the total may differ by up to 2.
  assert.equal(parseFullSubmission(sample.replace("<tableValueTotal>4550<", "<tableValueTotal>4552<")).valueTotal, "4552");
  assert.throws(
    () => parseFullSubmission(sample.replace("<tableValueTotal>4550<", "<tableValueTotal>4553<")),
    /values sum to 4550; the summary page reports 4553/,
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
  // Some filers pad the number.
  assert.equal(parseFullSubmission(amendmentText("RESTATEMENT", "01")).amendmentNumber, 1);
  assert.throws(() => parseFullSubmission(amendmentText("CORRECTION", 1)), /Unsupported amendment type: CORRECTION/);
  assert.throws(() => parseFullSubmission(amendmentText("RESTATEMENT", null)), /Invalid amendmentNo/);
});

test("a CIK linked from a quarter counts only from that quarter on", () => {
  // Pershing Square Capital Management reported the portfolio until Q1 2026; Pershing Square, Inc. from Q2 2026.
  const links = [{ cik: "0001336528", firstReportPeriod: null }, { cik: "0002026053", firstReportPeriod: "2026-06-30" }];
  assert.deepEqual(ciksForQuarter(links, "2025-12-31"), ["0001336528"]);
  assert.deepEqual(ciksForQuarter(links, "2026-06-30"), ["0001336528", "0002026053"]);
  assert.deepEqual(ciksForQuarter(links, undefined), ["0001336528", "0002026053"]);
});

test("value units follow the filing date, not the reporting quarter", () => {
  assert.equal(valueMultiplier("2022-11-14T21:01:07.000Z"), 1000);
  assert.equal(valueMultiplier("2023-01-03T15:00:00.000Z"), 1);
  assert.equal(toUnits("12.5"), BigInt(125_000));
  assert.equal(toUnits("577211815.0000"), toUnits("577211815"));
});

test("values that look like the other unit are refused until a person confirms thousands", () => {
  const holding = (value: string, quantity: string, extra: Partial<Holding> = {}) =>
    ({ value, quantity, quantityType: "SH", positionType: "long", ...extra }) as Holding;
  // Five stocks at about $205 a share, as dollars and as thousands of dollars.
  const counts = ["200000", "10000", "5000", "3000", "1000"];
  const dollars = [...counts.map((count) => holding(String(Number(count) * 205), count)), holding("100", "1", { positionType: "call" })];
  const thousands = counts.map((count) => holding(String(Number(count) * 0.205), count));
  assert.deepEqual(apparentValueUnit(dollars), { unit: "dollars", valuePerShare: 205 });
  assert.deepEqual(apparentValueUnit(thousands), { unit: "thousands", valuePerShare: 0.205 });
  assert.equal(apparentValueUnit([holding("100", "100")]).unit, "unclear");
  assert.equal(apparentValueUnit([]).unit, "unclear");
  // D. E. Shaw's one-row amendment: 199,999 warrants worth $22,020 in dollars. Too few rows to judge.
  assert.deepEqual(apparentValueUnit([holding("22020", "199999")]), { unit: "unclear", valuePerShare: 22020 / 199999 });

  const after2023 = "2026-08-13T16:00:00.000Z";
  const before2023 = "2022-11-14T21:01:07.000Z";
  assert.deepEqual(storedValueMultiplier(after2023, apparentValueUnit(dollars), false), { multiplier: 1 });
  assert.deepEqual(storedValueMultiplier(before2023, apparentValueUnit(thousands), false), { multiplier: 1000 });
  // Baupost and Duquesne kept reporting thousands after 2023: refused, or stored as thousands once confirmed.
  const refused = storedValueMultiplier(after2023, apparentValueUnit(thousands), false);
  assert.ok("problem" in refused && /thousands of dollars \(median value per share 0.205\).*--values-in-thousands/.test(refused.problem));
  assert.deepEqual(storedValueMultiplier(after2023, apparentValueUnit(thousands), true), { multiplier: 1000 });
  // Confirming thousands never changes a filing that is in dollars.
  assert.deepEqual(storedValueMultiplier(after2023, apparentValueUnit(dollars), true), { multiplier: 1 });
  assert.ok("problem" in storedValueMultiplier(before2023, apparentValueUnit(dollars), false));
  // When the unit is unclear, SEC's rule decides.
  assert.deepEqual(storedValueMultiplier(after2023, { unit: "unclear", valuePerShare: 1 }, false), { multiplier: 1 });
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

test("quarter ranges include both ends, in order, across year boundaries", () => {
  const fiveYears = quarterRange("2021Q3", "2026Q2");
  assert.equal(fiveYears.length, 20);
  assert.deepEqual(fiveYears.slice(0, 3), ["2021-09-30", "2021-12-31", "2022-03-31"]);
  assert.equal(fiveYears.at(-1), "2026-06-30");
  assert.deepEqual(quarterRange("2025-12-31", "2025Q4"), ["2025-12-31"]);
  assert.throws(() => quarterRange("2026Q2", "2021Q3"), /2026Q2 is after 2021Q3/);
  assert.throws(() => quarterRange("2021Q3", "2026-06-15"), /Invalid quarter/);
});

test("selects a quarter's original 13F-HR together with its amendments, oldest first", async () => {
  const { sec, requested } = fakeSecIndex();
  const latest = await findFiling(sec, "0000000001", "13F-HR");
  assert.equal(latest.original?.accessionNumber, "0000000000-26-000008");
  assert.deepEqual(latest.amendments, []);
  assert.deepEqual(await findFiling(sec, "0000000001", "13F-HR", "2026-03-31"), {
    original: {
      cik: "0000000001",
      accessionNumber: "0000000000-26-000005",
      form: "13F-HR",
      acceptedAt: "2026-05-15T20:06:05.000Z",
      reportDate: "2026-03-31",
    },
    amendments: [],
  });
  const amended = await findFiling(sec, "0000000001", "13F-HR", "2025-03-31");
  assert.equal(amended.original?.accessionNumber, "0000000000-25-000002");
  assert.deepEqual(amended.amendments.map((entry) => [entry.form, entry.accessionNumber]), [
    ["13F-HR/A", "0000000000-25-000004"],
    ["13F-HR/A", "0000000000-25-000006"],
  ]);
  // Each lookup read only the recent index; the older page was not needed.
  assert.equal(requested.length, 3);
});

test("historical quarters outside the recent index are found in older index pages", async () => {
  const { sec, requested } = fakeSecIndex();
  assert.equal((await findFiling(sec, "0000000001", "13F-HR", "2015-12-31")).original?.accessionNumber, "0000000000-16-000001");
  assert.equal(requested.at(-1), "https://data.sec.gov/submissions/CIK0000000001-submissions-001.json");
  assert.deepEqual(await findFiling(sec, "0000000001", "13F-HR", "2014-12-31"), { original: null, amendments: [] });
});

test("index pages that end before a quarter are not read", async () => {
  const { sec, requested } = fakeSecIndex();
  assert.deepEqual(await findFiling(sec, "0000000001", "13F-HR", "2024-12-31"), { original: null, amendments: [] });
  assert.deepEqual(requested, ["https://data.sec.gov/submissions/CIK0000000001.json"]);
});

test("a quarter is found under whichever of an investor's CIKs reported it", async () => {
  const { sec } = reorganizedSec();
  const ciks = ["0000000001", "0000000002"];
  const latest = await findQuarterFilings(sec, ciks);
  assert.deepEqual([latest.reportDate, latest.original.cik, latest.amendments.length], ["2026-06-30", "0000000001", 0]);
  // The former CIK filed the original; the current one amended it after the reorganization.
  const handover = await findQuarterFilings(sec, ciks, "2024-06-30");
  assert.deepEqual([handover.original.cik, handover.original.accessionNumber], ["0000000002", "0000000002-24-000002"]);
  assert.deepEqual(handover.amendments.map((entry) => [entry.cik, entry.accessionNumber]), [["0000000001", "0000000001-24-000002"]]);
  assert.equal((await findQuarterFilings(sec, ciks, "2023-09-30")).original.accessionNumber, "0000000002-23-000004");
  await assert.rejects(findQuarterFilings(sec, ciks, "2022-12-31"), /No 13F-HR filing for 2022-12-31 in SEC's index for CIK 0000000001, 0000000002/);
});

test("amendments filed before a refiled original belong to the earlier original", async () => {
  // State Street, Q4 2022: original in February, restatement at 20:20 on 15 May 2023, refiled as an original at 21:20.
  const responses: Record<string, unknown> = {
    "https://data.sec.gov/submissions/CIK0000093751.json": {
      filings: {
        recent: {
          form: ["13F-HR", "13F-HR/A", "13F-HR"],
          accessionNumber: ["0000093751-23-000567", "0000093751-23-000581", "0000093751-23-000476"],
          reportDate: ["2022-12-31", "2022-12-31", "2022-12-31"],
          acceptanceDateTime: ["2023-05-15T21:20:04.000Z", "2023-05-15T20:20:37.000Z", "2023-02-14T13:45:41.000Z"],
        },
        files: [],
      },
    },
  };
  const sec: SecClient = { async get(url) { return { url, text: JSON.stringify(responses[url]), sha256: "" }; } };
  const quarter = await findQuarterFilings(sec, ["0000093751"], "2022-12-31");
  assert.equal(quarter.original.accessionNumber, "0000093751-23-000567");
  assert.deepEqual(quarter.amendments, []);
  assert.deepEqual(quarter.supersededAmendments.map((entry) => entry.accessionNumber), ["0000093751-23-000581"]);
});

test("a quarter reported under two of an investor's CIKs is refused", async () => {
  const { sec } = reorganizedSec(true);
  await assert.rejects(
    findQuarterFilings(sec, ["0000000001", "0000000002"], "2024-06-30"),
    /More than one CIK filed a 13F-HR for 2024-06-30: 0000000001-24-000001 \(CIK 0000000001\), 0000000002-24-000002 \(CIK 0000000002\)/,
  );
});

test("CIK history lists the entity's names and every quarter it reported", async () => {
  const { sec } = reorganizedSec();
  assert.deepEqual(await cikHistory(sec, "0000000002"), {
    cik: "0000000002",
    name: "EXAMPLE FINANCE INC",
    formerNames: [{ name: "EXAMPLE HOLDINGS INC", until: "2024-09-26" }],
    reportPeriods: ["2023-09-30", "2024-03-31", "2024-06-30"],
  });
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
  assert.ok(problems.includes("Row 2: the stored columns and raw_row do not rebuild the SEC row"));
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
