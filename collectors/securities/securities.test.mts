import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { isValidCusip, normalizeTicker, planSecurity, secListing, usListing, type Evidence } from "./identify.mts";

// Shapes of the two sources, with public listing data.
const secFile = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"],
    [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"],
    [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"],
    [1, "Example OTC Co", "XMPL", "OTC"],
  ],
};
const figi = (ticker: string, name: string) => [{
  data: [
    { ticker, exchCode: "US", name, securityType: "Common Stock", marketSector: "Equity", compositeFIGI: "BBG000B9XRY4" },
    { ticker, exchCode: "UW", name, securityType: "Common Stock", marketSector: "Equity", compositeFIGI: "BBG000B9XRY4" },
  ],
}];
const filings = {
  firstPeriod: "2021-09-30",
  firstSourceUrl: "https://www.sec.gov/Archives/edgar/data/1067983/000095012321015518/0000950123-21-015518.txt",
  latestPeriod: "2026-06-30",
  reportedNames: ["APPLE INC COM"],
};
const evidence = (cusip: string, ticker: string, figiTicker = ticker, name = "APPLE INC"): Evidence => ({
  cusip, ticker, figi: usListing(figi(figiTicker, name)), sec: secListing(secFile, ticker), filings,
});

test("CUSIP check digits and ticker spellings are validated", () => {
  for (const cusip of ["037833100", "02079K305", "02079K107", "084670702", "594918104"]) assert.ok(isValidCusip(cusip), cusip);
  for (const cusip of ["037833101", "03783310", "037833100X"]) assert.ok(!isValidCusip(cusip), cusip);
  assert.deepEqual(["aapl", "brk.b", "BRK/B", " brk-b "].map(normalizeTicker), ["AAPL", "BRK-B", "BRK-B", "BRK-B"]);
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
  assert.deepEqual(planSecurity(evidence("037833100", "XMPL", "XMPL"), "2026-10-29", null).problems, ["XMPL trades on OTC; only Nasdaq and NYSE are supported"]);
  assert.deepEqual(planSecurity({ ...evidence("037833100", "AAPL"), filings: null }, "2026-10-29", null).problems, ["No tracked filing reports CUSIP 037833100"]);
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
