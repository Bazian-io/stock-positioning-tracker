// Slice only after the complete financial result has been classified, filtered and ordered.
export function pageSlice<T>(rows: T[], requestedPage: number, pageSize = 25) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(1, Math.min(Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1, pageCount));
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, page, pageCount, start };
}
