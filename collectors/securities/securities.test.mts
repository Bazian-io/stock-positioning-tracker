import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import {
  dayAfter, isValidCusip, markTickerConflicts, normalizeTicker, openFigiJob, planAlias, planConversion, planEarlierStart, planPredecessor,
  planSecurity, sameCompany, secListing, shareClassOf, usListing,
  type Candidate, type Evidence,
} from "./identify.mts";

// Shapes of the two sources, with public listing data.
const secFile = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"],
    [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"],
    [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"],
    [1059556, "MOODYS CORP /DE/", "MCO", "NYSE"],
    [920760, "LENNAR CORP /NEW/", "LEN", "NYSE"],
    [1, "Example OTC Co", "XMPL", "OTC"],
  ],
};
// OpenFIGI's result for one CUSIP.
const figi = (ticker: string, name: string, securityType = "Common Stock") => ({
  data: [
    { ticker, exchCode: "US", name, securityType, marketSector: "Equity", compositeFIGI: "BBG000B9XRY4" },
    { ticker, exchCode: "UW", name, securityType, marketSector: "Equity", compositeFIGI: "BBG000B9XRY4" },
  ],
});
const filings = {
  firstPeriod: "2021-09-30",
  firstSourceUrl: "https://www.sec.gov/Archives/edgar/data/1067983/000095012321015518/0000950123-21-015518.txt",
  latestPeriod: "2026-06-30",
  reportedNames: ["APPLE INC COM"],
};
const evidence = (cusip: string, ticker: string, figiTicker = ticker, name = "APPLE INC", securityType?: string): Evidence => ({
  cusip, ticker, figi: usListing(figi(figiTicker, name, securityType)), sec: secListing(secFile, ticker), filings,
});

test("CUSIP check digits and ticker spellings are validated", () => {
  for (const cusip of ["037833100", "02079K305", "02079K107", "084670702", "594918104"]) assert.ok(isValidCusip(cusip), cusip);
  for (const cusip of ["037833101", "03783310", "037833100X"]) assert.ok(!isValidCusip(cusip), cusip);
  assert.deepEqual(["aapl", "brk.b", "BRK/B", " brk-b "].map(normalizeTicker), ["AAPL", "BRK-B", "BRK-B", "BRK-B"]);
  // Issuers incorporated abroad have CINS numbers, which OpenFIGI looks up separately.
  assert.deepEqual(["037833100", "H1467J104"].map(openFigiJob), [
    { idType: "ID_CUSIP", idValue: "037833100" },
    { idType: "ID_CINS", idValue: "H1467J104" },
  ]);
});

test("a CUSIP and ticker are added only when OpenFIGI, SEC and our filings agree", () => {
  const { plan, problems } = planSecurity(evidence("037833100", "AAPL"), "2026-10-29", null);
  assert.deepEqual(problems, []);
  assert.deepEqual(plan, {
    security: { issuer_name: "Apple Inc.", share_class: null, security_type: "common_stock" },
    identifiers: [
      { identifier_type: "cusip", identifier_value: "037833100", namespace: "", valid_from: "2021-09-30", source_reference: filings.firstSourceUrl },
      { identifier_type: "ticker", identifier_value: "AAPL", namespace: "XNAS", valid_from: "2026-10-29", source_reference: "https://www.sec.gov/files/company_tickers_exchange.json" },
    ],
  });
  assert.deepEqual(planSecurity(evidence("037833100", "AAPL", "MSFT"), "2026-10-29", null).problems, ["OpenFIGI maps CUSIP 037833100 to MSFT, not AAPL"]);
  assert.deepEqual(planSecurity(evidence("037833101", "AAPL"), "2026-10-29", null).problems, ["037833101 is not a valid CUSIP (check digit)"]);
  assert.deepEqual(planSecurity(evidence("037833100", "XMPL", "XMPL", "EXAMPLE OTC CO"), "2026-10-29", null).problems, ["XMPL trades on OTC; only Nasdaq and NYSE are supported"]);
  assert.deepEqual(planSecurity({ ...evidence("037833100", "AAPL"), filings: null }, "2026-10-29", null).problems, ["No tracked filing reports CUSIP 037833100"]);
  // Only stocks: an ETF (ETP in OpenFIGI) is not added.
  assert.deepEqual(planSecurity(evidence("037833100", "AAPL", "AAPL", "APPLE INC", "ETP"), "2026-10-29", null).problems, ["OpenFIGI lists 037833100 as ETP, not a stock"]);
  // SEC's state tag is left out of the name.
  assert.equal(planSecurity(evidence("615369105", "MCO", "MCO", "MOODY'S CORP"), "2026-10-29", null).plan?.security.issuer_name, "MOODYS CORP");
  assert.equal(planSecurity(evidence("526057104", "LEN", "LEN", "LENNAR CORP-A"), "2026-10-29", null).plan?.security.issuer_name, "LENNAR CORP");
});

