import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const migrationsDir = new URL("../migrations/", import.meta.url);
const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

let db;
let accession = 0;
let cik = 0;

// A disposable database with Supabase's roles and the first `count` migrations applied.
async function createDatabase(count = migrations.length) {
  const database = new PGlite({ extensions: { btree_gist } });
  // Supabase provides these roles. Reproduce them only inside this disposable database.
  await database.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  for (const name of migrations.slice(0, count)) await database.exec(await readFile(new URL(name, migrationsDir), "utf8"));
  return database;
}

before(async () => {
  db = await createDatabase();
});

beforeEach(async () => {
  await db.exec("begin; set local role service_role;");
});
afterEach(async () => {
  await db.exec("rollback;");
});
after(async () => {
  await db?.close();
});

async function insert(table, values) {
  const keys = Object.keys(values);
  assert.ok([table, ...keys].every((name) => /^[a-z_]+$/.test(name)));
  const result = await db.query(
    `insert into public.${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(values),
  );
  return result.rows[0];
}

async function rejected(sql, params, message) {
  await db.exec("savepoint expected_error;");
  try {
    await assert.rejects(db.query(sql, params), message);
  } finally {
    await db.exec("rollback to savepoint expected_error; release savepoint expected_error;");
  }
}

async function run(collector = "sec13f", provider = "sec") {
  return insert("collection_runs", { collector, provider });
}

async function investor() {
  return insert("investors", { name: "Example manager", cik: String(++cik).padStart(10, "0") });
}

async function security() {
  return insert("securities", { issuer_name: "Example issuer", security_type: "stock" });
}

async function filing(overrides = {}, rows = [{ quantity: 10, reported_value: 100 }], complete = true) {
  const parent = await insert("filings", {
    investor_id: overrides.investor_id ?? (await investor()).id,
    collection_run_id: overrides.collection_run_id ?? (await run()).id,
    accession_number: `0000000001-26-${String(++accession).padStart(6, "0")}`,
    report_period: "2026-06-30",
    filed_at: "2026-08-01T12:00:00Z",
    form_type: "13F-HR",
    report_type: "holdings",
    reported_entry_count: rows.length,
    reported_total_value: rows.reduce((sum, row) => sum + row.reported_value, 0),
    value_multiplier: 1,
    source_url: "https://www.sec.gov/Archives/example.xml",
    ...overrides,
  });
  for (const [index, row] of rows.entries()) {
    await insert("holdings", {
      filing_id: parent.id,
      source_row: index + 1,
      reported_issuer: "Example issuer",
      reported_cusip: "123456789",
      quantity_type: "SH",
      ...row,
    });
  }
  if (complete) {
    await db.query("update public.filings set import_status = 'complete' where id = $1", [parent.id]);
  }
  return parent;
}

async function observation(overrides = {}) {
  return insert("short_interest", {
    security_id: overrides.security_id ?? (await security()).id,
    collection_run_id: overrides.collection_run_id ?? (await run("short_interest", "example_provider")).id,
    provider: "example_provider",
    settlement_date: "2026-07-15",
    shares_short: 100,
    source_reference: "https://example.com/short-interest/source",
    ...overrides,
  });
}

test("migrations create the research tables, all protected by RLS", async () => {
  const result = await db.query(`
    select c.relname, c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by c.relname
  `);
  assert.deepEqual(result.rows.map((row) => row.relname), [
    "collection_runs", "filings", "holdings", "investor_ciks", "investors", "securities", "security_conversions",
    "security_identifiers", "short_interest",
  ]);
  assert.ok(result.rows.every((row) => row.relrowsecurity));
});

test("completion requires matching source counts and totals; incomplete data stays private", async () => {
  const pending = await filing({ reported_entry_count: 2, reported_total_value: 200 }, undefined, false);
  await rejected("update public.filings set import_status = 'complete' where id = $1", [pending.id], /row count or value total/);
  await db.exec("set local role anon;");
  assert.equal((await db.query("select * from public.filings")).rows.length, 0);
  assert.equal((await db.query("select * from public.holdings")).rows.length, 0);
  assert.equal((await db.query("select * from public.quarterly_portfolios")).rows.length, 0);
  await db.exec("set local role service_role;");
  await db.query("update public.filings set reported_entry_count = 1 where id = $1", [pending.id]);
  await rejected("update public.filings set import_status = 'complete' where id = $1", [pending.id], /row count or value total/);
  await db.query("update public.filings set reported_total_value = 100, import_status = 'complete' where id = $1", [pending.id]);
  await db.exec("set local role anon;");
  assert.equal((await db.query("select * from public.portfolio_holdings")).rows.length, 1);
  assert.ok((await db.query("select validated_at from public.filings")).rows[0].validated_at);
});

test("a CIK can count for an investor from a quarter end on", async () => {
  const owner = await investor();
  await insert("investor_ciks", { cik: "0002026053", investor_id: owner.id, entity_name: "Pershing Square, Inc.",
    source_reference: "https://www.sec.gov/example", first_report_period: "2026-06-30" });
  await rejected(`insert into public.investor_ciks (cik, investor_id, entity_name, source_reference, first_report_period)
    values ('0009999999', $1, 'Example', 'https://www.sec.gov/example', '2026-06-15')`, [owner.id], /check constraint/);
});

test("completion accepts a summary total that differs from the rows only by rounding", async () => {
  const rows = [{ quantity: 10, reported_value: 100 }, { quantity: 10, reported_value: 100 }];
  // Each of the 2 rows is rounded to a whole unit, so the total may differ by up to 1.
  for (const total of [199, 201]) {
    const rounded = await filing({ reported_total_value: total }, rows, false);
    await db.query("update public.filings set import_status = 'complete' where id = $1", [rounded.id]);
  }
  const off = await filing({ reported_total_value: 202 }, rows, false);
  await rejected("update public.filings set import_status = 'complete' where id = $1", [off.id], /row count or value total/);
});

test("quarterly portfolios apply additions, then restatements, then later additions", async () => {
  const original = await filing();
  const amendment = {
    investor_id: original.investor_id,
    original_filing_id: original.id,
    form_type: "13F-HR/A",
  };
  await filing({ ...amendment, amendment_type: "new_holdings", amendment_number: 1, filed_at: "2026-08-02T12:00:00Z" },
    [{ quantity: 20, reported_value: 200 }]);
  let summary = (await db.query("select * from public.quarterly_portfolios")).rows[0];
  assert.equal(Number(summary.value_usd), 300);
  assert.equal(Number(summary.holding_row_count), 2);
  const restatement = await filing({ ...amendment, amendment_type: "restatement", amendment_number: 2,
    filed_at: "2026-08-03T12:00:00Z" }, [{ quantity: 40, reported_value: 400 }]);
  await filing({ ...amendment, amendment_type: "new_holdings", amendment_number: 3,
    filed_at: "2026-08-04T12:00:00Z" }, [{ quantity: 5, reported_value: 50 }]);
  await filing({ ...amendment, amendment_type: "restatement", amendment_number: 4,
    filed_at: "2026-08-05T12:00:00Z" }, [{ quantity: 99, reported_value: 990 }], false);
  await db.exec("set local role anon;");
  summary = (await db.query("select * from public.quarterly_portfolios")).rows[0];
  assert.equal(summary.base_filing_id, restatement.id);
  assert.equal(Number(summary.value_usd), 450);
  assert.equal(Number(summary.source_filing_count), 2);
  assert.equal((await db.query("select * from public.filings")).rows.length, 4);
  assert.equal((await db.query("select * from public.portfolio_holdings")).rows.length, 2);
});

test("portfolio positions combine a quarter's rows per security; classes, options and units stay separate", async () => {
  await filing({}, [
    { quantity: 100, reported_value: 1000 },
    { quantity: 50, reported_value: 500 }, // The same position, reported for another subsidiary.
    { reported_cusip: "02079K305", reported_issuer: "ALPHABET INC", reported_class: "CL A", quantity: 10, reported_value: 2500 },
    { reported_cusip: "02079K107", reported_issuer: "ALPHABET INC", reported_class: "CL C", quantity: 10, reported_value: 2400 },
    { quantity: 5, reported_value: 50, position_type: "put" },
    { quantity: 7, reported_value: 70, quantity_type: "PRN" },
    { reported_cusip: null, reported_issuer: "NO CUSIP CO", reported_class: "COM", quantity: 1, reported_value: 10 },
    { reported_cusip: null, reported_issuer: "NO CUSIP CO", reported_class: "COM", quantity: 2, reported_value: 20 },
  ]);
  const positions = (await db.query(`select reported_issuer as issuer, reported_class as class, position_type, quantity_type,
      quantity::float8 as quantity, value_usd::float8 as value_usd, holding_row_count::int as rows
    from public.portfolio_positions order by portfolio_positions.value_usd desc`)).rows;
  assert.deepEqual(positions, [
    { issuer: "ALPHABET INC", class: "CL A", position_type: "long", quantity_type: "SH", quantity: 10, value_usd: 2500, rows: 1 },
    { issuer: "ALPHABET INC", class: "CL C", position_type: "long", quantity_type: "SH", quantity: 10, value_usd: 2400, rows: 1 },
    { issuer: "Example issuer", class: null, position_type: "long", quantity_type: "SH", quantity: 150, value_usd: 1500, rows: 2 },
    { issuer: "Example issuer", class: null, position_type: "long", quantity_type: "PRN", quantity: 7, value_usd: 70, rows: 1 },
    { issuer: "Example issuer", class: null, position_type: "put", quantity_type: "SH", quantity: 5, value_usd: 50, rows: 1 },
    { issuer: "NO CUSIP CO", class: "COM", position_type: "long", quantity_type: "SH", quantity: 3, value_usd: 30, rows: 2 },
  ]);
});

test("portfolio positions follow amendments, apply value units and show public readers only completed filings", async () => {
  const original = await filing({ value_multiplier: 1000 }, [{ quantity: 10, reported_value: 100 }]);
  const amendment = { investor_id: original.investor_id, original_filing_id: original.id, form_type: "13F-HR/A" };
  await filing({ ...amendment, amendment_type: "new_holdings", amendment_number: 1, filed_at: "2026-08-02T12:00:00Z" },
    [{ quantity: 20, reported_value: 200 }]);
  await filing({ ...amendment, amendment_type: "restatement", amendment_number: 2, filed_at: "2026-08-03T12:00:00Z" },
    [{ quantity: 99, reported_value: 990 }], false);
  await db.exec("set local role anon;");
  const positions = (await db.query(
    "select quantity::float8 as quantity, value_usd::float8 as value_usd, holding_row_count::int as rows from public.portfolio_positions",
  )).rows;
  assert.deepEqual(positions, [{ quantity: 30, value_usd: 100200, rows: 2 }]);
  await rejected("insert into public.portfolio_positions (investor_id) values ($1)", [original.investor_id], /permission denied|cannot insert/);
});

test("notice reports differ from verified empty portfolios; partial coverage is explicit", async () => {
  await filing({ form_type: "13F-NT", report_type: "notice", reported_entry_count: null, reported_total_value: null }, []);
  const empty = await filing({}, []);
  await filing({ report_type: "combination", has_confidential_omissions: true });
  const summaries = (await db.query("select * from public.quarterly_portfolios")).rows;
  assert.equal(summaries.length, 2);
  assert.equal(Number(summaries.find((row) => row.base_filing_id === empty.id).holding_row_count), 0);
  assert.ok(summaries.some((row) => row.has_other_reporting_managers && row.has_confidential_omissions));
});

test("holdings retain unmapped rows, option distinctions and source units", async () => {
  await filing({ value_multiplier: 1000 }, [
    { quantity: 10, reported_value: 100, position_type: "long" },
    { quantity: 20, reported_value: 200, position_type: "put" },
  ]);
  const rows = (await db.query("select * from public.portfolio_holdings order by source_row")).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.security_id === null));
  assert.deepEqual(rows.map((row) => row.position_type), ["long", "put"]);
  assert.deepEqual(rows.map((row) => Number(row.value_usd)), [100000, 200000]);
  assert.equal(Number((await db.query("select value_usd from public.quarterly_portfolios")).rows[0].value_usd), 300000);
});

test("completed source data is immutable while unresolved security mapping can be filled later", async () => {
  const complete = await filing();
  const mapped = await security();
  await db.query("update public.holdings set security_id = $1 where filing_id = $2", [mapped.id, complete.id]);
  await rejected("update public.holdings set quantity = 999 where filing_id = $1", [complete.id], /immutable/);
  await rejected("delete from public.holdings where filing_id = $1", [complete.id], /immutable/);
  await rejected("update public.filings set import_status = 'pending' where id = $1", [complete.id], /immutable/);
  await rejected("delete from public.filings where id = $1", [complete.id], /immutable/);
  await rejected(`insert into public.holdings (filing_id, source_row, reported_issuer, quantity, quantity_type, reported_value)
    values ($1, 2, 'Late row', 1, 'SH', 1)`, [complete.id], /immutable/);
});

test("duplicate accession/row IDs and cross-investor amendments are rejected", async () => {
  const original = await filing({}, undefined, false);
  await rejected(`insert into public.holdings (filing_id, source_row, reported_issuer, quantity, quantity_type, reported_value)
    values ($1, 1, 'Duplicate', 1, 'SH', 1)`, [original.id], /unique constraint/);
  const second = await filing({}, undefined, false);
  await rejected("update public.filings set accession_number = $1 where id = $2", [original.accession_number, second.id], /unique constraint/);
  await rejected(`update public.filings set original_filing_id = $1, amendment_type = 'restatement',
    amendment_number = 1, form_type = '13F-HR\/A' where id = $2`, [original.id, second.id], /same investor and quarter/);
});

test("identifier namespaces and nonoverlapping validity windows prevent ambiguous matches", async () => {
  const first = await security();
  const second = await security();
  const base = { security_id: first.id, identifier_type: "ticker", identifier_value: "EXAMPLE", namespace: "XNAS",
    valid_from: "2021-01-01", valid_to: "2023-01-01", source_reference: "Verified exchange record" };
  await insert("security_identifiers", base);
  await insert("security_identifiers", { ...base, security_id: second.id, valid_from: "2023-01-01", valid_to: null });
  await insert("security_identifiers", { ...base, security_id: second.id, namespace: "XNYS" });
  await rejected(`insert into public.security_identifiers
    (security_id, identifier_type, identifier_value, namespace, valid_from, valid_to, source_reference)
    values ($1, 'ticker', 'EXAMPLE', 'XNAS', '2022-01-01', '2024-01-01', 'Conflict')`, [second.id], /exclusion constraint/);
  await rejected(`insert into public.security_identifiers
    (security_id, identifier_type, identifier_value, valid_from, source_reference)
    values ($1, 'provider_symbol', 'EXAMPLE', '2021-01-01', 'Unscoped')`, [second.id], /check constraint/);
});

test("conversion ratios are public reference data with a positive ratio, a CUSIP and one record per conversion", async () => {
  const stock = await security();
  // Sirius XM's September 2024 merger: 0.1 new share for each Sirius XM share.
  const base = { security_id: stock.id, from_cusip: "82968B103", shares_per_share: "0.1", effective_date: "2024-09-09",
    description: "Sirius XM merger", source_reference: "https://example.com/official-record" };
  await insert("security_conversions", base);
  await insert("security_conversions", { ...base, from_cusip: "531229813", shares_per_share: "0.8375" });
  await rejected(`insert into public.security_conversions (security_id, from_cusip, shares_per_share, effective_date, description, source_reference)
    values ($1, '82968B103', 0.1, '2024-09-09', 'Again', 'Duplicate')`, [stock.id], /unique constraint/);
  for (const [cusip, ratio] of [["82968B10", 0.1], ["82968B103", 0], ["82968B103", -1]]) {
    await rejected(`insert into public.security_conversions (security_id, from_cusip, shares_per_share, effective_date, description, source_reference)
      values ($1, $2, $3, '2025-01-01', 'Invalid', 'Invalid')`, [stock.id, cusip, ratio], /check constraint/);
  }
  await db.exec("set local role anon;");
  const rows = (await db.query("select from_cusip, shares_per_share::text from public.security_conversions order by from_cusip")).rows;
  assert.deepEqual(rows, [{ from_cusip: "531229813", shares_per_share: "0.8375" }, { from_cusip: "82968B103", shares_per_share: "0.1" }]);
  await rejected(`insert into public.security_conversions (security_id, from_cusip, shares_per_share, effective_date, description, source_reference)
    values ($1, '037833100', 1, '2025-01-01', 'Unauthorized', 'Unauthorized')`, [stock.id], /permission denied/);
});

test("short-interest corrections preserve history, deduplicate retries and allow a legitimate reversion", async () => {
  const original = await observation({ validation_status: "accepted" });
  const key = { security_id: original.security_id, collection_run_id: original.collection_run_id };
  assert.equal(original.revision, 1);
  const repeated = await observation({ ...key, validation_status: "accepted" });
  assert.equal(repeated, undefined);
  const correction = await observation({ ...key, shares_short: 200 });
  assert.equal(correction.revision, 2);
  assert.equal(Number((await db.query("select shares_short from public.latest_short_interest")).rows[0].shares_short), 100);
  await db.query("update public.short_interest set validation_status = 'accepted' where id = $1", [correction.id]);
  assert.equal(Number((await db.query("select shares_short from public.latest_short_interest")).rows[0].shares_short), 200);
  const reversion = await observation({ ...key, validation_status: "accepted" });
  assert.equal(reversion.revision, 3);
  assert.equal(Number((await db.query("select shares_short from public.latest_short_interest")).rows[0].shares_short), 100);
  assert.equal((await db.query("select * from public.short_interest")).rows.length, 3);
});

test("short-interest providers remain separate and unsupported values stay unknown", async () => {
  const first = await observation({ validation_status: "accepted", short_percent_float: 125 });
  const otherRun = await run("short_interest", "another_provider");
  await observation({ security_id: first.security_id, collection_run_id: otherRun.id, provider: "another_provider",
    shares_short: 0, validation_status: "accepted" });
  const result = await db.query("select * from public.latest_short_interest");
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.float_shares === null && row.published_at === null));
  assert.equal((await db.query("select * from public.filings")).rows.length, 0);
  await rejected("update public.short_interest set shares_short = 999 where id = $1", [first.id], /immutable/);
  await rejected("delete from public.short_interest where id = $1", [first.id], /append-only/);
});

test("an older archived provider revision cannot replace newer accepted data", async () => {
  const current = await observation({ validation_status: "accepted", source_revision_at: "2026-07-25T12:00:00Z" });
  const older = await observation({ security_id: current.security_id, shares_short: 50,
    source_revision_at: "2026-07-20T12:00:00Z" });
  await rejected("update public.short_interest set validation_status = 'accepted' where id = $1", [older.id], /known older provider revision/);
  assert.equal(Number((await db.query("select shares_short from public.latest_short_interest")).rows[0].shares_short), 100);
});

test("completion rejects gaps in source-row numbering and later changes to amendment ownership", async () => {
  const pending = await filing({}, [{ quantity: 10, reported_value: 100, source_row: 2 }], false);
  await rejected("update public.filings set import_status = 'complete' where id = $1", [pending.id], /row count or value total/);
  const amendment = await filing({ investor_id: pending.investor_id, original_filing_id: pending.id,
    form_type: "13F-HR/A", amendment_type: "restatement", amendment_number: 1,
    filed_at: "2026-08-02T12:00:00Z" });
  assert.ok(amendment.id);
  const unrelated = await investor();
  await rejected("update public.filings set investor_id = $1 where id = $2", [unrelated.id, pending.id], /foreign key constraint/);
});

test("collector provenance and numeric constraints reject invalid input", async () => {
  const secRun = await run();
  const stock = await security();
  await rejected(`insert into public.short_interest
    (security_id, collection_run_id, provider, settlement_date, shares_short, source_reference)
    values ($1, $2, 'sec', '2026-07-15', 100, 'Example')`, [stock.id, secRun.id], /matching short_interest/);
  const pending = await filing({}, [], false);
  await rejected(`insert into public.holdings
    (filing_id, source_row, reported_issuer, quantity, quantity_type, reported_value)
    values ($1, 1, 'Invalid', 'NaN', 'SH', 1)`, [pending.id], /check constraint/);
  await rejected(`insert into public.holdings
    (filing_id, source_row, reported_issuer, quantity, quantity_type, position_type, reported_value)
    values ($1, 1, 'Invalid option', 1, 'PRN', 'put', 1)`, [pending.id], /check constraint/);
});

test("public roles can read validated research but cannot write or access collection logs", async () => {
  await filing();
  await filing({}, undefined, false);
  await observation({ validation_status: "accepted" });
  await observation();
  await observation({ validation_status: "rejected" });
  await rejected("truncate public.short_interest", [], /permission denied/);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set local role ${role};`);
    assert.equal((await db.query("select * from public.filings")).rows.length, 1);
    assert.equal((await db.query("select * from public.holdings")).rows.length, 1);
    assert.equal((await db.query("select * from public.short_interest")).rows.length, 1);
    assert.equal((await db.query("select * from public.latest_short_interest")).rows.length, 1);
    await rejected("select * from public.collection_runs", [], /permission denied/);
    await rejected("insert into public.investors (name, cik) values ('Unauthorized', '9999999999')", [], /permission denied/);
    await rejected("update public.holdings set quantity = 0", [], /permission denied/);
    await rejected("delete from public.short_interest", [], /permission denied/);
    const privileges = (await db.query(`select
      has_table_privilege(current_user, 'public.quarterly_portfolios', 'INSERT') as view_write,
      has_function_privilege(current_user, p.oid, 'EXECUTE') as helper_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'research_private' and p.proname = 'guard_filing'`)).rows[0];
    assert.equal(privileges.view_write, false);
    assert.equal(privileges.helper_execute, false);
  }
});

