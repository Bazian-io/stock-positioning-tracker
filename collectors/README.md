# Collectors

Server-side scripts that load public data into the research database described in
[supabase/README.md](../supabase/README.md). They run with Node's built-in TypeScript
support; nothing here is bundled into the web app.

## Setup

Copy `.env.example` to `.env.local` (ignored by git) and fill in:

- `SEC_USER_AGENT`: your name or project plus a contact email. SEC requires it on every request.
- `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: the project URL and a secret key
  (Dashboard → Project Settings → API Keys). The secret key bypasses row-level security:
  keep it server-side, never give it a `NEXT_PUBLIC_` prefix, and rotate it if it leaks.

## SEC 13F pilot

```sh
npm run collect:13f -- --dry-run             # download and check only; no database changes
npm run collect:13f                          # import Berkshire Hathaway's latest 13F-HR
npm run collect:13f -- --quarter 2026-03-31  # a specific quarter (or 2026Q1); repeat for several
npm run collect:13f -- --cik 1067983         # choose the manager by CIK
npm run test:collectors                      # offline tests with a synthetic filing
```

Each run, per quarter:

1. Finds the manager's original 13F-HR for the quarter (default: the newest) in SEC's submissions
   index, reading older index pages only when needed, and downloads the full submission text,
   recording its URL and SHA-256 checksum.
2. Parses the cover page, summary page and information table. The filing is rejected unless the
   table's row count and value total match its own summary page.
3. Logs a `collection_runs` row, adds the filing as `pending` with every source row, then marks it
   `complete`. The database re-checks counts, row numbering and totals before accepting.
4. Reads every stored row back and compares it field by field with the SEC data.

Running again is safe. A completed filing (matched by accession number) is never imported twice;
the run re-verifies it and records `records_processed = 0`. Rows left by an interrupted run are
removed and imported again. Run one collector process at a time.

SEC access: requests send `SEC_USER_AGENT`, are spaced at least 200 ms apart (SEC allows 10 per
second), retry rate-limit and server errors with backoff, and stop on HTTP 403.

Historical quarters: filings made before 2023-01-03 report values in thousands; they are stored as
reported with `value_multiplier = 1000`. Older text-format filings, from before 13F reports were
filed as XML, are not supported.

Not yet handled: amendments (13F-HR/A), notices (13F-NT), mapping rows to `securities`
(rows keep their reported CUSIPs with `security_id` empty) and scheduling. When SEC lists
amendments for a quarter (Berkshire amended 2025-03-31, for example), the run prints their
accession numbers; until amendments are imported, such a quarter shows the original report only.
