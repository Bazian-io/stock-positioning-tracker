// Records that an investor has also filed 13F reports under another SEC CIK, for example after a
// corporate reorganization, so filings made under either CIK belong to the same investor.
// Usage: npm run link:cik -- --cik 2012383 --add-cik 1364742 [--source <SEC document URL>] [--dry-run]
import { parseArgs } from "node:util";
import { cikHistory, createSecClient, normalizeCik, submissionsUrl, type CikHistory } from "./sec.mts";
import { connect, findInvestor, linkCik } from "./store.mts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return value;
}

function describe(history: CikHistory): string {
  const former = history.formerNames.map((name) => `${name.name} until ${name.until}`).join("; ");
  const periods = history.reportPeriods;
  const reports = periods.length > 0
    ? `13F-HR reports for ${periods.length} quarters, ${periods[0]} to ${periods[periods.length - 1]}`
    : "no 13F-HR reports";
  return `CIK ${history.cik} ${history.name}${former ? ` (formerly ${former})` : ""}: ${reports}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      cik: { type: "string" },
      "add-cik": { type: "string" },
      source: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.cik || !values["add-cik"]) {
    throw new Error("Usage: npm run link:cik -- --cik <investor's CIK> --add-cik <other CIK> [--source <url>] [--dry-run]");
  }
  const otherCik = normalizeCik(values["add-cik"]);
  const db = connect(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"));
  const investor = await findInvestor(db, normalizeCik(values.cik));
  if (!investor) throw new Error(`No investor has CIK ${values.cik}; import one of its quarters first`);
  const owner = await findInvestor(db, otherCik);
  if (owner && owner.id !== investor.id) throw new Error(`CIK ${otherCik} already belongs to ${owner.name}`);
  if (owner) {
    console.log(`CIK ${otherCik} is already linked to ${investor.name}`);
    return;
  }

  // SEC evidence: the entities' names over time and the quarters each CIK reported.
  const sec = createSecClient(requireEnv("SEC_USER_AGENT"));
  const known: CikHistory[] = [];
  for (const cik of investor.ciks.filter((cik) => cik !== otherCik)) known.push(await cikHistory(sec, cik));
  const other = await cikHistory(sec, otherCik);
  console.log(`${investor.name}`);
  for (const history of [...known, other]) console.log(`  ${history === other ? "Adding" : "Linked"} ${describe(history)}`);

  if (other.reportPeriods.length === 0) throw new Error(`CIK ${otherCik} has filed no 13F-HR reports`);
  // One investor cannot have two original reports for a quarter.
  const shared = other.reportPeriods.filter((period) => known.some((history) => history.reportPeriods.includes(period)));
  if (shared.length > 0) {
    const examples = shared.slice(0, 3).join(", ") + (shared.length > 3 ? ", …" : "");
    throw new Error(`These CIKs both filed 13F-HR reports for ${shared.length} quarter(s) (${examples}); not linking`);
  }
  if (values["dry-run"]) {
    console.log(`Dry run: CIK ${otherCik} would be linked to ${investor.name} (database not changed)`);
    return;
  }
  const result = await linkCik(db, investor.id, otherCik, other.name, values.source ?? submissionsUrl(otherCik));
  console.log(result === "linked" ? `Linked CIK ${otherCik} to ${investor.name}` : `CIK ${otherCik} was already linked to ${investor.name}`);
}

main().catch((error: unknown) => {
  console.error(`Linking failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
