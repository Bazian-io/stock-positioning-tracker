import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import {
  dayAfter, isValidCusip, listingDirectory, markTickerConflicts, NASDAQ_LISTED_URL, normalizeTicker, openFigiJob, OTHER_LISTED_URL, planAlias,
  planConversion, planEarlierStart, planPredecessor, planSecurity, sameCompany, secListing, shareClassOf, usListing,
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
    [49938, "IMPERIAL OIL LTD", "IMO", "NYSE"],
    [1374310, "Cboe Global Markets, Inc.", "CBOE", "CBOE"],
    [884394, "SPDR S&P 500 ETF TRUST", "SPY", "NYSE"],
    [2, "Example Texas Co", "TXCO", "TXSE"],
    [1, "Example OTC Co", "XMPL", "OTC"],
  ],
};
// Nasdaq's directory files, in their format: pipe-separated, Windows line endings, a closing timestamp.
const directory = listingDirectory(
  ["Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
    "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
    "GOOGL|Alphabet Inc. - Class A Common Stock|Q|N|N|100|N|N",
    "GOOG|Alphabet Inc. - Class C Capital Stock|Q|N|N|100|N|N",
    "ZXZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N",
    "File Creation Time: 1029202610:01|||||||"].join("\r\n"),
  ["ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
    "BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|100|N|BRK.B",
    "MCO|Moody's Corporation Common Stock|N|MCO|N|100|N|MCO",
    "LEN|Lennar Corporation Class A Common Stock|N|LEN|N|100|N|LEN",
    "IMO|Imperial Oil Limited Common Stock|A|IMO|N|100|N|IMO",
    "CBOE|Cboe Global Markets, Inc. Common Stock|Z|CBOE|N|100|N|CBOE",
    "SPY|State Street SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY",
    "TXCO|Example Texas Co Common Stock|TXSE|TXCO|N|100|N|TXCO",
    "File Creation Time: 1029202610:01||||||"].join("\r\n"),
);
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
  cusip, ticker, figi: usListing(figi(figiTicker, name, securityType)), sec: secListing(secFile, ticker), listing: directory.get(ticker) ?? null, filings,
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

test("Nasdaq's directory gives each listing's exchange; test issues are left out", () => {
  assert.deepEqual(directory.get("BRK-B"), { ticker: "BRK-B", name: "Berkshire Hathaway Inc. New Common Stock", exchange: "N", etf: false });
  assert.deepEqual([directory.get("AAPL")?.exchange, directory.get("IMO")?.exchange, directory.get("SPY")?.etf], ["Q", "A", true]);
  assert.equal(directory.get("ZXZZT"), undefined);
  assert.equal(directory.size, 10);
});

