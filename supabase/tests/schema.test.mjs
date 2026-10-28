import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

let db;
let accession = 0;
let cik = 0;

before(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  // Supabase provides these roles. Reproduce them only inside this disposable database.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  const migration = await readFile(
    new URL("../migrations/20261028000000_initial_research_schema.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
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

test("migration creates exactly seven tables, all protected by RLS", async () => {
  const result = await db.query(`
    select c.relname, c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by c.relname
  `);
  assert.deepEqual(result.rows.map((row) => row.relname), [
    "collection_runs", "filings", "holdings", "investors", "securities", "security_identifiers", "short_interest",
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