test("each investor's CIK is recorded, and a CIK belongs to one investor", async () => {
  const manager = await investor();
  const ciks = async (investorId) =>
    (await db.query("select cik from public.investor_ciks where investor_id = $1 order by cik", [investorId])).rows.map((row) => row.cik);
  assert.deepEqual(await ciks(manager.id), [manager.cik]);
  await insert("investor_ciks", {
    cik: "0000999999",
    investor_id: manager.id,
    entity_name: "Example former parent",
    source_reference: "https://data.sec.gov/submissions/CIK0000999999.json",
  });
  await rejected("insert into public.investors (name, cik) values ('Another manager', '0000999999')", [], /already belongs to another investor/);
  await rejected(`insert into public.investor_ciks (cik, investor_id, entity_name, source_reference)
    values ($1, $2, 'Duplicate', 'Example')`, [manager.cik, (await investor()).id], /duplicate key/);
  // Changing an investor's own CIK keeps the earlier one.
  await db.query("update public.investors set cik = '0000888888' where id = $1", [manager.id]);
  assert.deepEqual(await ciks(manager.id), ["0000888888", "0000999999", manager.cik].sort());
});

test("filings under an investor's former CIK join the same quarterly history", async () => {
  const manager = await investor();
  await insert("investor_ciks", {
    cik: "0000777777",
    investor_id: manager.id,
    entity_name: "Example former parent",
    source_reference: "https://data.sec.gov/submissions/CIK0000777777.json",
  });
  // The collector finds the investor through whichever CIK filed the report.
  const owner = async (filerCik) =>
    (await db.query("select investor_id from public.investor_ciks where cik = $1", [filerCik])).rows[0]?.investor_id;
  await filing({ investor_id: await owner("0000777777"), report_period: "2024-06-30", filed_at: "2024-08-13T12:00:00Z" });
  await filing({ investor_id: await owner(manager.cik), report_period: "2024-09-30", filed_at: "2024-11-13T12:00:00Z" });
  const quarters = (await db.query(
    "select investor_id, report_period::text from public.quarterly_portfolios order by report_period",
  )).rows;
  assert.deepEqual(quarters, [
    { investor_id: manager.id, report_period: "2024-06-30" },
    { investor_id: manager.id, report_period: "2024-09-30" },
  ]);
});

