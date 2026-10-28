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
npm run collect:13f -- --dry-run      # download and check only; no database changes
npm run collect:13f                   # import Berkshire Hathaway's latest 13F-HR
npm run collect:13f -- --cik 1067983  # choose the manager by CIK
npm run test:collectors               # offline tests with a synthetic filing
```

Each run:

1. Finds the newest original 13F-HR in the manager's SEC submissions index and downloads the
   full submission text, recording its URL and SHA-256 checksum.
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

Not yet handled: amendments (13F-HR/A), notices (13F-NT), mapping rows to `securities`
(rows keep their reported CUSIPs with `security_id` empty), historical backfill and scheduling.