test("a CUSIP and ticker are added only when OpenFIGI, SEC, Nasdaq's directory and our filings agree", () => {
  const { plan, problems } = planSecurity(evidence("037833100", "AAPL"), "2026-10-29", null);
  assert.deepEqual(problems, []);
  assert.deepEqual(plan, {
    security: { issuer_name: "Apple Inc.", share_class: null, security_type: "common_stock" },
    identifiers: [
      { identifier_type: "cusip", identifier_value: "037833100", namespace: "", valid_from: "2021-09-30", source_reference: filings.firstSourceUrl },
      { identifier_type: "ticker", identifier_value: "AAPL", namespace: "XNAS", valid_from: "2026-10-29", source_reference: NASDAQ_LISTED_URL },
    ],
  });
  assert.deepEqual(planSecurity(evidence("037833100", "AAPL", "MSFT"), "2026-10-29", null).problems, ["OpenFIGI maps CUSIP 037833100 to MSFT, not AAPL"]);
  assert.deepEqual(planSecurity(evidence("037833101", "AAPL"), "2026-10-29", null).problems, ["037833101 is not a valid CUSIP (check digit)"]);
  assert.deepEqual(planSecurity(evidence("037833100", "XMPL", "XMPL", "EXAMPLE OTC CO"), "2026-10-29", null).problems, [
    "XMPL is not in Nasdaq's directory of US-listed securities",
  ]);
  // The listing exchange comes from Nasdaq's directory: SEC labels NYSE American and NYSE Arca "NYSE".
  const ticker = (cusip: string, symbol: string, name: string) => planSecurity(evidence(cusip, symbol, symbol, name), "2026-10-29", null).plan?.identifiers[1];
  assert.deepEqual(ticker("453038408", "IMO", "IMPERIAL OIL LTD"), {
    identifier_type: "ticker", identifier_value: "IMO", namespace: "XASE", valid_from: "2026-10-29", source_reference: OTHER_LISTED_URL,
  });
  assert.equal(ticker("12503M108", "CBOE", "CBOE GLOBAL MARKETS INC")?.namespace, "BATS");
  assert.deepEqual(planSecurity(evidence("78462F103", "SPY", "SPY", "SPDR S&P 500 ETF TRUST"), "2026-10-29", null).problems, [
    "Nasdaq's directory lists SPY as an ETF, not a stock",
  ]);
  assert.deepEqual(planSecurity(evidence("000000000", "TXCO", "TXCO", "EXAMPLE TEXAS CO"), "2026-10-29", null).problems, [
    "TXCO is listed on the Texas Stock Exchange, which is not supported yet",
  ]);
  // SEC and Nasdaq's directory must agree on the exchange.
  assert.deepEqual(planSecurity({ ...evidence("037833100", "AAPL"), listing: { ticker: "AAPL", name: "Apple", exchange: "N", etf: false } }, "2026-10-29", null).problems, [
    "SEC lists AAPL on Nasdaq, but Nasdaq's directory lists it on NYSE",
  ]);
  assert.deepEqual(planSecurity({ ...evidence("037833100", "AAPL"), filings: null }, "2026-10-29", null).problems, ["No tracked filing reports CUSIP 037833100"]);
  // Only stocks: an ETF (ETP in OpenFIGI) is not added.
  assert.deepEqual(planSecurity(evidence("037833100", "AAPL", "AAPL", "APPLE INC", "ETP"), "2026-10-29", null).problems, ["OpenFIGI lists 037833100 as ETP, not a stock"]);
  // SEC's state tag is left out of the name.
  assert.equal(planSecurity(evidence("615369105", "MCO", "MCO", "MOODY'S CORP"), "2026-10-29", null).plan?.security.issuer_name, "MOODYS CORP");
  assert.equal(planSecurity(evidence("526057104", "LEN", "LEN", "LENNAR CORP-A"), "2026-10-29", null).plan?.security.issuer_name, "LENNAR CORP");
});

