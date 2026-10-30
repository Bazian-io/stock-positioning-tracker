// Read-only check of the research data, to run after each import or change. It uses the publishable
// key, which cannot write, and lists what a person should review: missing quarters, possibly mistyped
// CUSIPs, holdings outside their CUSIP's recorded dates, values that disagree, likely stock splits, recorded
// conversions and, with --identities, stocks whose ticker or CUSIP has changed since they were added.
// Usage: npm run check:data [-- --identities]
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { lastQuarterBefore, nextQuarter, previousQuarter } from "../../src/lib/stock.ts";
import { isValidCusip, LISTING_MICS, LISTING_NAMES, sameCompany, secListing, usListing } from "../securities/identify.mts";
import { listings, loadAll, openFigi, requireEnv, secTickers, today } from "../securities/sources.mts";
import {
  consecutivePairs, latestDueQuarter, likelyPredecessors, marketSplits, outsideWindows, priceDisagreements, priceJumps, stockOf, suspectedTypos,
  type CusipRecord, type Position,
} from "./findings.mts";

const usd = (value: number) => `$${(value / 1e9).toFixed(2)}B`;
const LIST_LIMIT = 20;
const quarter = (period: string) => `Q${Number(period.slice(5, 7)) / 3} ${period.slice(0, 4)}`;

