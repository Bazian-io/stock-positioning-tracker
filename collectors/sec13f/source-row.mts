import { isDeepStrictEqual } from "node:util";

// A holding stores each information-table row as typed columns. raw_row keeps only what those
// columns cannot reproduce exactly: fields the parser does not read (such as figi) and values in a
// non-standard format (such as "1, 2" for otherManager). The columns' fields plus raw_row rebuild
// the SEC row exactly, so raw_row is usually empty. Migration 20261028210000 applies the same rule
// in SQL to holdings stored before it.

export type HoldingColumns = {
  issuer: string;
  titleOfClass: string | null;
  cusip: string | null;
  value: string;
  quantity: string;
  quantityType: string;
  positionType: string;
  investmentDiscretion: string | null;
  otherManagers: string[];
  votingSole: string | null;
  votingShared: string | null;
  votingNone: string | null;
};

type Fields = Record<string, unknown>;

const PUT_CALL: Record<string, string> = { put: "Put", call: "Call" };

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

// A decimal as PostgreSQL prints it after trim_scale(): "0050.10" and "50.1000" become "50.1".
function plainDecimal(decimal: string): string {
  const [whole, fraction = ""] = decimal.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${digits}.${decimals}` : digits;
}

// Drops null fields at every level, like PostgreSQL's jsonb_strip_nulls().
function withoutNulls(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => [key, isObject(value) ? withoutNulls(value) : value]));
}

// The information-table fields the columns hold, in the SEC's XML format.
export function columnFields(row: HoldingColumns): Fields {
  const integer = (value: string | null) => (value === null ? null : plainDecimal(value));
  return withoutNulls({
    nameOfIssuer: row.issuer,
    titleOfClass: row.titleOfClass,
    cusip: row.cusip,
    value: plainDecimal(row.value),
    shrsOrPrnAmt: { sshPrnamt: plainDecimal(row.quantity), sshPrnamtType: row.quantityType },
    putCall: PUT_CALL[row.positionType],
    investmentDiscretion: row.investmentDiscretion,
    otherManager: row.otherManagers.join(",") || null,
    votingAuthority: { Sole: integer(row.votingSole), Shared: integer(row.votingShared), None: integer(row.votingNone) },
  });
}

// The parts of source that reproduced lacks or differs from, comparing nested objects field by field.
function difference(source: Fields, reproduced: Fields): Fields {
  const result: Fields = {};
  for (const [key, value] of Object.entries(source)) {
    const expected = reproduced[key];
    if (isDeepStrictEqual(value, expected)) continue;
    if (isObject(value) && isObject(expected)) {
      const nested = difference(value, expected);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function merge(base: Fields, extra: Fields): Fields {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = result[key];
    result[key] = isObject(value) && isObject(current) ? merge(current, value) : value;
  }
  return result;
}

// The SEC row, rebuilt from a holding's columns and its stored raw_row.
export function sourceRow(columns: HoldingColumns, rawRow: Fields): Fields {
  return merge(columnFields(columns), rawRow);
}

// What raw_row stores for a parsed holding. Refuses a row the result could not rebuild exactly.
export function unreportedFields(holding: HoldingColumns & { raw: Fields }): Fields {
  const extra = difference(holding.raw, columnFields(holding));
  if (!isDeepStrictEqual(sourceRow(holding, extra), holding.raw)) {
    throw new Error(`Holding ${holding.issuer} (${holding.cusip}) cannot be stored without losing source fields`);
  }
  return extra;
}