test("company names and share classes are read from both sources' spellings", () => {
  assert.ok(sameCompany("MOODY'S CORP", "MOODYS CORP /DE/"));
  // Spacing, punctuation and abbreviations (all refused by the earlier matcher, from real names).
  assert.ok(sameCompany("P G & E CORP", "PG&E Corp"));
  assert.ok(sameCompany("PULTE GROUP INC", "PULTEGROUP INC"));
  assert.ok(sameCompany("M & T BK CORP", "M&T BANK CORP"));
  assert.ok(sameCompany("SIRIUSXM HOLDINGS INC", "SIRIUS XM HOLDINGS INC."));
  assert.ok(sameCompany("BANK AMER CORP", "BANK OF AMERICA CORP /DE/"));
  assert.ok(sameCompany("AMERICAN ELEC PWR CO INC", "AMERICAN ELECTRIC POWER CO INC"));
  assert.ok(sameCompany("NORTHERN TR CORP", "NORTHERN TRUST CORP"));
  assert.ok(sameCompany("FIRST CTZNS BANCSHARES INC D", "FIRST CITIZENS BANCSHARES INC"));
  // Word order and names cut short.
  assert.ok(sameCompany("DR HORTON INC", "HORTON D R INC /DE/"));
  assert.ok(sameCompany("T ROWE PRICE GROUP INC", "PRICE T ROWE GROUP INC"));
  assert.ok(sameCompany("DISNEY WALT CO", "Walt Disney Co"));
  assert.ok(sameCompany("BANK OF NY MELLON CORP", "Bank of New York Mellon Corp"));
  assert.ok(sameCompany("AIR PRODUCTS AND CHEMICALS I", "Air Products & Chemicals, Inc."));
  assert.ok(sameCompany("PUBLIC SERVICE ENTERPRISE GP", "PUBLIC SERVICE ENTERPRISE GROUP INC"));
  // Filers append the title of class.
  assert.ok(sameCompany("UNITED AIRLS HLDGS INC OPTIONS", "United Airlines Holdings, Inc."));
  assert.ok(sameCompany("PINDUODUO INC SPONSORED ADS", "PINDUODUO INC"));
  // A shared common word alone is not enough; a brand unrelated to the legal name is left for a person.
  assert.ok(!sameCompany("FIRST SOLAR INC", "FIRST REPUBLIC BANK"));
  assert.ok(!sameCompany("AMERICAN EXPRESS CO", "AMERICAN AIRLINES GROUP INC"));
  assert.ok(!sameCompany("AMERICAN ELECTRIC POWER CO INC", "GENERAL ELECTRIC CO"));
  assert.ok(!sameCompany("AT&T INC.", "AGILENT TECHNOLOGIES, INC."));
  assert.ok(!sameCompany("WABTEC CORP", "WESTINGHOUSE AIR BRAKE TECHNOLOGIES CORP"));
  assert.ok(!sameCompany("GE AEROSPACE", "GENERAL ELECTRIC CO"));
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
  // A renamed company: filers used the old name until the rename; a person confirms it.
  const facebook = { ...reported, reportedNames: ["FACEBOOK INC CL A", "META PLATFORMS INC CL A"] };
  assert.ok(planEarlierStart({ validFrom: "2026-06-30", recordedTimes: 1 }, "Meta Platforms, Inc.", facebook) !== null
    && "problem" in planEarlierStart({ validFrom: "2026-06-30", recordedTimes: 1 }, "Meta Platforms, Inc.", facebook)!);
  assert.deepEqual(planEarlierStart({ validFrom: "2026-06-30", recordedTimes: 1 }, "Meta Platforms, Inc.", facebook, true), {
    validFrom: "2024-06-30", sourceReference: "https://www.sec.gov/x.txt",
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
    continuity: [{ investor: "berkshire-hathaway", before: 4_986_588, after: 4_986_588, priceRatio: 0.86 }],
  };
  assert.deepEqual(planPredecessor(input), {
    problems: [],
    identifier: { identifier_type: "cusip", identifier_value: "531229748", namespace: "", valid_from: "2023-09-30", valid_to: "2025-12-15", source_reference: source },
  });
  // Sirius XM's 2024 conversion was not one-for-one (0.8375 and 0.1 new shares), so it is not linked.
  // Sirius XM's old shares became 0.1 new shares, and value per share rose about eightfold: never linked.
  const sirius = [{ investor: "berkshire-hathaway", before: 132_878_213, after: 105_155_029, priceRatio: 8.3 }];
  assert.match(planPredecessor({ ...input, continuity: sirius }).problems[0], /No investor's share count carried over unchanged/);
  assert.match(planPredecessor({ ...input, continuity: sirius, statedOneForOne: true }).problems[0], /outside what a one-for-one conversion allows/);
  // A one-for-one conversion (ExxonMobil Holdings, 1 July 2026) held by an investor that also traded:
  // linked only when the official record states one-for-one and value per share stayed in range.
  const traded = [{ investor: "blackrock", before: 335_000_000, after: 337_400_000, priceRatio: 1.06 }];
  assert.match(planPredecessor({ ...input, continuity: traded }).problems[0], /--stated-one-for-one/);
  assert.deepEqual(planPredecessor({ ...input, continuity: traded, statedOneForOne: true }).problems, []);
  // A 10-for-1 split that also replaced the CUSIP (Lam Research, 3 October 2024): compared after the split.
  const split = [
    { investor: "tiger-global-management", before: 100_000, after: 1_000_000, priceRatio: 0.098 },
    { investor: "state-street", before: 5_000_000, after: 50_400_000, priceRatio: 0.104 },
  ];
  assert.match(planPredecessor({ ...input, continuity: split }).problems[0], /No investor's share count carried over unchanged/);
  assert.deepEqual(planPredecessor({ ...input, continuity: split, splitRatio: 10 }).problems, []);
  assert.deepEqual(planPredecessor({ ...input, continuity: split.slice(1), splitRatio: 10 }).problems, []);
  assert.match(planPredecessor({ ...input, continuity: split.slice(1), splitRatio: 4 }).problems[0],
    /×0\.42 \(state-street\) across the conversion after adjusting for the split, outside what a split of 4 shares per share allows/);
  assert.equal(planPredecessor({ ...input, continuity: split, splitRatio: 1 }).problems[0], "1 is not a split ratio (a positive number other than 1)");
  // An investor that sold all its shares has no value per share to compare; the others decide.
  const soldOut = { investor: "d-e-shaw", before: 2_000, after: 0, priceRatio: null };
  assert.deepEqual(planPredecessor({ ...input, continuity: [...split, soldOut], splitRatio: 10 }).problems, []);
  assert.match(planPredecessor({ ...input, continuity: [soldOut], splitRatio: 10 }).problems[0], /No investor held the stock after the conversion/);
  // A 1-for-3 reverse split (DuPont, 24 June 2026): 1,000 shares became 333, the fraction paid in cash.
  const reverse = [{ investor: "state-street", before: 1_000, after: 333, priceRatio: 0.5 }];
  assert.deepEqual(planPredecessor({ ...input, continuity: reverse, splitRatio: 0.3333333333 }).problems, []);
  assert.match(planPredecessor({ ...input, continuity: [{ ...reverse[0], after: 330 }], splitRatio: 0.3333333333 }).problems[0], /outside what a split/);
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
    fromIsStock: { before: false, during: false },
    split: false,
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
  for (const fromIsStock of [{ before: true, during: true }, { before: false, during: true }, { before: true, during: false }]) {
    assert.deepEqual(planConversion({ ...input, fromIsStock }).problems, ["82968B103 already identifies the stock at that time; record a stock split with --split"]);
  }
  assert.match(planConversion({ ...input, source: "press release" }).problems[0], /official record/);
});

test("a stock split is recorded only for the stock's own CUSIP, when asked for", () => {
  // NVIDIA's 10-for-1 split: trading on a split-adjusted basis began 10 June 2024.
  const source = "https://www.sec.gov/Archives/edgar/data/1045810/000104581024000144/nvda-20240607.htm";
  const input = {
    fromCusip: "67066G104",
    ratio: "10",
    effectiveDate: "2024-06-10",
    description: "NVIDIA's 10-for-1 stock split",
    source,
    known: { data: [{ name: "NVIDIA CORP" }] },
    heldBefore: [{ investor: "appaloosa", shares: 50_000 }],
    stockIdentified: true,
    fromIsStock: { before: true, during: true },
    split: true,
  };
  assert.deepEqual(planConversion(input), {
    problems: [],
    conversion: { from_cusip: "67066G104", shares_per_share: "10", effective_date: "2024-06-10", description: input.description, source_reference: source },
  });
  // A split that also changed the CUSIP converts the earlier CUSIP, recorded as a predecessor until the split.
  assert.deepEqual(planConversion({ ...input, fromIsStock: { before: true, during: false } }).problems, []);
  // A reverse split: 1 new share for each 10.
  assert.deepEqual(planConversion({ ...input, ratio: "0.1" }).problems, []);
  assert.deepEqual(planConversion({ ...input, fromIsStock: { before: false, during: false } }).problems,
    ["67066G104 is not the stock's CUSIP in the quarter before 2024-06-10, so this is not a split of the stock"]);
  assert.deepEqual(planConversion({ ...input, ratio: "1" }).problems, ["A split's ratio cannot be 1"]);
});