test("public roles can read investor CIKs but not change them", async () => {
  const manager = await investor();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set local role ${role};`);
    assert.equal((await db.query("select * from public.investor_ciks")).rows.length, 1);
    await rejected(`insert into public.investor_ciks (cik, investor_id, entity_name, source_reference)
      values ('0000666666', $1, 'Unauthorized', 'Example')`, [manager.id], /permission denied/);
    await rejected("delete from public.investor_ciks", [], /permission denied/);
  }
});

test("the CIK migration records existing investors without changing their data", async () => {
  const database = await createDatabase(migrations.indexOf("20261028180000_investor_ciks.sql"));
  try {
    await database.exec(`
      insert into public.investors (id, name, cik) values ('00000000-0000-0000-0000-000000000001', 'Existing manager', '0000000042');
      insert into public.collection_runs (id, collector, provider) values ('00000000-0000-0000-0000-000000000002', 'sec13f', 'sec');
      insert into public.filings (id, investor_id, collection_run_id, accession_number, report_period, filed_at, form_type,
        report_type, reported_entry_count, reported_total_value, value_multiplier, source_url)
      values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
        '0000000042-26-000001', '2026-06-30', '2026-08-01T12:00:00Z', '13F-HR', 'holdings', 0, 0, 1,
        'https://www.sec.gov/Archives/edgar/data/42/000000004226000001/0000000042-26-000001.txt');
      update public.filings set import_status = 'complete' where id = '00000000-0000-0000-0000-000000000003';
    `);
    const snapshot = async () => (await database.query(`select
      (select jsonb_agg(i) from public.investors i) as investors,
      (select jsonb_agg(f) from public.filings f) as filings,
      (select jsonb_agg(r) from public.collection_runs r) as runs`)).rows[0];
    const before = await snapshot();
    await database.exec(await readFile(new URL("20261028180000_investor_ciks.sql", migrationsDir), "utf8"));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await database.query("select cik, investor_id, entity_name, source_reference from public.investor_ciks")).rows, [{
      cik: "0000000042",
      investor_id: "00000000-0000-0000-0000-000000000001",
      entity_name: "Existing manager",
      source_reference: "https://data.sec.gov/submissions/CIK0000000042.json",
    }]);
  } finally {
    await database.close();
  }
});

test("the raw_row migration keeps only fields the columns cannot reproduce, and refuses to lose any", async () => {
  const name = "20261028210000_compact_holding_raw_rows.sql";
  const database = await createDatabase(migrations.indexOf(name));
  const migration = await readFile(new URL(name, migrationsDir), "utf8");
  const addHolding = (rawRow) => database.query(`insert into public.holdings (filing_id, source_row, reported_issuer, reported_cusip,
      quantity, quantity_type, reported_value, voting_sole, voting_shared, voting_none, raw_row)
    values ('00000000-0000-0000-0000-000000000003', 1, 'Example issuer', '123456789', 10, 'SH', 100, 10, 0, 0, $1::jsonb)`,
  [JSON.stringify(rawRow)]);
  try {
    await database.exec(`
      insert into public.investors (id, name, cik) values ('00000000-0000-0000-0000-000000000001', 'Existing manager', '0000000042');
      insert into public.collection_runs (id, collector, provider) values ('00000000-0000-0000-0000-000000000002', 'sec13f', 'sec');
      insert into public.filings (id, investor_id, collection_run_id, accession_number, report_period, filed_at, form_type,
        report_type, reported_entry_count, reported_total_value, value_multiplier, source_url)
      values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
        '0000000042-26-000001', '2026-06-30', '2026-08-01T12:00:00Z', '13F-HR', 'holdings', 1, 100, 1,
        'https://www.sec.gov/Archives/edgar/data/42/000000004226000001/0000000042-26-000001.txt');
    `);
    // A stored row without a field its columns hold could not be rebuilt afterwards: nothing changes.
    await addHolding({ cusip: "123456789" });
    await assert.rejects(database.exec(migration), /would lose source data/);
    await database.exec("rollback;");
    assert.deepEqual((await database.query("select raw_row from public.holdings")).rows, [{ raw_row: { cusip: "123456789" } }]);

    await database.exec("delete from public.holdings;");
    await addHolding({
      nameOfIssuer: "Example issuer", cusip: "123456789", figi: "BBG000000001", value: "100",
      shrsOrPrnAmt: { sshPrnamt: "10", sshPrnamtType: "SH" }, votingAuthority: { Sole: "10", Shared: "0", None: "0" },
    });
    await database.exec("update public.filings set import_status = 'complete' where id = '00000000-0000-0000-0000-000000000003';");
    await database.exec(migration);
    assert.deepEqual((await database.query("select raw_row from public.portfolio_holdings")).rows, [{ raw_row: { figi: "BBG000000001" } }]);
    // The recreated view keeps its read-only access, and completed rows stay immutable.
    assert.deepEqual((await database.query(`select
      has_table_privilege('anon', 'public.portfolio_holdings', 'SELECT') as read,
      has_table_privilege('anon', 'public.portfolio_holdings', 'INSERT') as write`)).rows, [{ read: true, write: false }]);
    await assert.rejects(database.query("update public.holdings set raw_row = '{}'"), /immutable/);
  } finally {
    await database.close();
  }
});

test("investors get a permanent, unique URL slug when they are added", async () => {
  const add = async (name, cik) => (await insert("investors", { name, cik })).slug;
  assert.equal(await add("Berkshire Hathaway Inc", "0001067983"), "berkshire-hathaway");
  assert.equal(await add("BlackRock, Inc.", "0002012383"), "blackrock");
  assert.equal(await add("PRICE T ROWE ASSOCIATES INC /MD/", "0000080255"), "price-t-rowe-associates");
  assert.equal(await add("D. E. Shaw & Co., Inc.", "0001009207"), "d-e-shaw");
  assert.equal(await add("Pershing Square Capital Management, L.P.", "0001336528"), "pershing-square-capital-management");
  // A taken slug gets the CIK; a name without letters or digits gets the CIK alone.
  assert.equal(await add("Example Capital LLC", "0000000101"), "example-capital");
  assert.equal(await add("Example Capital, L.P.", "0000000102"), "example-capital-102");
  assert.equal(await add("株式会社", "0000000103"), "103");
  // Renaming keeps the URL.
  await db.query("update public.investors set name = 'BlackRock Holdings' where cik = '0002012383'");
  assert.equal((await db.query("select slug from public.investors where cik = '0002012383'")).rows[0].slug, "blackrock");
  await rejected("update public.investors set slug = 'blackrock' where cik = '0001067983'", [], /duplicate key/);
  await rejected("insert into public.investors (name, cik, slug) values ('Bad', '0000000104', 'Not A Slug')", [], /check constraint/);
});

test("the slug migration gives existing investors the URLs the website already uses", async () => {
  const name = "20261029120000_investor_slugs.sql";
  const database = await createDatabase(migrations.indexOf(name));
  try {
    await database.exec(`
      insert into public.investors (name, cik, created_at) values
        ('Berkshire Hathaway Inc', '0001067983', '2026-10-28T12:00:00Z'),
        ('BlackRock, Inc.', '0002012383', '2026-10-28T13:00:00Z');
    `);
    const investors = "select id, name, cik, track_filings, created_at from public.investors order by cik";
    const before = (await database.query(investors)).rows;
    await database.exec(await readFile(new URL(name, migrationsDir), "utf8"));
    assert.deepEqual((await database.query(investors)).rows, before);
    assert.deepEqual((await database.query("select slug from public.investors order by cik")).rows.map((row) => row.slug),
      ["berkshire-hathaway", "blackrock"]);
  } finally {
    await database.close();
  }
});
