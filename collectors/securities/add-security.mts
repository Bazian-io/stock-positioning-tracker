// Adds a stock to the research database: a securities row with its CUSIP and ticker, after checking
// OpenFIGI, SEC's company ticker file and our filings agree. Stock pages then find the stock's
// holdings by CUSIP.
// Usage: npm run add:security -- --cusip 037833100 --ticker AAPL [--share-class "Class A"] [--dry-run]
import { parseArgs } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSecClient } from "../sec13f/sec.mts";
import { connect } from "../sec13f/store.mts";
import {
  normalizeTicker, OPENFIGI_URL, planSecurity, SEC_TICKERS_URL, secListing, usListing, type FilingEvidence,
} from "./identify.mts";

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

async function openFigi(cusip: string): Promise<unknown> {
  const response = await fetch(OPENFIGI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ idType: "ID_CUSIP", idValue: cusip }]),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenFIGI returned HTTP ${response.status}`);
  return response.json();
}

// The quarters our filings report the CUSIP in, and the earliest filing as evidence.
async function filingEvidence(db: SupabaseClient, cusip: string): Promise<FilingEvidence | null> {
  const positions = await must<{ report_period: string; reported_issuer: string; reported_class: string | null }[]>(
    db.from("portfolio_positions").select("report_period, reported_issuer, reported_class").eq("reported_cusip", cusip).order("report_period"),
    "Read positions",
  );
  if (positions.length === 0) return null;
  const firstPeriod = positions[0].report_period;
  const [row] = await must<{ filing_id: string }[]>(
    db.from("portfolio_holdings").select("filing_id").eq("reported_cusip", cusip).eq("report_period", firstPeriod).limit(1),
    "Read evidence filing",
  );
  const filing = await must<{ source_url: string }>(db.from("filings").select("source_url").eq("id", row.filing_id).single(), "Read filing");
  return {
    firstPeriod,
    firstSourceUrl: filing.source_url,
    latestPeriod: positions[positions.length - 1].report_period,
    reportedNames: [...new Set(positions.map((position) => [position.reported_issuer, position.reported_class].filter(Boolean).join(" ")))],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      cusip: { type: "string" },
      ticker: { type: "string" },
      "share-class": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.cusip || !values.ticker) {
    throw new Error("Usage: npm run add:security -- --cusip <CUSIP> --ticker <TICKER> [--share-class <name>] [--dry-run]");
  }
  const cusip = values.cusip.trim().toUpperCase();
  const ticker = normalizeTicker(values.ticker);
  const db = connect(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"));

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

  const sec = createSecClient(requireEnv("SEC_USER_AGENT"));
  const evidence = {
    cusip,
    ticker,
    figi: usListing(await openFigi(cusip)),
    sec: secListing(JSON.parse((await sec.get(SEC_TICKERS_URL)).text), ticker),
    filings: await filingEvidence(db, cusip),
  };
  const { figi, filings } = evidence;
  console.log(`CUSIP ${cusip}, ticker ${ticker}`);
  console.log(`  OpenFIGI: ${figi ? `${figi.ticker}, ${figi.name}, ${figi.securityType} (${figi.marketSector}, FIGI ${figi.compositeFigi})` : "no US listing"}`);
  console.log(`  SEC:      ${evidence.sec ? `${evidence.sec.ticker}, ${evidence.sec.name}, ${evidence.sec.exchange} (CIK ${evidence.sec.cik})` : "ticker not found"}`);
  console.log(`  Filings:  ${filings ? `reported ${filings.firstPeriod} to ${filings.latestPeriod} as ${filings.reportedNames.join("; ")}` : "none report this CUSIP"}`);

  const { plan, problems } = planSecurity(evidence, new Date().toISOString().slice(0, 10), values["share-class"] ?? null);
  if (!plan) throw new Error(`Not adding ${ticker}:\n- ${problems.join("\n- ")}`);
  console.log(`  Security: ${plan.security.issuer_name}${plan.security.share_class ? `, ${plan.security.share_class}` : ""} (${plan.security.security_type})`);
  for (const identifier of plan.identifiers) {
    console.log(`  ${identifier.identifier_type.padEnd(6)} ${identifier.identifier_value}${identifier.namespace ? ` on ${identifier.namespace}` : ""}, from ${identifier.valid_from} (${identifier.source_reference})`);
  }
  if (values["dry-run"]) {
    console.log("Dry run: database not changed.");
    return;
  }

  const security = await must<{ id: string }>(db.from("securities").insert(plan.security).select("id").single(), "Add security");
  try {
    await must(db.from("security_identifiers").insert(plan.identifiers.map((row) => ({ ...row, security_id: security.id }))), "Add identifiers");
  } catch (error) {
    // Best effort: do not leave a security without identifiers.
    await must(db.from("securities").delete().eq("id", security.id), "Remove security").catch(() => undefined);
    throw error;
  }
  console.log(`Added ${ticker} (security ${security.id}).`);
}

main().catch((error: unknown) => {
  console.error(`Adding the security failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
