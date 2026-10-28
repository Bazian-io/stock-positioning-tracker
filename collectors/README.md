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

## SEC 13F

```sh
npm run collect:13f -- --dry-run             # download and check only; no database changes
npm run collect:13f                          # import Berkshire Hathaway's latest quarter
npm run collect:13f -- --quarter 2026-03-31  # a specific quarter (or 2026Q1); repeat for several
npm run collect:13f -- --from 2021Q3 --to 2026Q2  # every quarter in a range, oldest first
npm run collect:13f -- --cik 1067983         # choose the manager by CIK (any of its linked CIKs)
npm run link:cik -- --cik 2012383 --add-cik 1364742  # record another CIK the manager filed under
npm run test:collectors                      # offline tests: synthetic filings, disposable database
```

Each run, per quarter:

1. Finds the manager's original 13F-HR for the quarter (default: the newest) and every 13F-HR/A
   amendment SEC lists for the same quarter, under every CIK linked to the manager, reading older
   index pages only when needed. Downloads each full submission, recording its URL and SHA-256
   checksum.
2. Parses each cover page, summary page and information table, including the amendment type and
   number. A filing is rejected unless its table's row count and value total match its own
   summary page.
3. Logs one `collection_runs` row for the quarter, then imports the original followed by each
   amendment, linked to the original. Each filing is added as `pending` with every source row and
   then marked `complete`; the database re-checks counts, row numbering and totals before accepting.
4. Reads every stored row back, compares it field by field with the SEC data and rebuilds the exact
   SEC row from it (`raw_row` keeps only fields the columns cannot reproduce), then checks that the
   research views (`portfolio_filings`, `quarterly_portfolios`) show exactly the reported holdings.

Running again is safe. A completed filing (matched by accession number) is never imported twice;
the run re-verifies it, so re-running a quarter adds only amendments filed since. Rows left by an
interrupted run are removed and imported again. Run one collector process at a time.

### Amendments

A 13F-HR/A either restates the whole report (`restatement`) or adds holdings to it
(`new_holdings`), such as positions first withheld under confidential treatment. A quarter's
reported holdings are the latest original or restatement plus the new-holdings amendments filed
after it. Every filing stays stored as history; the portfolio views apply this rule, and the
collector checks that they agree with the SEC filings.

Amendments can arrive months after the original (Berkshire's 2025-03-31 amendment came three
months later), so re-run recent quarters to pick them up. The collector warns when a filer's
amendment looks mislabeled: a new-holdings amendment that repeats rows already reported (totals
would double-count) or a restatement with fewer than half the rows it replaces. Warnings are
printed and kept in the run's `checkpoint`; the import still follows the type the filer declared.

### Investors with several CIKs

An institution can file under a new SEC CIK after a corporate reorganization. BlackRock filed as
BlackRock Inc. (CIK 1364742) through Q2 2024; since its October 2024 holding-company
reorganization, the successor issuer BlackRock, Inc. (CIK 2012383) files from Q3 2024. The
`investor_ciks` table records every CIK an investor has filed under, so all of its filings share
one investor and one quarterly history. Link a CIK before importing quarters filed under it:

```sh
npm run link:cik -- --cik 2012383 --add-cik 1364742 --dry-run   # show the SEC evidence only
npm run link:cik -- --cik 2012383 --add-cik 1364742 --source <URL of the SEC document proving the link>
```

The command prints both entities' SEC names over time and the quarters each reported. It refuses a
CIK that already belongs to another investor or that reported a quarter one of the investor's CIKs
also reported. The collector then searches all linked CIKs for each quarter, accepts amendments
filed under any of them, and stops if two CIKs filed an original report for the same quarter.

### Other notes

SEC access: requests send `SEC_USER_AGENT`, are spaced at least 200 ms apart (SEC allows 10 per
second), retry rate-limit and server errors with backoff, and stop on HTTP 403.

Historical quarters: filings made before 2023-01-03 report values in thousands; they are stored as
reported with `value_multiplier = 1000`. Older text-format filings, from before 13F reports were
filed as XML, are not supported.

Not yet handled: notices (13F-NT and 13F-NT/A), amendments for a quarter with no original 13F-HR,
mapping rows to `securities` (rows keep their reported CUSIPs with `security_id` empty) and
scheduling.
