// Adds stocks to the research database: a securities row with its CUSIP and ticker for each, after
// checking OpenFIGI, SEC's company ticker file and our filings agree. Stock pages then find each
// stock's holdings by CUSIP. Also records CUSIPs filers mistyped for a stock, earlier CUSIPs replaced
// one-for-one in a corporate action, conversion ratios of other corporate actions, and moves CUSIP start
// dates back when older filings report them.
// Usage: npm run add:security -- --cusip 037833100 --ticker AAPL [--share-class "Class A"] [--dry-run]
//        npm run add:security -- --investor berkshire-hathaway [--top 500] [--dry-run]
//        npm run add:security -- --alias G6693N103 --ticker NU [--dry-run]
//        npm run add:security -- --predecessor 531229748 --ticker LLYVA --until 2025-12-15 --source <official URL> [--dry-run]
//        npm run add:security -- --conversion 82968B103 --ticker SIRI --ratio 0.1 --date 2024-09-09 --description <text> --source <official URL> [--dry-run]
//        npm run add:security -- --conversion 67066G104 --ticker NVDA --ratio 10 --date 2024-06-10 --description <text> --source <official URL> --split [--dry-run]
//        npm run add:security -- --extend-windows [--confirm-names <CUSIP>,…] [--dry-run]
//        npm run add:security -- --listing-names [--dry-run]
import { parseArgs } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lastQuarterBefore, nextQuarter } from "../../src/lib/stock.ts";
import { connect } from "../sec13f/store.mts";
import {
  carriedOver, LISTING_NAMES, markTickerConflicts, normalizeTicker, planAlias, planConversion, planEarlierStart, planPredecessor, planSecurity, sameCompany, secListing,
  shareClassOf,
  usListing, type Candidate, type Continuity, type PlannedSecurity,
} from "./identify.mts";
import {
  filingEvidence, listings, loadAll, must, OPENFIGI_BATCH, OPENFIGI_SPACING_MS, openFigi, PAGE_SIZE, requireEnv, secTickers, today,
} from "./sources.mts";

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

  const [[figiResult], secFile, directory] = await Promise.all([openFigi([cusip]), secTickers(), listings()]);
  const evidence = {
    cusip,
    ticker,
    figi: usListing(figiResult),
    sec: secListing(secFile, ticker),
    listing: directory.get(ticker) ?? null,
    filings: (await filingEvidence(db, [cusip])).get(cusip) ?? null,
  };
  const { figi, filings } = evidence;
  console.log(`CUSIP ${cusip}, ticker ${ticker}`);
  console.log(`  OpenFIGI: ${figi ? `${figi.ticker}, ${figi.name}, ${figi.securityType} (${figi.marketSector}, FIGI ${figi.compositeFigi})` : "no US listing"}`);
  console.log(`  SEC:      ${evidence.sec ? `${evidence.sec.ticker}, ${evidence.sec.name}, ${evidence.sec.exchange} (CIK ${evidence.sec.cik})` : "ticker not found"}`);
  console.log(`  Nasdaq:   ${evidence.listing ? `${evidence.listing.name}, listed on ${LISTING_NAMES[evidence.listing.exchange] ?? evidence.listing.exchange}`
    + `${evidence.listing.etf ? ", an ETF" : ""}` : "not in the directory of US-listed securities"}`);
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

  const [figiResults, secFile, directory, evidence] = await Promise.all([openFigi(newCusips), secTickers(), listings(), filingEvidence(db, newCusips)]);
  const candidates: Candidate[] = newCusips.map((cusip, i) => {
    const figi = usListing(figiResults[i]);
    if (!figi) return { cusip, ticker: null, plan: null, problems: ["OpenFIGI has no US listing (not listed, or delisted)"] };
    const sec = secListing(secFile, figi.ticker);
    const result = planSecurity(
      { cusip, ticker: figi.ticker, figi, sec, listing: directory.get(figi.ticker) ?? null, filings: evidence.get(cusip) ?? null },
      today(),
      shareClassOf(figi.name),
    );
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

// A CUSIP filers mistyped for a stock, recorded as an extra CUSIP of the stock for the quarters they used it.
async function addAlias(db: SupabaseClient, alias: string, ticker: string, dryRun: boolean) {
  const [tickerRow] = await must<{ security_id: string }[]>(
    db.from("security_identifiers").select("security_id").eq("identifier_type", "ticker").eq("identifier_value", ticker)
      .lte("valid_from", today()).or(`valid_to.is.null,valid_to.gt.${today()}`),
    "Look up ticker",
  );
  if (!tickerRow) throw new Error(`No stock has the ticker ${ticker}.`);
  const existing = await must<{ security_id: string }[]>(
    db.from("security_identifiers").select("security_id").eq("identifier_type", "cusip").eq("identifier_value", alias),
    "Look up CUSIP",
  );
  if (existing.length > 0) {
    console.log(`Already recorded: cusip ${alias} (security ${existing[0].security_id}). Nothing changed.`);
    return;
  }
  const security = await must<{ issuer_name: string }>(
    db.from("securities").select("issuer_name").eq("id", tickerRow.security_id).single(),
    "Read security",
  );
  const [figiResult] = await openFigi([alias], { includeUnlisted: true });
  const filings = (await filingEvidence(db, [alias])).get(alias) ?? null;
  const known = (figiResult as { data?: { name?: string }[] } | null)?.data ?? [];
  console.log(`CUSIP ${alias} for ${ticker} (${security.issuer_name})`);
  console.log(`  OpenFIGI: ${known.length > 0 ? `known as ${known[0].name}` : "not a known security, listed or delisted"}`);
  console.log(`  Filings:  ${filings ? `reported ${filings.firstPeriod} to ${filings.latestPeriod} as ${filings.reportedNames.join("; ")}` : "none report this CUSIP"}`);

  const { identifier, problems } = planAlias(alias, security.issuer_name, figiResult, filings);
  if (!identifier) throw new Error(`Not recording ${alias}:\n- ${problems.join("\n- ")}`);
  console.log(`  cusip  ${alias} for ${ticker}, from ${identifier.valid_from} until ${identifier.valid_to} (${identifier.source_reference})`);
  if (dryRun) {
    console.log("Dry run: database not changed.");
    return;
  }
  await must(db.from("security_identifiers").insert({ ...identifier, security_id: tickerRow.security_id }), "Add CUSIP");
  console.log(`Recorded ${alias} for ${ticker}.`);
}

// An earlier CUSIP of a stock, replaced one-for-one in a corporate action, recorded as a CUSIP of the
// stock until the conversion date.
// splitRatio: the old CUSIP was replaced in a stock split of that many shares per share.
// sourceNamesCusips: a person has confirmed the official record names the old and the new CUSIP.
async function addPredecessor(
  db: SupabaseClient, cusip: string, ticker: string, until: string, source: string,
  options: { statedOneForOne: boolean; splitRatio: number | undefined; sourceNamesCusips: boolean }, dryRun: boolean,
) {
  const [tickerRow] = await must<{ security_id: string }[]>(
    db.from("security_identifiers").select("security_id").eq("identifier_type", "ticker").eq("identifier_value", ticker)
      .lte("valid_from", today()).or(`valid_to.is.null,valid_to.gt.${today()}`),
    "Look up ticker",
  );
  if (!tickerRow) throw new Error(`No stock has the ticker ${ticker}.`);
  const existing = await must<{ security_id: string }[]>(
    db.from("security_identifiers").select("security_id").eq("identifier_type", "cusip").eq("identifier_value", cusip),
    "Look up CUSIP",
  );
  if (existing.length > 0) {
    console.log(`Already recorded: cusip ${cusip} (security ${existing[0].security_id}). Nothing changed.`);
    return;
  }
  const [security, stockCusips] = await Promise.all([
    must<{ issuer_name: string }>(db.from("securities").select("issuer_name").eq("id", tickerRow.security_id).single(), "Read security"),
    must<{ identifier_value: string; valid_from: string; valid_to: string | null }[]>(
      db.from("security_identifiers").select("identifier_value, valid_from, valid_to").eq("security_id", tickerRow.security_id).eq("identifier_type", "cusip"),
      "Read the stock's CUSIPs",
    ),
  ]);
  const [listedResult] = await openFigi([cusip]);
  const [knownResult] = await openFigi([cusip], { includeUnlisted: true });
  const filings = (await filingEvidence(db, [cusip])).get(cusip) ?? null;

  // Each investor's shares under the old CUSIP in its last quarter, and of the stock in the next quarter.
  const continuity: Continuity[] = [];
  if (filings) {
    const last = filings.latestPeriod;
    const next = nextQuarter(last);
    const current = stockCusips.filter((row) => row.valid_from <= next && (row.valid_to === null || next < row.valid_to)).map((row) => row.identifier_value);
    const [positions, reports, investors] = await Promise.all([
      must<{ investor_id: string; report_period: string; reported_cusip: string; quantity: string; value_usd: string }[]>(
        db.from("portfolio_positions").select("investor_id, report_period, reported_cusip, quantity::text, value_usd::text")
          .in("reported_cusip", [cusip, ...current]).in("report_period", [last, next]).eq("position_type", "long").eq("quantity_type", "SH"),
        "Read positions",
      ),
      must<{ investor_id: string }[]>(db.from("quarterly_portfolios").select("investor_id").eq("report_period", next), "Read reports"),
      must<{ id: string; slug: string }[]>(db.from("investors").select("id, slug"), "Read investors"),
    ]);
    const total = (investorId: string, period: string, cusips: string[], column: "quantity" | "value_usd") => positions
      .filter((row) => row.investor_id === investorId && row.report_period === period && cusips.includes(row.reported_cusip))
      .reduce((sum, row) => sum + Number(row[column]), 0);
    for (const investorId of new Set(positions.filter((row) => row.reported_cusip === cusip).map((row) => row.investor_id))) {
      if (!reports.some((row) => row.investor_id === investorId)) continue;
      const before = total(investorId, last, [cusip], "quantity");
      const after = total(investorId, next, current, "quantity");
      const priceBefore = before > 0 ? total(investorId, last, [cusip], "value_usd") / before : 0;
      const priceAfter = after > 0 ? total(investorId, next, current, "value_usd") / after : 0;
      continuity.push({
        investor: investors.find((row) => row.id === investorId)?.slug ?? investorId,
        before,
        after,
        priceRatio: priceBefore > 0 && priceAfter > 0 ? priceAfter / priceBefore : null,
      });
    }
  }

  const known = (knownResult as { data?: { name?: string }[] } | null)?.data ?? [];
  const listed = usListing(listedResult);
  console.log(`CUSIP ${cusip} as an earlier CUSIP of ${ticker} (${security.issuer_name}), until ${until}`);
  console.log(`  OpenFIGI: ${known.length > 0 ? `known as ${known[0].name}` : "not a known security"}${listed ? `, still listed as ${listed.ticker}` : ", no longer listed"}`);
  console.log(`  Filings:  ${filings ? `reported ${filings.firstPeriod} to ${filings.latestPeriod} by ${filings.filers} investor(s) as ${filings.reportedNames.join("; ")}` : "none report this CUSIP"}`);
  for (const row of continuity) {
    console.log(`  Shares:   ${row.investor} ${row.before} under ${cusip} in ${filings?.latestPeriod}, ${row.after} of ${ticker} in the next quarter`
      + `${carriedOver(row, options.splitRatio) ? (options.splitRatio === undefined ? " (unchanged)" : " (exactly as split)") : ""}; `
      + `value per share ×${row.priceRatio?.toFixed(2) ?? "?"}`);
  }
  console.log(`  Source:   ${source}`);

  const { identifier, problems } = planPredecessor({
    cusip,
    stockName: security.issuer_name,
    stockCusips: stockCusips.map((row) => ({ cusip: row.identifier_value, validFrom: row.valid_from, validTo: row.valid_to })),
    listed,
    known: knownResult,
    filings,
    until,
    source,
    continuity,
    ...options,
  });
  if (!identifier) throw new Error(`Not recording ${cusip}:\n- ${problems.join("\n- ")}`);
  console.log(`  cusip  ${cusip} for ${ticker}, from ${identifier.valid_from} until ${identifier.valid_to}`);
  if (dryRun) {
    console.log("Dry run: database not changed.");
    return;
  }
  await must(db.from("security_identifiers").insert({ ...identifier, security_id: tickerRow.security_id }), "Add CUSIP");
  console.log(`Recorded ${cusip} as an earlier CUSIP of ${ticker}.`);
}

// A corporate action's ratio: holders of fromCusip received ratio shares of the stock on the date. For a
// stock split (split), fromCusip is the stock's own CUSIP and each share became ratio shares.
async function addConversion(
  db: SupabaseClient,
  fromCusip: string,
  ticker: string,
  values: { ratio: string; date: string; description: string; source: string; split: boolean },
  dryRun: boolean,
) {
  const [tickerRow] = await must<{ security_id: string }[]>(
    db.from("security_identifiers").select("security_id").eq("identifier_type", "ticker").eq("identifier_value", ticker)
      .lte("valid_from", today()).or(`valid_to.is.null,valid_to.gt.${today()}`),
    "Look up ticker",
  );
  if (!tickerRow) throw new Error(`No stock has the ticker ${ticker}.`);
  const existing = await must<{ id: string }[]>(
    db.from("security_conversions").select("id").eq("security_id", tickerRow.security_id).eq("from_cusip", fromCusip).eq("effective_date", values.date),
    "Look up conversions",
  );
  if (existing.length > 0) {
    console.log(`Already recorded: ${fromCusip} into ${ticker} on ${values.date}. Nothing changed.`);
    return;
  }
  const before = lastQuarterBefore(values.date);
  const quarterEnd = nextQuarter(before);
  const [stockCusips, investors, [knownResult]] = await Promise.all([
    must<{ identifier_value: string; valid_from: string; valid_to: string | null }[]>(
      db.from("security_identifiers").select("identifier_value, valid_from, valid_to").eq("security_id", tickerRow.security_id).eq("identifier_type", "cusip"),
      "Read the stock's CUSIPs",
    ),
    must<{ id: string; slug: string }[]>(db.from("investors").select("id, slug"), "Read investors"),
    openFigi([fromCusip], { includeUnlisted: true }),
  ]);
  const coveringAt = (period: string) => stockCusips.filter((row) => row.valid_from <= period && (row.valid_to === null || period < row.valid_to))
    .map((row) => row.identifier_value);
  const covering = coveringAt(quarterEnd);
  const positions = await must<{ investor_id: string; report_period: string; reported_cusip: string; quantity: string }[]>(
    db.from("portfolio_positions").select("investor_id, report_period, reported_cusip, quantity::text")
      .in("reported_cusip", [fromCusip, ...covering]).in("report_period", [before, quarterEnd]).eq("position_type", "long").eq("quantity_type", "SH"),
    "Read positions",
  );
  const shares = (investorId: string, period: string, cusips: string[]) => positions
    .filter((row) => row.investor_id === investorId && row.report_period === period && cusips.includes(row.reported_cusip))
    .reduce((sum, row) => sum + Number(row.quantity), 0);
  const heldBefore = [...new Set(positions.filter((row) => row.reported_cusip === fromCusip && row.report_period === before).map((row) => row.investor_id))]
    .map((investorId) => ({ investorId, investor: investors.find((row) => row.id === investorId)?.slug ?? investorId, shares: shares(investorId, before, [fromCusip]) }));

  const known = (knownResult as { data?: { name?: string }[] } | null)?.data ?? [];
  console.log(`${values.split ? "Stock split" : "Conversion"} of ${fromCusip} into ${ticker}: ${values.ratio} shares per share on ${values.date} (${values.description})`);
  console.log(`  OpenFIGI: ${known.length > 0 ? `known as ${known[0].name}` : "not a known security"}`);
  for (const row of heldBefore) {
    console.log(`  Shares:   ${row.investor} held ${row.shares} of ${fromCusip} in ${before}, so ${values.split ? "held" : "received"} about `
      + `${Math.round(row.shares * Number(values.ratio))}${values.split ? " after the split" : ""}; `
      + `it reported ${shares(row.investorId, quarterEnd, covering)} of ${ticker} in ${quarterEnd}, including any other conversions and trades`);
  }
  console.log(`  Source:   ${values.source}`);

  const { conversion, problems } = planConversion({
    fromCusip,
    ratio: values.ratio,
    effectiveDate: values.date,
    description: values.description,
    source: values.source,
    known: knownResult,
    heldBefore,
    stockIdentified: covering.length > 0,
    fromIsStock: { before: coveringAt(before).includes(fromCusip), during: covering.includes(fromCusip) },
    split: values.split,
  });
  if (!conversion) throw new Error(`Not recording the conversion:\n- ${problems.join("\n- ")}`);
  if (dryRun) {
    console.log("Dry run: database not changed.");
    return;
  }
  await must(db.from("security_conversions").insert({ ...conversion, security_id: tickerRow.security_id }), "Add conversion");
  console.log(`Recorded the ${values.split ? "stock split" : "conversion"} of ${fromCusip} into ${ticker}.`);
}

// Records each stock's name in Nasdaq's directory of US-listed securities, by its current ticker, for
// pages to show a readable name ("Bank of America Corporation Common Stock" → "Bank of America"). Names
// that changed in the directory are updated; the names as filed are not touched.
async function addListingNames(db: SupabaseClient, dryRun: boolean) {
  const [tickers, securities, directory] = await Promise.all([
    loadAll<{ security_id: string; identifier_value: string; valid_from: string; valid_to: string | null }>((from, to) => db.from("security_identifiers")
      .select("security_id, identifier_value, valid_from, valid_to").eq("identifier_type", "ticker").order("id").range(from, to), "Read tickers"),
    loadAll<{ id: string; issuer_name: string; listing_name: string | null }>((from, to) => db.from("securities")
      .select("id, issuer_name, listing_name").order("id").range(from, to), "Read securities"),
    listings(),
  ]);
  const date = today();
  const currentTicker = new Map(tickers.filter((row) => row.valid_from <= date && (row.valid_to === null || date < row.valid_to))
    .map((row) => [row.security_id, row.identifier_value]));
  const changes: { id: string; ticker: string; from: string | null; to: string }[] = [];
  const missing: string[] = [];
  for (const security of securities) {
    const ticker = currentTicker.get(security.id);
    const name = ticker ? directory.get(ticker)?.name.trim() : undefined;
    if (!ticker || !name) missing.push(`  ${(ticker ?? "(no ticker)").padEnd(8)}${security.issuer_name}`);
    else if (name !== security.listing_name) changes.push({ id: security.id, ticker, from: security.listing_name, to: name });
  }
  console.log(`Listing names to record (${changes.length} of ${securities.length} stocks):`);
  for (const change of changes.slice(0, 20)) console.log(`  ${change.ticker.padEnd(8)}${change.from ? `${change.from} → ` : ""}${change.to}`);
  if (changes.length > 20) console.log(`  … and ${changes.length - 20} more`);
  if (missing.length > 0) console.log(`\nNot in Nasdaq's directory, so their pages keep the name as identified (${missing.length}):\n${missing.join("\n")}`);
  if (dryRun || changes.length === 0) {
    console.log(dryRun ? "\nDry run: database not changed." : "\nNothing changed.");
    return;
  }
  // A few at a time, so the database is not flooded with thousands of requests at once.
  for (let i = 0; i < changes.length; i += 10) {
    await Promise.all(changes.slice(i, i + 10).map((change) =>
      must(db.from("securities").update({ listing_name: change.to }).eq("id", change.id), "Record listing name")));
  }
  console.log(`\nRecorded ${changes.length} listing names.`);
}

// Moves recorded CUSIPs' start dates back to the earliest quarter our filings report them, after older
// quarters have been imported.
// confirmedNames: CUSIPs whose filers used a name the company had before a rename, checked by a person.
async function extendWindows(db: SupabaseClient, dryRun: boolean, confirmedNames: string[]) {
  const [identifiers, securities] = await Promise.all([
    loadAll<{ id: string; security_id: string; identifier_value: string; valid_from: string }>((from, to) => db.from("security_identifiers")
      .select("id, security_id, identifier_value, valid_from").eq("identifier_type", "cusip").order("id").range(from, to), "Read CUSIPs"),
    loadAll<{ id: string; issuer_name: string }>((from, to) => db.from("securities").select("id, issuer_name").order("id").range(from, to), "Read securities"),
  ]);
  const values = [...new Set(identifiers.map((row) => row.identifier_value))];
  console.log(`Checking ${values.length} recorded CUSIPs against our filings…`);
  const evidence = await filingEvidence(db, values);
  const moves: { id: string; cusip: string; from: string; validFrom: string; sourceReference: string }[] = [];
  const problems: string[] = [];
  for (const row of identifiers) {
    const name = securities.find((security) => security.id === row.security_id)?.issuer_name ?? "";
    const recordedTimes = identifiers.filter((other) => other.identifier_value === row.identifier_value).length;
    const plan = planEarlierStart({ validFrom: row.valid_from, recordedTimes }, name, evidence.get(row.identifier_value) ?? null,
      confirmedNames.includes(row.identifier_value));
    if (plan && "problem" in plan) problems.push(`  ${row.identifier_value} (${name}): ${plan.problem}`);
    else if (plan) moves.push({ id: row.id, cusip: row.identifier_value, from: row.valid_from, ...plan });
  }
  console.log(`\nStart dates to move back (${moves.length}):`);
  for (const move of moves) console.log(`  ${move.cusip}  ${move.from} → ${move.validFrom} (${move.sourceReference})`);
  if (problems.length > 0) console.log(`\nNeed a person (${problems.length}):\n${problems.join("\n")}`);
  if (dryRun || moves.length === 0) {
    console.log(dryRun ? "\nDry run: database not changed." : "\nNothing changed.");
    return;
  }
  for (const move of moves) {
    await must(db.from("security_identifiers").update({ valid_from: move.validFrom, source_reference: move.sourceReference }).eq("id", move.id), "Move start date");
  }
  console.log(`\nMoved ${moves.length} start dates.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      cusip: { type: "string" },
      ticker: { type: "string" },
      "share-class": { type: "string" },
      investor: { type: "string" },
      top: { type: "string" },
      alias: { type: "string" },
      predecessor: { type: "string" },
      until: { type: "string" },
      source: { type: "string" },
      conversion: { type: "string" },
      ratio: { type: "string" },
      date: { type: "string" },
      description: { type: "string" },
      "extend-windows": { type: "boolean", default: false },
      "listing-names": { type: "boolean", default: false },
      "stated-one-for-one": { type: "boolean", default: false },
      split: { type: "boolean", default: false },
      "split-ratio": { type: "string" },
      "source-names-cusips": { type: "boolean", default: false },
      "confirm-names": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const usage = "Usage: npm run add:security -- --cusip <CUSIP> --ticker <TICKER> [--share-class <name>] [--dry-run]\n"
    + "       npm run add:security -- --investor <slug> [--top <count>] [--dry-run]\n"
    + "       npm run add:security -- --alias <mistyped CUSIP> --ticker <TICKER> [--dry-run]\n"
    + "       npm run add:security -- --predecessor <old CUSIP> --ticker <TICKER> --until <conversion date> --source <official URL> [--stated-one-for-one | --split-ratio <shares per share>] [--source-names-cusips] [--dry-run]\n"
    + "       npm run add:security -- --conversion <CUSIP> --ticker <TICKER> --ratio <shares per share> --date <date> --description <text> --source <official URL> [--split] [--dry-run]\n"
    + "       npm run add:security -- --extend-windows [--confirm-names <CUSIP>,…] [--dry-run]\n"
    + "       npm run add:security -- --listing-names [--dry-run]";
  const db = () => connect(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"));
  const modes = [values.investor, values.cusip, values.alias, values.predecessor, values.conversion, values["extend-windows"] || undefined,
    values["listing-names"] || undefined]
    .filter((mode) => mode !== undefined);
  if (modes.length !== 1) throw new Error(usage);
  if (values.investor && !values.ticker) {
    const top = values.top === undefined ? null : Number(values.top);
    if (top !== null && !(Number.isInteger(top) && top > 0)) throw new Error(`--top must be a positive whole number.\n${usage}`);
    await addInvestorStocks(db(), values.investor.trim(), top, values["dry-run"]);
  } else if (values.cusip && values.ticker && !values.top) {
    await addOne(db(), values.cusip.trim().toUpperCase(), normalizeTicker(values.ticker), values["share-class"] ?? null, values["dry-run"]);
  } else if (values.alias && values.ticker && !values.top) {
    await addAlias(db(), values.alias.trim().toUpperCase(), normalizeTicker(values.ticker), values["dry-run"]);
  } else if (values.predecessor && values.ticker && values.until && values.source && !values.top) {
    const splitRatio = values["split-ratio"] === undefined ? undefined : Number(values["split-ratio"]);
    await addPredecessor(db(), values.predecessor.trim().toUpperCase(), normalizeTicker(values.ticker), values.until.trim(), values.source.trim(),
      { statedOneForOne: values["stated-one-for-one"], splitRatio, sourceNamesCusips: values["source-names-cusips"] }, values["dry-run"]);
  } else if (values.conversion && values.ticker && values.ratio && values.date && values.description && values.source && !values.top) {
    await addConversion(db(), values.conversion.trim().toUpperCase(), normalizeTicker(values.ticker), {
      ratio: values.ratio.trim(), date: values.date.trim(), description: values.description, source: values.source.trim(), split: values.split,
    }, values["dry-run"]);
  } else if (values["listing-names"] && !values.ticker && !values.top) {
    await addListingNames(db(), values["dry-run"]);
  } else if (values["extend-windows"] && !values.ticker && !values.top) {
    const confirmed = (values["confirm-names"] ?? "").split(",").map((cusip) => cusip.trim().toUpperCase()).filter(Boolean);
    await extendWindows(db(), values["dry-run"], confirmed);
  } else {
    throw new Error(usage);
  }
}

main().catch((error: unknown) => {
  console.error(`Adding securities failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
