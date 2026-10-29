// Adds stocks to the research database: a securities row with its CUSIP and ticker for each, after
// checking OpenFIGI, SEC's company ticker file and our filings agree. Stock pages then find each
// stock's holdings by CUSIP.
// Usage: npm run add:security -- --cusip 037833100 --ticker AAPL [--share-class "Class A"] [--dry-run]
//        npm run add:security -- --investor berkshire-hathaway [--top 500] [--dry-run]
import { parseArgs } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSecClient } from "../sec13f/sec.mts";
import { connect } from "../sec13f/store.mts";
import {
  markTickerConflicts, normalizeTicker, OPENFIGI_URL, openFigiJob, planSecurity, sameCompany, SEC_TICKERS_URL, secListing, shareClassOf, usListing,
  type Candidate, type FilingEvidence, type PlannedSecurity,
} from "./identify.mts";

const PAGE_SIZE = 1000; // Supabase's default maximum rows per API response.
// OpenFIGI without an API key: 25 requests a minute, 10 identifiers per request.
const OPENFIGI_BATCH = 10;
const OPENFIGI_SPACING_MS = 2_500;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

// supabase-js reports failures in the result instead of throwing.
async function must<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, action: string) {
  const { data, error } = await request;
  if (error) throw new Error(`${action}: ${error.message}`);
  return data as T;
}

async function loadAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, action: string) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const data = await must<T[]>(page(from, from + PAGE_SIZE - 1), action);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// OpenFIGI's result for each CUSIP, in order. Requests are spaced to stay within the rate limit; a
// rate-limited request waits a minute and is retried.
async function openFigi(cusips: string[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let i = 0; i < cusips.length; i += OPENFIGI_BATCH) {
    if (i > 0) await wait(OPENFIGI_SPACING_MS);
    const jobs = cusips.slice(i, i + OPENFIGI_BATCH).map(openFigiJob);
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(OPENFIGI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobs),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt < 4) {
        await wait(60_000);
        continue;
      }
      if (!response.ok) throw new Error(`OpenFIGI returned HTTP ${response.status}`);
      results.push(...(await response.json() as unknown[]));
      break;
    }
  }
  return results;
}

// Where our filings report each CUSIP: the quarters, the names filers used, and the earliest filing as
// evidence.
async function filingEvidence(db: SupabaseClient, cusips: string[]): Promise<Map<string, FilingEvidence>> {
  type Row = { reported_cusip: string; report_period: string; reported_issuer: string; reported_class: string | null; filing_id: string };
  const rows: Row[] = [];
  for (let i = 0; i < cusips.length; i += 100) {
    rows.push(...await loadAll<Row>((from, to) => db.from("portfolio_holdings")
      .select("reported_cusip, report_period, reported_issuer, reported_class, filing_id")
      .in("reported_cusip", cusips.slice(i, i + 100))
      .order("report_period").order("filed_at").order("filing_id").order("source_row")
      .range(from, to), "Read holdings"));
  }
  const firstFilings = [...new Set(cusips.map((cusip) => rows.find((row) => row.reported_cusip === cusip)?.filing_id).filter((id) => id !== undefined))];
  const filings = await must<{ id: string; source_url: string }[]>(
    db.from("filings").select("id, source_url").in("id", firstFilings),
    "Read filings",
  );
  const evidence = new Map<string, FilingEvidence>();
  for (const cusip of cusips) {
    const reported = rows.filter((row) => row.reported_cusip === cusip);
    const sourceUrl = filings.find((filing) => filing.id === reported[0]?.filing_id)?.source_url;
    if (!sourceUrl) continue;
    evidence.set(cusip, {
      firstPeriod: reported[0].report_period,
      firstSourceUrl: sourceUrl,
      latestPeriod: reported[reported.length - 1].report_period,
      reportedNames: [...new Set(reported.map((row) => [row.reported_issuer, row.reported_class].filter(Boolean).join(" ")))],
    });
  }
  return evidence;
}

async function secTickers() {
  return JSON.parse((await createSecClient(requireEnv("SEC_USER_AGENT")).get(SEC_TICKERS_URL)).text);
}

const today = () => new Date().toISOString().slice(0, 10);

