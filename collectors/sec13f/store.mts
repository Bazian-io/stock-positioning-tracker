import { isDeepStrictEqual } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { toUnits, type Filing13F, type Holding } from "./parse.mts";

// A parsed filing plus its SEC index metadata and download provenance.
export type SourceFiling = Filing13F & {
  filedAt: string;
  valueMultiplier: 1 | 1000;
  sourceUrl: string;
  sourceChecksum: string;
};

export type ImportResult = {
  action: "imported" | "already_imported";
  filingId: string;
  rowsInserted: number;
  rowsVerified: number;
};

type Row = Record<string, unknown>;
type StoredFiling = { filing: Row; holdings: Row[] };

const INSERT_BATCH_SIZE = 500;
const PAGE_SIZE = 1000; // Supabase's default maximum rows per API response.
const AMOUNT_COLUMNS = new Set(["quantity", "reported_value", "voting_sole", "voting_shared", "voting_none"]);
// Amounts are read as text so large values keep full precision.
const HOLDING_COLUMNS =
  "source_row, reported_cusip, reported_issuer, reported_class, quantity::text, quantity_type, position_type, reported_value::text, investment_discretion, voting_sole::text, voting_shared::text, voting_none::text, other_manager_numbers, raw_row";

export function connect(url: string, secretKey: string): SupabaseClient {
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// supabase-js reports failures in the result instead of throwing.
async function must<T>(request: PromiseLike<{ data: T | null; error: { message: string } | null }>, action: string) {
  const { data, error } = await request;
  if (error) throw new Error(`${action}: ${error.message}`);
  return data as T;
}

export function holdingRow(filingId: string, holding: Holding) {
  return {
    filing_id: filingId,
    source_row: holding.sourceRow,
    reported_cusip: holding.cusip,
    reported_issuer: holding.issuer,
    reported_class: holding.titleOfClass,
    quantity: holding.quantity,
    quantity_type: holding.quantityType,
    position_type: holding.positionType,
    reported_value: holding.value,
    investment_discretion: holding.investmentDiscretion,
    voting_sole: holding.votingSole,
    voting_shared: holding.votingShared,
    voting_none: holding.votingNone,
    other_manager_numbers: holding.otherManagers,
    raw_row: holding.raw,
  };
}

function sameAmount(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && toUnits(a) === toUnits(b);
}

// Compares what the database holds with the SEC filing, field by field.
export function compareStored(source: SourceFiling, stored: StoredFiling): string[] {
  const problems: string[] = [];
  const expectedFiling: Row = {
    import_status: "complete",
    report_period: source.reportPeriod,
    reported_entry_count: source.entryTotal,
    value_multiplier: source.valueMultiplier,
    source_checksum: source.sourceChecksum,
  };
  for (const [column, expected] of Object.entries(expectedFiling)) {
    if (stored.filing[column] !== expected) {
      problems.push(`Filing ${column}: SEC ${JSON.stringify(expected)}, database ${JSON.stringify(stored.filing[column])}`);
    }
  }
  if (!sameAmount(stored.filing.reported_total_value, source.valueTotal)) {
    problems.push(`Filing total value: SEC ${source.valueTotal}, database ${stored.filing.reported_total_value}`);
  }
  if (stored.holdings.length !== source.holdings.length) {
    problems.push(`SEC filing has ${source.holdings.length} rows; database has ${stored.holdings.length}`);
  }
  source.holdings.forEach((holding, index) => {
    const actual = stored.holdings[index] ?? {};
    for (const [column, expected] of Object.entries(holdingRow("", holding))) {
      if (column === "filing_id") continue;
      const same = AMOUNT_COLUMNS.has(column) ? sameAmount(expected, actual[column]) : isDeepStrictEqual(expected, actual[column]);
      if (!same) {
        problems.push(`Row ${holding.sourceRow} ${column}: SEC ${JSON.stringify(expected)}, database ${JSON.stringify(actual[column])}`);
      }
    }
  });
  const storedTotal = stored.holdings.reduce(
    (sum, row) => sum + (typeof row.reported_value === "string" ? toUnits(row.reported_value) : BigInt(0)),
    BigInt(0),
  );
  if (storedTotal !== toUnits(source.valueTotal)) {
    problems.push(`Stored rows sum to ${storedTotal / BigInt(10_000)}; SEC summary reports ${source.valueTotal}`);
  }
  return problems;
}

async function readStored(db: SupabaseClient, filingId: string): Promise<StoredFiling> {
  const filing = await must<Row>(
    db.from("filings")
      .select("import_status, report_period, reported_entry_count, reported_total_value::text, value_multiplier, source_checksum")
      .eq("id", filingId)
      .single(),
    "Read stored filing",
  );
  const holdings: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await must<Row[]>(
      db.from("holdings").select(HOLDING_COLUMNS).eq("filing_id", filingId).order("source_row").range(from, from + PAGE_SIZE - 1),
      "Read stored holdings",
    );
    holdings.push(...page);
    if (page.length < PAGE_SIZE) return { filing, holdings };
  }
}

