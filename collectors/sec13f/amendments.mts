import { toUnits, type Filing13F, type Holding } from "./parse.mts";

type DatedFiling = Filing13F & { filedAt: string; valueMultiplier: number };

export type ReportedPortfolio<T extends DatedFiling> = {
  filings: T[]; // The filings whose rows make up the reported holdings, in filing order.
  rows: number;
  valueUnits: bigint; // Total in US dollars, scaled like toUnits().
  warnings: string[];
};

// Filing order, as in the portfolio_filings view: acceptance time, amendment number, accession number.
function byFilingOrder(a: DatedFiling, b: DatedFiling): number {
  return Date.parse(a.filedAt) - Date.parse(b.filedAt)
    || a.amendmentNumber - b.amendmentNumber
    || (a.accessionNumber < b.accessionNumber ? -1 : a.accessionNumber > b.accessionNumber ? 1 : 0);
}

// The same position reported twice: same security, position, quantity and managers.
function rowKey(holding: Holding): string {
  return [holding.cusip, holding.positionType, holding.quantityType, holding.quantity, holding.otherManagers.join(",")].join("|");
}

// Form 13F amendments either restate the whole report or add new holdings entries to it. The
// reported holdings are therefore the latest original or restatement plus the new-holdings
// amendments filed after it: the rule the portfolio_filings view applies. Warnings flag filer
// mistakes the rule cannot correct.
export function reportedPortfolio<T extends DatedFiling>(filings: T[]): ReportedPortfolio<T> {
  const warnings: string[] = [];
  let current: T[] = [];
  for (const filing of [...filings].sort(byFilingOrder)) {
    const reportedRows = current.flatMap((included) => included.holdings);
    if (filing.amendmentType !== "new_holdings") {
      if (filing.amendmentType === "restatement" && filing.holdings.length < reportedRows.length / 2) {
        warnings.push(`${filing.accessionNumber}: restatement reports ${filing.holdings.length} rows but replaces ${reportedRows.length}; check that it is complete`);
      }
      current = [filing];
    } else if (current.length > 0) {
      const reported = new Set(reportedRows.map(rowKey));
      const repeated = filing.holdings.filter((holding) => reported.has(rowKey(holding))).length;
      if (repeated > 0) {
        warnings.push(`${filing.accessionNumber}: new-holdings amendment repeats ${repeated} row(s) already reported; totals may double-count`);
      }
      current.push(filing);
    }
  }
  return {
    filings: current,
    rows: current.reduce((sum, filing) => sum + filing.holdings.length, 0),
    valueUnits: current.reduce((sum, filing) => sum + toUnits(filing.valueTotal) * BigInt(filing.valueMultiplier), BigInt(0)),
    warnings,
  };
}