async function main() {
  const { values } = parseArgs({ options: { identities: { type: "boolean", default: false } } });
  const key = requireEnv("SUPABASE_PUBLISHABLE_KEY");
  if (key.startsWith("sb_secret_")) throw new Error("SUPABASE_PUBLISHABLE_KEY holds a secret key; this check reads with the publishable key only");
  const db = createClient(requireEnv("SUPABASE_URL"), key, { auth: { persistSession: false, autoRefreshToken: false } });

  type PositionRow = {
    investor_id: string; report_period: string; reported_cusip: string | null; reported_issuer: string; position_type: string;
    quantity_type: string; quantity: string; value_usd: string;
  };
  const [investors, quarters, identifiers, securities, conversions] = await Promise.all([
    loadAll<{ id: string; slug: string }>((from, to) => db.from("investors").select("id, slug").order("slug").range(from, to), "Read investors"),
    loadAll<{ investor_id: string; report_period: string; has_confidential_omissions: boolean }>((from, to) => db.from("quarterly_portfolios")
      .select("investor_id, report_period, has_confidential_omissions").order("investor_id").order("report_period").range(from, to), "Read quarters"),
    loadAll<{ security_id: string; identifier_type: string; identifier_value: string; namespace: string; valid_from: string; valid_to: string | null }>(
      (from, to) => db.from("security_identifiers").select("security_id, identifier_type, identifier_value, namespace, valid_from, valid_to")
        .in("identifier_type", ["cusip", "ticker"]).order("id").range(from, to), "Read identifiers"),
    loadAll<{ id: string; issuer_name: string }>((from, to) => db.from("securities").select("id, issuer_name").order("id").range(from, to), "Read securities"),
    loadAll<{ security_id: string; from_cusip: string; shares_per_share: string; effective_date: string; description: string }>((from, to) => db
      .from("security_conversions").select("security_id, from_cusip, shares_per_share::text, effective_date, description")
      .order("effective_date").order("security_id").order("from_cusip").range(from, to), "Read conversions"),
  ]);
  // Positions one investor-quarter at a time, a few at once: paging through every position in one list
  // reaches offsets the database cannot sort in time.
  const positionRows: PositionRow[] = [];
  for (let i = 0; i < quarters.length; i += 8) {
    const pages = await Promise.all(quarters.slice(i, i + 8).map((quarter) => loadAll<PositionRow>((from, to) => db.from("portfolio_positions")
      .select("investor_id, report_period, reported_cusip, reported_issuer, position_type, quantity_type, quantity::text, value_usd::text")
      .eq("investor_id", quarter.investor_id).eq("report_period", quarter.report_period)
      .order("reported_cusip").order("reported_issuer").order("position_type").order("quantity_type")
      .range(from, to), "Read positions")));
    positionRows.push(...pages.flat());
  }
  const slug = (investorId: string) => investors.find((investor) => investor.id === investorId)?.slug ?? investorId;
  const positions: Position[] = positionRows.map((row) => ({
    investorId: row.investor_id,
    reportPeriod: row.report_period,
    cusip: row.reported_cusip,
    issuer: row.reported_issuer,
    positionType: row.position_type,
    quantityType: row.quantity_type,
    shares: Number(row.quantity),
    valueUsd: Number(row.value_usd),
  }));
  const cusips: CusipRecord[] = identifiers.filter((row) => row.identifier_type === "cusip")
    .map((row) => ({ securityId: row.security_id, cusip: row.identifier_value, validFrom: row.valid_from, validTo: row.valid_to }));
  const date = today();
  const currentTicker = (securityId: string) => identifiers.find((row) => row.security_id === securityId && row.identifier_type === "ticker"
    && row.valid_from <= date && (row.valid_to === null || date < row.valid_to));
  const tickerOf = (securityId: string) => currentTicker(securityId)?.identifier_value ?? `security ${securityId}`;
  let review = 0;
  const section = (title: string) => console.log(`\n${title}`);
  // Long lists show the largest first, by the total value filings reported, and stop after LIST_LIMIT.
  const cusipValue = new Map<string, number>();
  for (const position of positions) {
    if (position.cusip && position.positionType === "long") cusipValue.set(position.cusip, (cusipValue.get(position.cusip) ?? 0) + position.valueUsd);
  }
  const valueOf = (cusip: string | null) => cusipValue.get(cusip ?? "") ?? 0;
  const top = <T,>(items: T[], value: (item: T) => number) => [...items].sort((a, b) => value(b) - value(a)).slice(0, LIST_LIMIT);
  const more = (items: unknown[]) => {
    if (items.length > LIST_LIMIT) console.log(`    … and ${items.length - LIST_LIMIT} more`);
  };
  const stockName = (securityId: string) => securities.find((security) => security.id === securityId)?.issuer_name ?? "";

  console.log(`Data check (read-only), ${date}: ${investors.length} investors, ${quarters.length} quarters, ${positions.length} positions, `
    + `${securities.length} stocks`);

  section("Freshness");
  const due = latestDueQuarter(date);
  console.log(`  13F reports for ${quarter(due.reportPeriod)} were due by ${due.dueDate}.`);
  for (const investor of investors) {
    const latest = quarters.filter((row) => row.investor_id === investor.id).at(-1)?.report_period;
    const behind = !latest || latest < due.reportPeriod;
    if (behind) review++;
    console.log(`  ${investor.slug}: latest ${latest ? quarter(latest) : "none"}${behind ? ` — import ${quarter(due.reportPeriod)}` : ""}`);
  }
  console.log("  Amendments can arrive months later: re-run the latest quarters after each deadline.");

  section("Stock links");
  const reported = new Set(quarters.map((row) => `${row.investor_id}|${row.report_period}`));
  const predecessors = likelyPredecessors(positions, cusips, reported, nextQuarter,
    (issuer, securityId) => sameCompany(issuer, stockName(securityId)));
  review += predecessors.length;
  console.log(`  Likely earlier CUSIPs, replaced one-for-one (share count carried over), shown as "reported, not held" until linked (${predecessors.length}):`);
  for (const match of top(predecessors, (item) => valueOf(item.cusip))) {
    console.log(`    ${tickerOf(match.securityId)}: ${match.cusip} "${match.issuer}" (${usd(valueOf(match.cusip))} reported in all), `
      + `${slug(match.investorId)}${match.investors > 1 ? ` and ${match.investors - 1} other(s)` : ""} held ${match.shares.toLocaleString("en-US")} `
      + `shares in ${quarter(match.lastPeriod)} and the same number of ${tickerOf(match.securityId)} in ${quarter(nextQuarter(match.lastPeriod))}`);
  }
  more(predecessors);
  if (predecessors.length > 0) {
    console.log("      check an official record, then: npm run add:security -- --predecessor <CUSIP> --ticker <TICKER> "
      + "--until <conversion date> --source <record URL> --dry-run");
  }
  const linkedLater = new Set(predecessors.map((match) => `${match.cusip}|${match.securityId}`));
  // A CUSIP with a recorded conversion is explained: its holders' shares show as received on the stock's page.
  const converted = new Set(conversions.map((row) => row.from_cusip));
  const nameMatches = suspectedTypos(positions, cusips, isValidCusip)
    .filter((match) => !linkedLater.has(`${match.cusip}|${match.securityId}`) && !converted.has(match.cusip));
  const listMatches = (kind: string, title: string, hint: string | null) => {
    const matches = nameMatches.filter((match) => match.kind === kind);
    console.log(`  ${title} (${matches.length}):`);
    for (const match of top(matches, (item) => valueOf(item.cusip))) {
      const periods = match.reportPeriods.length > 2
        ? `${quarter(match.reportPeriods[0])} – ${quarter(match.reportPeriods.at(-1)!)} (${match.reportPeriods.length} quarters)`
        : match.reportPeriods.map(quarter).join(", ");
      console.log(`    ${tickerOf(match.securityId)}: ${match.cusip} "${match.issuer}" (${usd(valueOf(match.cusip))} reported in all), ${periods}`);
    }
    more(matches);
    if (hint && matches.length > 0) console.log(`      ${hint}`);
    return matches.length;
  };
  review += listMatches("typo", "Mistyped CUSIPs (invalid check digit), shown as \"reported, not held\" until recorded",
    "check: npm run add:security -- --alias <CUSIP> --ticker <TICKER> --dry-run");
  review += listMatches("same-name", "Other CUSIPs under the stock's name: a predecessor before a reorganization, or a typo that passes the check digit",
    "a typo: --alias; converted one-for-one: --predecessor; a split that changed the CUSIP: --predecessor with --split-ratio, then the split; "
      + "converted at another ratio: --conversion");
  listMatches("other-class", "Other CUSIPs of the same issuer: other classes or tracking stocks, or earlier CUSIPs converted at another ratio, for information", null);
  const outside = outsideWindows(positions, cusips);
  review += outside.length;
  console.log(`  Holdings under a recorded CUSIP outside its recorded dates (${outside.length}): shown as "unclear"`);
  const outsideCusips = [...new Set(outside.map((position) => position.cusip ?? ""))];
  for (const cusip of top(outsideCusips, (item) => outside.filter((position) => position.cusip === item).reduce((sum, position) => sum + position.valueUsd, 0))) {
    const held = outside.filter((position) => position.cusip === cusip);
    const periods = [...new Set(held.map((position) => position.reportPeriod))].sort();
    console.log(`    ${cusip} ${held[0].issuer}: ${held.length} holding(s), ${quarter(periods[0])}${periods.length > 1 ? ` – ${quarter(periods.at(-1)!)}` : ""}, `
      + usd(held.reduce((sum, position) => sum + position.valueUsd, 0)));
  }
  more(outsideCusips);
  if (outside.length > 0) console.log("      check: npm run add:security -- --extend-windows --dry-run (a renamed company needs --confirm-names)");
  const longShares = (position: Position) => position.positionType === "long" && position.quantityType === "SH";
  const events = [...new Set(conversions.map((row) => `${row.security_id}|${row.effective_date}`))];
  console.log(`  Recorded conversions (${events.length}), shares received compared with the next reported holding, for information:`);
  for (const event of events) {
    const [securityId, effectiveDate] = event.split("|");
    const parts = conversions.filter((row) => row.security_id === securityId && row.effective_date === effectiveDate);
    const before = lastQuarterBefore(effectiveDate);
    const after = nextQuarter(before);
    console.log(`    ${tickerOf(securityId)} on ${effectiveDate}: ${parts.map((row) => `${row.from_cusip} ×${row.shares_per_share}`).join(", ")} (${parts[0].description})`);
    for (const investor of investors) {
      const received = parts.reduce((sum, row) => sum + positions.filter((position) => longShares(position) && position.investorId === investor.id
        && position.reportPeriod === before && position.cusip === row.from_cusip).reduce((total, position) => total + position.shares, 0) * Number(row.shares_per_share), 0);
      if (received === 0) continue;
      const reportedAfter = positions.filter((position) => longShares(position) && position.investorId === investor.id && position.reportPeriod === after
        && stockOf(position, cusips) === securityId).reduce((total, position) => total + position.shares, 0);
      const difference = Math.round(reportedAfter - received);
      console.log(`      ${investor.slug}: received about ${Math.round(received).toLocaleString("en-US")} from ${quarter(before)} holdings; `
        + `reported ${reportedAfter.toLocaleString("en-US")} in ${quarter(after)} (${difference >= 0 ? "+" : ""}${difference.toLocaleString("en-US")})`);
    }
  }
  console.log("  Latest reported long share value linked to stock pages:");
  for (const investor of investors) {
    const latest = quarters.filter((row) => row.investor_id === investor.id).at(-1)?.report_period;
    const held = positions.filter((position) => position.investorId === investor.id && position.reportPeriod === latest
      && position.positionType === "long" && position.quantityType === "SH");
    const total = held.reduce((sum, position) => sum + position.valueUsd, 0);
    const linked = held.filter((position) => stockOf(position, cusips) !== null).reduce((sum, position) => sum + position.valueUsd, 0);
    console.log(`    ${investor.slug}: ${total > 0 ? ((100 * linked) / total).toFixed(1) : "0.0"}% of ${usd(total)}`);
  }

  section("Values");
  const pairs = consecutivePairs(positions, reported, previousQuarter);
  const splits = pairs.filter((pair) => pair.splitRatio !== null);
  console.log(`  Likely stock splits, labelled on stock pages (${splits.length}):`);
  for (const { current, splitRatio } of splits) {
    console.log(`    ${slug(current.investorId)} ${current.issuer} ${quarter(current.reportPeriod)}: shares ×${splitRatio}`);
  }
  // Splits seen across every holder of a stock; recorded ones are shown on stock pages as splits.
  const splitQuarters = marketSplits(positions, previousQuarter);
  const recordedSplit = (cusip: string, reportPeriod: string) => conversions.some((row) => row.from_cusip === cusip
    && row.effective_date > previousQuarter(reportPeriod) && row.effective_date <= reportPeriod);
  // Only stocks with a page need a recorded split; warrants, units and funds have none.
  const splitStock = (split: { cusip: string; reportPeriod: string }) => stockOf({ cusip: split.cusip, reportPeriod: split.reportPeriod } as Position, cusips);
  const unrecorded = splitQuarters.filter((split) => splitStock(split) !== null && !recordedSplit(split.cusip, split.reportPeriod));
  review += unrecorded.length;
  console.log(`  Stock splits seen across all holders of a stock, not yet recorded (${unrecorded.length}): shown as large changes until recorded`);
  for (const split of unrecorded) {
    const ratio = split.ratio >= 1 ? `${split.ratio}-for-1` : `1-for-${Math.round(1 / split.ratio)}`;
    console.log(`    ${tickerOf(splitStock(split)!)} ${split.cusip} "${split.issuer}" ${quarter(split.reportPeriod)}: ${ratio} `
      + `(value per share ×${split.priceRatio.toFixed(3)}, shares ×${split.shareRatio.toFixed(2)}, ${split.holders} holder(s))`);
  }
  if (unrecorded.length > 0) {
    console.log("      check the company's announcement, then: npm run add:security -- --conversion <CUSIP> --ticker <TICKER> --ratio <ratio> "
      + "--date <first split-adjusted trading day> --description \"<company>'s <ratio> stock split\" --source <announcement URL> --split");
  }
  const split = new Set(splitQuarters.map((entry) => `${entry.cusip}|${entry.reportPeriod}`));
  const jumps = priceJumps(pairs).filter((pair) => !split.has(`${pair.current.cusip}|${pair.current.reportPeriod}`));
  review += jumps.length;
  console.log(`  Value per share moving more than fourfold in a quarter, when other holders saw no such move, without a split pattern (${jumps.length}):`);
  for (const { current, previous, priceRatio } of top(jumps, (pair) => Math.max(pair.current.valueUsd, pair.previous.valueUsd))) {
    console.log(`    ${slug(current.investorId)} ${current.cusip} ${current.issuer} ${quarter(current.reportPeriod)}: ×${priceRatio.toFixed(2)} `
      + `(${usd(previous.valueUsd)} → ${usd(current.valueUsd)})`);
  }
  more(jumps);
  const disagreements = priceDisagreements(positions);
  review += disagreements.length;
  console.log(`  Value per share differing between investors by more than 10% (${disagreements.length}):`);
  for (const group of top(disagreements, (positions) => positions.reduce((sum, position) => sum + position.valueUsd, 0))) {
    console.log(`    ${group[0].cusip} ${group[0].issuer} ${quarter(group[0].reportPeriod)}: ${group.map((position) =>
      `${slug(position.investorId)} $${(position.valueUsd / position.shares).toFixed(2)}`).join(", ")}`);
  }
  more(disagreements);
  // Recorded CUSIPs with a bad check digit are filers' typos already recorded with --alias.
  const recordedCusips = new Set(cusips.map((record) => record.cusip));
  const invalid = positions.filter((position) => position.positionType === "long" && position.cusip && !isValidCusip(position.cusip)
    && !recordedCusips.has(position.cusip));
  console.log(`  Long positions with an invalid CUSIP check digit, not recorded as a typo: ${invalid.length} `
    + `(${usd(invalid.reduce((sum, position) => sum + position.valueUsd, 0))})`);
  const confidential = quarters.filter((row) => row.has_confidential_omissions);
  console.log(`  Quarters that omitted holdings under confidential treatment: ${confidential.length > 0
    ? confidential.map((row) => `${slug(row.investor_id)} ${quarter(row.report_period)}`).join(", ") : "none"}`);

  if (values.identities) {
    section("Stock identities (OpenFIGI, SEC and Nasdaq's directory of US listings, now)");
    const stocks = securities.flatMap((security) => {
      const ticker = currentTicker(security.id);
      const cusip = cusips.find((record) => record.securityId === security.id && record.validTo === null);
      return ticker && cusip ? [{ security, ticker, cusip: cusip.cusip }] : [];
    });
    console.log(`  Checking ${stocks.length} stocks (about ${Math.ceil(stocks.length / 10 * 2.5 / 60)} min)…`);
    const [figiResults, secFile, directory] = await Promise.all([openFigi(stocks.map((stock) => stock.cusip)), secTickers(), listings()]);
    const changes: string[] = [];
    stocks.forEach(({ security, ticker, cusip }, i) => {
      const figi = usListing(figiResults[i]);
      const sec = secListing(secFile, ticker.identifier_value);
      const label = `${ticker.identifier_value} ${cusip}`;
      if (!figi) changes.push(`${label}: CUSIP no longer listed (delisted, acquired or a new CUSIP)`);
      else if (figi.ticker !== ticker.identifier_value) changes.push(`${label}: OpenFIGI now maps the CUSIP to ${figi.ticker}`);
      if (!sec) changes.push(`${label}: ticker no longer in SEC's company ticker file`);
      else if (!sameCompany(sec.name, security.issuer_name)) changes.push(`${label}: SEC now lists the ticker as "${sec.name}"`);
      const listing = directory.get(ticker.identifier_value);
      if (!listing) changes.push(`${label}: no longer in Nasdaq's directory of US-listed securities`);
      else if (LISTING_MICS[listing.exchange] !== ticker.namespace) {
        changes.push(`${label}: now listed on ${LISTING_NAMES[listing.exchange] ?? listing.exchange}, recorded as ${ticker.namespace}`);
      } else if (listing.etf) changes.push(`${label}: Nasdaq's directory now lists it as an ETF`);
    });
    review += changes.length;
    console.log(`  Changed since added (${changes.length}):`);
    for (const change of changes) console.log(`    ${change}`);
  }

  console.log(`\n${review === 0 ? "Nothing to review." : `${review} item(s) to review.`}`);
}

main().catch((error: unknown) => {
  console.error(`Data check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