test("company names and share classes are read from both sources' spellings", () => {
  assert.ok(sameCompany("MOODY'S CORP", "MOODYS CORP /DE/"));
  assert.ok(sameCompany("D R HORTON INC", "HORTON D R INC /DE/"));
  assert.ok(sameCompany("COCA-COLA CO/THE", "COCA COLA CO"));
  assert.ok(!sameCompany("ACTIVISION BLIZZARD INC", "Apple Inc."));
  assert.ok(!sameCompany("BANK OF AMERICA CORP", "CITIGROUP INC"));
  assert.deepEqual(
    ["ALPHABET INC-CL A", "VISA INC-CLASS A SHARES", "LENNAR CORP - B SHS", "LIBERTY MEDIA CORP-C", "APPLE INC", "T-MOBILE US INC"].map(shareClassOf),
    ["Class A", "Class A", "Class B", "Class C", null, null],
  );
});

test("a ticker that is already recorded, or that two CUSIPs map to, is left for a person to decide", () => {
  const candidate = (cusip: string, ticker: string, name: string): Candidate => {
    const { plan, problems } = planSecurity(evidence(cusip, ticker, ticker, name), "2026-10-29", null);
    return { cusip, ticker, plan, problems };
  };
  const candidates = [
    candidate("037833100", "AAPL", "APPLE INC"),
    candidate("02079K305", "GOOGL", "ALPHABET INC-CL A"),
    candidate("02079K107", "GOOGL", "ALPHABET INC-CL C"),
    candidate("084670702", "BRK-B", "BERKSHIRE HATHAWAY INC-CL B"),
  ];
  for (const c of candidates) assert.ok(c.plan, c.cusip);
  markTickerConflicts(candidates, new Set(["BRK-B"]));
  assert.deepEqual(candidates.map((c) => [c.cusip, c.plan !== null, c.problems]), [
    ["037833100", true, []],
    ["02079K305", false, ["CUSIPs 02079K305, 02079K107 all map to GOOGL"]],
    ["02079K107", false, ["CUSIPs 02079K107, 02079K305 all map to GOOGL"]],
    ["084670702", false, ["BRK-B is already recorded for another CUSIP"]],
  ]);
});