async function insertSecurity(db: SupabaseClient, plan: PlannedSecurity): Promise<string> {
  const security = await must<{ id: string }>(db.from("securities").insert(plan.security).select("id").single(), "Add security");
  try {
    await must(db.from("security_identifiers").insert(plan.identifiers.map((row) => ({ ...row, security_id: security.id }))), "Add identifiers");
  } catch (error) {
    // Best effort: do not leave a security without identifiers.
    await must(db.from("securities").delete().eq("id", security.id), "Remove security").catch(() => undefined);
    throw error;
  }
  return security.id;
}

function printPlan(plan: PlannedSecurity) {
  console.log(`  Security: ${plan.security.issuer_name}${plan.security.share_class ? `, ${plan.security.share_class}` : ""} (${plan.security.security_type})`);
  for (const identifier of plan.identifiers) {
    console.log(`  ${identifier.identifier_type.padEnd(6)} ${identifier.identifier_value}${identifier.namespace ? ` on ${identifier.namespace}` : ""}, from ${identifier.valid_from} (${identifier.source_reference})`);
  }
}

// One stock, with the ticker given by the user.
async function addOne(db: SupabaseClient, cusip: string, ticker: string, shareClass: string | null, dryRun: boolean) {
  const existing = await must<{ security_id: string; identifier_type: string; identifier_value: string }[]>(
    db.from("security_identifiers")
      .select("security_id, identifier_type, identifier_value")
      .or(`and(identifier_type.eq.cusip,identifier_value.eq.${cusip}),and(identifier_type.eq.ticker,identifier_value.eq.${ticker})`),
    "Look up identifiers",
  );
  if (existing.length > 0) {
    const listed = existing.map((row) => `${row.identifier_type} ${row.identifier_value} (security ${row.security_id})`).join(", ");
    console.log(`Already recorded: ${listed}. Nothing changed.`);
    return;
  }

  const [figiResult] = await openFigi([cusip]);
  const evidence = {
    cusip,
    ticker,
    figi: usListing(figiResult),
    sec: secListing(await secTickers(), ticker),
    filings: (await filingEvidence(db, [cusip])).get(cusip) ?? null,
  };
  const { figi, filings } = evidence;
  console.log(`CUSIP ${cusip}, ticker ${ticker}`);
  console.log(`  OpenFIGI: ${figi ? `${figi.ticker}, ${figi.name}, ${figi.securityType} (${figi.marketSector}, FIGI ${figi.compositeFigi})` : "no US listing"}`);
  console.log(`  SEC:      ${evidence.sec ? `${evidence.sec.ticker}, ${evidence.sec.name}, ${evidence.sec.exchange} (CIK ${evidence.sec.cik})` : "ticker not found"}`);
  console.log(`  Filings:  ${filings ? `reported ${filings.firstPeriod} to ${filings.latestPeriod} as ${filings.reportedNames.join("; ")}` : "none report this CUSIP"}`);

  const { plan, problems } = planSecurity(evidence, today(), shareClass);
  if (!plan) throw new Error(`Not adding ${ticker}:\n- ${problems.join("\n- ")}`);
  printPlan(plan);
  if (dryRun) {
    console.log("Dry run: database not changed.");
    return;
  }
  console.log(`Added ${ticker} (security ${await insertSecurity(db, plan)}).`);
}