async function ensureInvestor(db: SupabaseClient, source: SourceFiling): Promise<string> {
  const existing = await must<{ id: string } | null>(
    db.from("investors").select("id").eq("cik", source.cik).maybeSingle(),
    "Look up investor",
  );
  if (existing) return existing.id;
  const created = await must<{ id: string }>(
    db.from("investors").insert({ name: source.managerName, cik: source.cik }).select("id").single(),
    "Add investor",
  );
  return created.id;
}

// Follows the import protocol in supabase/README.md: pending filing, all source rows, then a
// checked transition to complete. Safe to re-run: a completed filing is verified, never re-imported.
export async function importFiling(db: SupabaseClient, source: SourceFiling): Promise<ImportResult> {
  const run = await must<{ id: string }>(
    db.from("collection_runs")
      .insert({
        collector: "sec13f",
        provider: "sec",
        started_at: new Date().toISOString(),
        checkpoint: { accession_number: source.accessionNumber },
      })
      .select("id")
      .single(),
    "Start collection run",
  );
  const finishRun = (fields: Row) =>
    must(
      db.from("collection_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run.id),
      "Finish collection run",
    );

  let pendingFilingId: string | null = null;
  try {
    const existing = await must<{ id: string; import_status: string } | null>(
      db.from("filings").select("id, import_status").eq("accession_number", source.accessionNumber).maybeSingle(),
      "Look up filing",
    );
    let filingId: string;
    let action: ImportResult["action"] = "already_imported";
    let rowsInserted = 0;

    if (existing?.import_status === "complete") {
      filingId = existing.id;
    } else {
      if (existing) {
        // Left behind by an interrupted or failed run; incomplete data is never public.
        await must(db.from("holdings").delete().eq("filing_id", existing.id), "Remove incomplete holdings");
        await must(db.from("filings").delete().eq("id", existing.id).neq("import_status", "complete"), "Remove incomplete filing");
      }
      const investorId = await ensureInvestor(db, source);
      const filing = await must<{ id: string }>(
        db.from("filings")
          .insert({
            investor_id: investorId,
            collection_run_id: run.id,
            accession_number: source.accessionNumber,
            report_period: source.reportPeriod,
            filed_at: source.filedAt,
            form_type: source.formType,
            report_type: source.reportType,
            reported_entry_count: source.entryTotal,
            reported_total_value: source.valueTotal,
            value_multiplier: source.valueMultiplier,
            has_confidential_omissions: source.confidentialOmitted,
            other_managers: source.otherManagers.map((manager) => ({
              relation: manager.relation,
              sequence_number: manager.sequenceNumber,
              cik: manager.cik,
              file_number: manager.fileNumber,
              name: manager.name,
            })),
            source_url: source.sourceUrl,
            source_checksum: source.sourceChecksum,
          })
          .select("id")
          .single(),
        "Add pending filing",
      );
      pendingFilingId = filingId = filing.id;
      for (let start = 0; start < source.holdings.length; start += INSERT_BATCH_SIZE) {
        const batch = source.holdings.slice(start, start + INSERT_BATCH_SIZE).map((holding) => holdingRow(filingId, holding));
        await must(db.from("holdings").insert(batch), "Add holdings");
      }
      // The database trigger re-checks row count, row numbering and value total before accepting.
      await must(db.from("filings").update({ import_status: "complete" }).eq("id", filingId), "Complete filing");
      pendingFilingId = null;
      action = "imported";
      rowsInserted = source.holdings.length;
    }

    const problems = compareStored(source, await readStored(db, filingId));
    if (problems.length > 0) {
      throw new Error(`Stored data does not match the SEC filing:\n- ${problems.slice(0, 10).join("\n- ")}`);
    }
    await finishRun({
      status: "succeeded",
      records_processed: rowsInserted,
      checkpoint: { accession_number: source.accessionNumber, action, rows_verified: source.holdings.length },
    });
    return { action, filingId, rowsInserted, rowsVerified: source.holdings.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Best effort: keep the original error even if recording the failure also fails.
    if (pendingFilingId) {
      await must(db.from("filings").update({ import_status: "failed" }).eq("id", pendingFilingId), "Mark filing failed")
        .catch(() => undefined);
    }
    await finishRun({ status: "failed", error_message: message.slice(0, 1000) }).catch(() => undefined);
    throw error;
  }
}