test("share classes become separate securities that the database keeps apart", async () => {
  const classA = planSecurity(evidence("02079K305", "GOOGL", "GOOGL", "ALPHABET INC-CL A"), "2026-10-29", "Class A").plan;
  const classC = planSecurity(evidence("02079K107", "GOOG", "GOOG", "ALPHABET INC-CL C"), "2026-10-29", "Class C").plan;
  assert.ok(classA && classC);
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;`);
    const migrations = new URL("../../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    const add = async (plan: typeof classA) => {
      const { id } = (await db.query<{ id: string }>(
        "insert into public.securities select * from jsonb_populate_record(null::public.securities, $1::jsonb) returning id",
        [JSON.stringify({ ...plan.security, id: crypto.randomUUID(), track_short_interest: false, created_at: new Date().toISOString() })],
      )).rows[0];
      for (const row of plan.identifiers) {
        await db.query(`insert into public.security_identifiers (security_id, identifier_type, identifier_value, namespace, valid_from, source_reference)
          values ($1, $2, $3, $4, $5, $6)`, [id, row.identifier_type, row.identifier_value, row.namespace, row.valid_from, row.source_reference]);
      }
    };
    await add(classA);
    await add(classC);
    const classes = (await db.query<{ ticker: string; cusip: string; share_class: string }>(`
      select t.identifier_value as ticker, c.identifier_value as cusip, s.share_class from public.securities s
      join public.security_identifiers t on t.security_id = s.id and t.identifier_type = 'ticker'
      join public.security_identifiers c on c.security_id = s.id and c.identifier_type = 'cusip' order by ticker`)).rows;
    assert.deepEqual(classes, [
      { ticker: "GOOG", cusip: "02079K107", share_class: "Class C" },
      { ticker: "GOOGL", cusip: "02079K305", share_class: "Class A" },
    ]);
    // One CUSIP cannot identify two securities at the same time.
    await assert.rejects(add(classA), /identifier_periods_do_not_overlap/);
  } finally {
    await db.close();
  }
});

test("a mistyped CUSIP is recorded for a stock only for the quarters filers used it, and never a real security", () => {
  // Berkshire reported Nu Holdings (G6683N103) as G6693N103 from Q4 2021 to Q3 2022.
  const typo = {
    firstPeriod: "2021-12-31",
    firstSourceUrl: "https://www.sec.gov/Archives/edgar/data/1067983/000095012322002973/0000950123-22-002973.txt",
    latestPeriod: "2022-09-30",
    reportedNames: ["NU HLDGS LTD ORD SHS CL A"],
  };
  const notFound = { warning: "No identifier found." };
  assert.deepEqual(planAlias("G6693N103", "Nu Holdings Ltd.", notFound, typo), {
    problems: [],
    identifier: {
      identifier_type: "cusip", identifier_value: "G6693N103", namespace: "",
      valid_from: "2021-12-31", valid_to: "2022-10-01", source_reference: typo.firstSourceUrl,
    },
  });
  assert.equal(dayAfter("2024-12-31"), "2025-01-01");
  assert.deepEqual(planAlias("00507V109", "Nu Holdings Ltd.", { data: [{ name: "ACTIVISION BLIZZARD INC" }] }, typo).problems, [
    "OpenFIGI knows 00507V109 as ACTIVISION BLIZZARD INC: it is a real security, not a typo",
  ]);
  assert.deepEqual(planAlias("G6693N103", "Apple Inc.", notFound, typo).problems, [
    'Filers reported G6693N103 as "NU HLDGS LTD ORD SHS CL A", which does not match Apple Inc.',
  ]);
  assert.deepEqual(planAlias("G6693N103", "Nu Holdings Ltd.", notFound, null).problems, ["No tracked filing reports CUSIP G6693N103"]);
});

test("a CUSIP's start date moves back only to an earlier filing that names the same company", () => {
  const reported = { firstPeriod: "2024-06-30", firstSourceUrl: "https://www.sec.gov/x.txt", latestPeriod: "2026-06-30", reportedNames: ["NVIDIA CORPORATION COM"] };
  assert.deepEqual(planEarlierStart({ validFrom: "2026-06-30", recordedTimes: 1 }, "NVIDIA CORP", reported), {
    validFrom: "2024-06-30", sourceReference: "https://www.sec.gov/x.txt",
  });
  assert.equal(planEarlierStart({ validFrom: "2024-06-30", recordedTimes: 1 }, "NVIDIA CORP", reported), null);
  assert.deepEqual(planEarlierStart({ validFrom: "2026-06-30", recordedTimes: 1 }, "Apple Inc.", reported), {
    problem: 'filers reported it as "NVIDIA CORPORATION COM", which does not match Apple Inc.',
  });
  assert.deepEqual(planEarlierStart({ validFrom: "2026-06-30", recordedTimes: 2 }, "NVIDIA CORP", reported), {
    problem: "the CUSIP is recorded for more than one period",
  });
});

test("an earlier CUSIP is linked only when it was converted one-for-one, with an official source", () => {
  // Liberty Media's Liberty Live Series A tracking stock, redeemed one-for-one for Liberty Live Holdings
  // shares on 15 December 2025; Berkshire held 4,986,588 shares before and after.
  const source = "https://www.libertymedia.com/news/detail/575/liberty-media-corporation-completes-split-off-of-liberty";
  const input = {
    cusip: "531229748",
    stockName: "Liberty Live Holdings, Inc.",
    stockCusips: [{ cusip: "530909100", validFrom: "2025-12-31", validTo: null }],
    listed: null,
    known: { data: [{ name: "LIBERTY MEDIA CORP-LIBERTY-A" }] },
    filings: {
      firstPeriod: "2023-09-30",
      firstSourceUrl: "https://www.sec.gov/Archives/edgar/data/1067983/x.txt",
      latestPeriod: "2025-09-30",
      reportedNames: ["LIBERTY MEDIA CORP DEL COM LBTY LIV S A"],
    },
    until: "2025-12-15",
    source,
    continuity: [{ investor: "berkshire-hathaway", before: 4_986_588, after: 4_986_588 }],
  };
  assert.deepEqual(planPredecessor(input), {
    problems: [],
    identifier: { identifier_type: "cusip", identifier_value: "531229748", namespace: "", valid_from: "2023-09-30", valid_to: "2025-12-15", source_reference: source },
  });
  // Sirius XM's 2024 conversion was not one-for-one (0.8375 and 0.1 new shares), so it is not linked.
  assert.match(planPredecessor({ ...input, continuity: [{ investor: "berkshire-hathaway", before: 132_878_213, after: 105_155_029 }] }).problems[0],
    /No investor's share count carried over unchanged/);
  assert.deepEqual(planPredecessor({ ...input, listed: { ticker: "LLYVA", name: "", securityType: "", marketSector: "", compositeFigi: "" } }).problems, [
    "531229748 is still listed (LLYVA); only a CUSIP that is no longer listed can be a predecessor",
  ]);
  assert.deepEqual(planPredecessor({ ...input, known: { warning: "No identifier found." } }).problems, ["OpenFIGI does not know 531229748 as a security"]);
  assert.deepEqual(planPredecessor({ ...input, source: "liberty release" }).problems, [
    "The source must be the https address of an official record, such as the company's release or SEC filing",
  ]);
  assert.deepEqual(planPredecessor({ ...input, until: "2025-09-30" }).problems, ["Filings report 531229748 for 2025-09-30, on or after the conversion date 2025-09-30"]);
  assert.deepEqual(planPredecessor({ ...input, stockCusips: [{ cusip: "530909100", validFrom: "2025-06-30", validTo: null }] }).problems, [
    "The stock's CUSIP 530909100 already applies from 2025-06-30, before 2025-12-15",
  ]);
  assert.match(planPredecessor({ ...input, stockName: "Apple Inc." }).problems[0], /does not match Apple Inc\./);
  assert.match(planPredecessor({ ...input, continuity: [] }).problems[0], /cannot be checked/);
});

test("a conversion ratio is recorded only for a real security our filings held, with an official source", () => {
  // Sirius XM's 9 September 2024 merger: 0.1 new SIRI share for each Sirius XM share.
  const source = "https://www.libertymedia.com/news/detail/542/liberty-media-and-sirius-xm-announce-final-exchange-ratio";
  const input = {
    fromCusip: "82968B103",
    ratio: "0.1",
    effectiveDate: "2024-09-09",
    description: "Sirius XM's merger with Liberty Sirius XM Holdings",
    source,
    known: { data: [{ name: "SIRIUS XM HOLDINGS INC" }] },
    heldBefore: [{ investor: "berkshire-hathaway", shares: 132_878_213 }],
    stockIdentified: true,
    fromIsStock: false,
  };
  assert.deepEqual(planConversion(input), {
    problems: [],
    conversion: { from_cusip: "82968B103", shares_per_share: "0.1", effective_date: "2024-09-09", description: input.description, source_reference: source },
  });
  for (const ratio of ["0", "-1", "1/10", "abc"]) {
    assert.deepEqual(planConversion({ ...input, ratio }).problems, [`${ratio} is not a positive number of shares per share`]);
  }
  assert.deepEqual(planConversion({ ...input, known: { warning: "No identifier found." } }).problems, ["OpenFIGI does not know 82968B103 as a security"]);
  assert.match(planConversion({ ...input, heldBefore: [] }).problems[0], /no holding would change/);
  assert.match(planConversion({ ...input, stockIdentified: false }).problems[0], /would not be matched/);
  assert.deepEqual(planConversion({ ...input, fromIsStock: true }).problems, ["82968B103 already identifies the stock at that time"]);
  assert.match(planConversion({ ...input, source: "press release" }).problems[0], /official record/);
});