// The stocks an investor reported, each with the ticker OpenFIGI maps its CUSIP to. --top keeps the
// largest positions, by the largest value reported in any quarter.
async function addInvestorStocks(db: SupabaseClient, slug: string, top: number | null, dryRun: boolean) {
  const investor = await must<{ id: string; name: string } | null>(
    db.from("investors").select("id, name").eq("slug", slug).maybeSingle(),
    "Read investor",
  );
  if (!investor) throw new Error(`No investor has the slug ${slug}.`);

  // Long share positions, largest first; options and principal amounts (bonds) are not stocks.
  const cusips: string[] = [];
  for (let from = 0; top === null || cusips.length < top; from += PAGE_SIZE) {
    const page = await must<{ reported_cusip: string }[]>(
      db.from("portfolio_positions").select("reported_cusip")
        .eq("investor_id", investor.id).eq("position_type", "long").eq("quantity_type", "SH").not("reported_cusip", "is", null)
        .order("value_usd", { ascending: false }).order("reported_cusip").order("report_period")
        .range(from, from + PAGE_SIZE - 1),
      "Read positions",
    );
    for (const { reported_cusip: cusip } of page) {
      if (!cusips.includes(cusip) && (top === null || cusips.length < top)) cusips.push(cusip);
    }
    if (page.length < PAGE_SIZE) break;
  }

  const identifiers = await loadAll<{ identifier_type: string; identifier_value: string }>((from, to) => db.from("security_identifiers")
    .select("identifier_type, identifier_value").in("identifier_type", ["cusip", "ticker"]).order("id").range(from, to), "Read identifiers");
  const recorded = (type: string) => new Set(identifiers.filter((row) => row.identifier_type === type).map((row) => row.identifier_value));
  const recordedCusips = recorded("cusip");
  const newCusips = cusips.filter((cusip) => !recordedCusips.has(cusip));
  console.log(`${investor.name}: ${cusips.length} reported stock CUSIPs, ${cusips.length - newCusips.length} already recorded.`);
  console.log(`Checking ${newCusips.length} with OpenFIGI (about ${Math.ceil(newCusips.length / OPENFIGI_BATCH * OPENFIGI_SPACING_MS / 60_000)} min), SEC and our filings…`);

  const [figiResults, secFile, evidence] = await Promise.all([openFigi(newCusips), secTickers(), filingEvidence(db, newCusips)]);
  const candidates: Candidate[] = newCusips.map((cusip, i) => {
    const figi = usListing(figiResults[i]);
    if (!figi) return { cusip, ticker: null, plan: null, problems: ["OpenFIGI has no US listing (not listed, or delisted)"] };
    const sec = secListing(secFile, figi.ticker);
    const result = planSecurity({ cusip, ticker: figi.ticker, figi, sec, filings: evidence.get(cusip) ?? null }, today(), shareClassOf(figi.name));
    // No person chose this ticker, so the two sources must also name the same company.
    if (result.plan && sec && !sameCompany(figi.name, sec.name)) {
      return { cusip, ticker: figi.ticker, plan: null, problems: [`OpenFIGI names ${cusip} "${figi.name}" but SEC lists ${figi.ticker} as "${sec.name}"`] };
    }
    return { cusip, ticker: figi.ticker, ...result };
  });
  markTickerConflicts(candidates, recorded("ticker"));

  const plans = candidates.flatMap((candidate) => (candidate.plan ? [candidate.plan] : []));
  console.log(`\nTo add (${plans.length}):`);
  for (const { security, identifiers: [cusip, ticker] } of plans) {
    const shareClass = security.share_class ? `, ${security.share_class}` : "";
    console.log(`  ${ticker.identifier_value.padEnd(7)} ${cusip.identifier_value}  ${security.issuer_name}${shareClass} (${security.security_type}, ${ticker.namespace}, CUSIP from ${cusip.valid_from})`);
  }
  const skipped = candidates.filter((candidate) => candidate.plan === null);
  console.log(`\nSkipped (${skipped.length}):`);
  for (const { cusip, ticker, problems } of skipped) console.log(`  ${(ticker ?? "").padEnd(7)} ${cusip}  ${problems.join("; ")}`);

  if (dryRun) {
    console.log("\nDry run: database not changed.");
    return;
  }
  for (const [i, plan] of plans.entries()) {
    try {
      await insertSecurity(db, plan);
    } catch (error) {
      const ticker = plan.identifiers[1].identifier_value;
      throw new Error(`Adding ${ticker} failed after ${i} of ${plans.length} were added (running again skips them): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\nAdded ${plans.length} stocks.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      cusip: { type: "string" },
      ticker: { type: "string" },
      "share-class": { type: "string" },
      investor: { type: "string" },
      top: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const usage = "Usage: npm run add:security -- --cusip <CUSIP> --ticker <TICKER> [--share-class <name>] [--dry-run]\n"
    + "       npm run add:security -- --investor <slug> [--top <count>] [--dry-run]";
  const db = () => connect(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"));
  if (values.investor && !values.cusip && !values.ticker) {
    const top = values.top === undefined ? null : Number(values.top);
    if (top !== null && !(Number.isInteger(top) && top > 0)) throw new Error(`--top must be a positive whole number.\n${usage}`);
    await addInvestorStocks(db(), values.investor.trim(), top, values["dry-run"]);
  } else if (values.cusip && values.ticker && !values.investor && !values.top) {
    await addOne(db(), values.cusip.trim().toUpperCase(), normalizeTicker(values.ticker), values["share-class"] ?? null, values["dry-run"]);
  } else {
    throw new Error(usage);
  }
}

main().catch((error: unknown) => {
  console.error(`Adding securities failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
