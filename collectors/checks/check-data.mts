// Read-only check of the research data, to run after each import or change. It uses the publishable
// key, which cannot write, and lists what a person should review: missing quarters, possibly mistyped
// CUSIPs, holdings outside their CUSIP's recorded dates, values that disagree, likely stock splits, recorded
// conversions and, with --identities, stocks whose ticker or CUSIP has changed since they were added.
// Usage: npm run check:data [-- --identities]
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { lastQuarterBefore, nextQuarter, previousQuarter } from "../../src/lib/stock.ts";
import { EXCHANGE_MICS, isValidCusip, sameCompany, secListing, usListing } from "../securities/identify.mts";
import { loadAll, openFigi, requireEnv, secTickers, today } from "../securities/sources.mts";
import {
  consecutivePairs, latestDueQuarter, likelyPredecessors, outsideWindows, priceDisagreements, priceJumps, stockOf, suspectedTypos,
  type CusipRecord, type Position,
} from "./findings.mts";

const usd = (value: number) => `$${(value / 1e9).toFixed(2)}B`;
const quarter = (period: string) => `Q${Number(period.slice(5, 7)) / 3} ${period.slice(0, 4)}`;

async function main() {
  const { values } = parseArgs({ options: { identities: { type: "boolean", default: false } } });
  const key = requireEnv("SUPABASE_PUBLISHABLE_KEY");
  if (key.startsWith("sb_secret_")) throw new Error("SUPABASE_PUBLISHABLE_KEY holds a secret key; this check reads with the publishable key only");
  const db = createClient(requireEnv("SUPABASE_URL"), key, { auth: { persistSession: false, autoRefreshToken: false } });

  const [investors, quarters, positionRows, identifiers, securities, conversions] = await Promise.all([
    loadAll<{ id: string; slug: string }>((from, to) => db.from("investors").select("id, slug").order("slug").range(from, to), "Read investors"),
    loadAll<{ investor_id: string; report_period: string; has_confidential_omissions: boolean }>((from, to) => db.from("quarterly_portfolios")
      .select("investor_id, report_period, has_confidential_omissions").order("investor_id").order("report_period").range(from, to), "Read quarters"),
    loadAll<{
      investor_id: string; report_period: string; reported_cusip: string | null; reported_issuer: string; position_type: string;
      quantity_type: string; quantity: string; value_usd: string;
    }>((from, to) => db.from("portfolio_positions")
      .select("investor_id, report_period, reported_cusip, reported_issuer, position_type, quantity_type, quantity::text, value_usd::text")
      .order("investor_id").order("report_period").order("reported_cusip").order("reported_issuer").order("position_type").order("quantity_type")
      .range(from, to), "Read positions"),
    loadAll<{ security_id: string; identifier_type: string; identifier_value: string; namespace: string; valid_from: string; valid_to: string | null }>(
      (from, to) => db.from("security_identifiers").select("security_id, identifier_type, identifier_value, namespace, valid_from, valid_to")
        .in("identifier_type", ["cusip", "ticker"]).order("id").range(from, to), "Read identifiers"),
    loadAll<{ id: string; issuer_name: string }>((from, to) => db.from("securities").select("id, issuer_name").order("id").range(from, to), "Read securities"),
    loadAll<{ security_id: string; from_cusip: string; shares_per_share: string; effective_date: string; description: string }>((from, to) => db
      .from("security_conversions").select("security_id, from_cusip, shares_per_share::text, effective_date, description")
      .order("effective_date").order("security_id").order("from_cusip").range(from, to), "Read conversions"),
  ]);
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
  const predecessors = likelyPredecessors(positions, cusips, reported, nextQuarter);
  review += predecessors.length;
  console.log(`  Likely earlier CUSIPs, replaced one-for-one (share count carried over), shown as "reported, not held" until linked (${predecessors.length}):`);
  for (const match of predecessors) {
    console.log(`    ${tickerOf(match.securityId)}: ${match.cusip} "${match.issuer}", ${slug(match.investorId)} held ${match.shares.toLocaleString("en-US")} `
      + `shares in ${quarter(match.lastPeriod)} and the same number of ${tickerOf(match.securityId)} in ${quarter(nextQuarter(match.lastPeriod))}`);
    console.log(`      check an official record, then: npm run add:security -- --predecessor ${match.cusip} --ticker ${tickerOf(match.securityId)} `
      + "--until <conversion date> --source <record URL> --dry-run");
  }
  const linkedLater = new Set(predecessors.map((match) => `${match.cusip}|${match.securityId}`));
  // A CUSIP with a recorded conversion is explained: its holders' shares show as received on the stock's page.
  const converted = new Set(conversions.map((row) => row.from_cusip));
  const nameMatches = suspectedTypos(positions, cusips, isValidCusip)
    .filter((match) => !linkedLater.has(`${match.cusip}|${match.securityId}`) && !converted.has(match.cusip));
  const listMatches = (kind: string, title: string, hint: ((cusip: string, ticker: string) => string) | null) => {
    const matches = nameMatches.filter((match) => match.kind === kind);
    console.log(`  ${title} (${matches.length}):`);
    for (const match of matches) {
      console.log(`    ${tickerOf(match.securityId)}: ${match.cusip} "${match.issuer}", ${match.reportPeriods.map(quarter).join(", ")}`);
      if (hint) console.log(`      ${hint(match.cusip, tickerOf(match.securityId))}`);
    }
    return matches.length;
  };
  review += listMatches("typo", "Mistyped CUSIPs (invalid check digit), shown as \"reported, not held\" until recorded",
    (cusip, ticker) => `check: npm run add:security -- --alias ${cusip} --ticker ${ticker} --dry-run`);
  review += listMatches("same-name", "Other CUSIPs under the stock's name: a predecessor before a reorganization, or a typo that passes the check digit",
    (cusip, ticker) => `a typo: --alias ${cusip} --ticker ${ticker}; converted one-for-one: --predecessor ${cusip} --ticker ${ticker}; `
      + "converted at another ratio: stays unlinked");
  listMatches("other-class", "Other CUSIPs of the same issuer: other classes or tracking stocks, or earlier CUSIPs converted at another ratio, for information", null);
  const outside = outsideWindows(positions, cusips);
  review += outside.length;
  console.log(`  Holdings under a recorded CUSIP outside its recorded dates (${outside.length}): shown as "unclear"`);
  for (const position of outside.slice(0, 20)) console.log(`    ${slug(position.investorId)} ${quarter(position.reportPeriod)} ${position.cusip} ${position.issuer}`);
  if (outside.length > 0) console.log("      check: npm run add:security -- --extend-windows --dry-run");
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
  const jumps = priceJumps(pairs);
  review += jumps.length;
  console.log(`  Value per share moving more than fourfold in a quarter, without a split pattern (${jumps.length}):`);
  for (const { current, priceRatio } of jumps) {
    console.log(`    ${slug(current.investorId)} ${current.issuer} ${quarter(current.reportPeriod)}: ×${priceRatio.toFixed(2)}`);
  }
  const disagreements = priceDisagreements(positions);
  review += disagreements.length;
  console.log(`  Value per share differing between investors by more than 2% (${disagreements.length}):`);
  for (const group of disagreements) {
    console.log(`    ${group[0].cusip} ${quarter(group[0].reportPeriod)}: ${group.map((position) =>
      `${slug(position.investorId)} $${(position.valueUsd / position.shares).toFixed(2)}`).join(", ")}`);
  }
  const invalid = positions.filter((position) => position.positionType === "long" && position.cusip && !isValidCusip(position.cusip));
  console.log(`  Long positions with an invalid CUSIP check digit: ${invalid.length} (${usd(invalid.reduce((sum, position) => sum + position.valueUsd, 0))})`);
  const confidential = quarters.filter((row) => row.has_confidential_omissions);
  console.log(`  Quarters that omitted holdings under confidential treatment: ${confidential.length > 0
    ? confidential.map((row) => `${slug(row.investor_id)} ${quarter(row.report_period)}`).join(", ") : "none"}`);

  if (values.identities) {
    section("Stock identities (OpenFIGI and SEC, now)");
    const stocks = securities.flatMap((security) => {
      const ticker = currentTicker(security.id);
      const cusip = cusips.find((record) => record.securityId === security.id && record.validTo === null);
      return ticker && cusip ? [{ security, ticker, cusip: cusip.cusip }] : [];
    });
    console.log(`  Checking ${stocks.length} stocks (about ${Math.ceil(stocks.length / 10 * 2.5 / 60)} min)…`);
    const [figiResults, secFile] = await Promise.all([openFigi(stocks.map((stock) => stock.cusip)), secTickers()]);
    const changes: string[] = [];
    stocks.forEach(({ security, ticker, cusip }, i) => {
      const figi = usListing(figiResults[i]);
      const sec = secListing(secFile, ticker.identifier_value);
      const label = `${ticker.identifier_value} ${cusip}`;
      if (!figi) changes.push(`${label}: CUSIP no longer listed (delisted, acquired or a new CUSIP)`);
      else if (figi.ticker !== ticker.identifier_value) changes.push(`${label}: OpenFIGI now maps the CUSIP to ${figi.ticker}`);
      if (!sec) changes.push(`${label}: ticker no longer in SEC's company ticker file`);
      else if (EXCHANGE_MICS[sec.exchange] !== ticker.namespace) changes.push(`${label}: SEC now lists it on ${sec.exchange}`);
      else if (!sameCompany(sec.name, security.issuer_name)) changes.push(`${label}: SEC now lists the ticker as "${sec.name}"`);
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
