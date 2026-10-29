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

## Stocks

Stock pages find a stock's holdings by its CUSIP. Add a stock (one share class) with its CUSIP and
ticker, or every stock an investor reported:

```sh
npm run add:security -- --cusip 037833100 --ticker AAPL --dry-run   # show the evidence only
npm run add:security -- --cusip 037833100 --ticker AAPL
npm run add:security -- --cusip 02079K305 --ticker GOOGL --share-class "Class A"
npm run add:security -- --investor berkshire-hathaway --dry-run    # every stock it reported, any quarter
npm run add:security -- --investor blackrock --top 500             # its 500 largest positions
```

For each CUSIP the command checks its check digit; that OpenFIGI maps it to a listed US stock
(common stock, ADR, REIT and the like; not ETFs, funds or preferred shares) with that ticker; that
SEC's company ticker file lists the ticker on Nasdaq or NYSE (with `--investor`, also under a
company name that matches OpenFIGI's); and that our filings report the CUSIP. It then adds a
`securities` row and two `security_identifiers`: the CUSIP, valid from the earliest quarter our
filings report it (that filing is the evidence), and the ticker on its exchange's MIC, valid from
the day SEC's file was read. Each share class has its own CUSIP and ticker, so classes stay
separate; with `--investor` the class comes from OpenFIGI's name ("ALPHABET INC-CL A"). Holdings
themselves are not changed. A CUSIP or ticker that is already recorded is left as it is.

`--investor` takes the investor's long share positions (not options or bonds), largest first by the
largest value reported in any quarter; `--top` keeps that many. It looks up OpenFIGI without an API
key (10 CUSIPs a request, 25 requests a minute, so about 3 minutes for 500), prints the stocks to add
and the ones skipped with the reason, and adds them unless `--dry-run` is given. Running it again
skips what is already recorded. Skipped CUSIPs need a person:

- No current US listing: the company was delisted, taken private or acquired, or changed its CUSIP
  (Exxon Mobil's reorganization into ExxonMobil Holdings gave it a new one). OpenFIGI maps only
  listed securities, so an old CUSIP is never matched to a ticker that now belongs to its successor.
- A ticker that is already recorded, or that two CUSIPs map to: decide which CUSIP it belongs to.
- Names that do not match (OpenFIGI "P G & E CORP", SEC "PG&E Corp"): add it with `--cusip` and
  `--ticker` after checking.

### Mistyped CUSIPs, earlier CUSIPs and start dates

```sh
npm run add:security -- --alias G6693N103 --ticker NU --dry-run   # a CUSIP a filer mistyped
npm run add:security -- --predecessor 531229748 --ticker LLYVA --until 2025-12-15 \
  --source <official record of the conversion> --dry-run          # an earlier CUSIP, converted one-for-one
npm run add:security -- --conversion 82968B103 --ticker SIRI --ratio 0.1 --date 2024-09-09 \
  --description "Sirius XM's merger with Liberty Sirius XM Holdings" \
  --source <official record of the ratio> --dry-run               # shares received at another ratio
npm run add:security -- --extend-windows --dry-run                # after importing older quarters
```

Filers sometimes mistype a CUSIP: Berkshire filed Nu Holdings (G6683N103) as G6693N103 for four
quarters, so Nu's page showed those quarters as "reported, not held". `--alias` records the mistyped
CUSIP as an extra CUSIP of the stock, only for the quarters filings used it (that first filing is the
evidence). It refuses a CUSIP that OpenFIGI knows as a security, listed or delisted, so a real
security, such as another share class or a predecessor company, is never merged into a stock, and
every name filers used for it must match the stock.

A corporate action can replace a stock's CUSIP: Liberty Media's Liberty Live tracking stock was
redeemed one-for-one for Liberty Live Holdings shares on 15 December 2025, so LLYVA's page started at
Q4 2025 with a "new position". `--predecessor` records the earlier CUSIP as a CUSIP of the stock from
the earliest quarter our filings report it until the conversion date (`--until`), with the official
record (`--source`, a company release or SEC filing) as evidence. It refuses a CUSIP that is still
listed or unknown to OpenFIGI, one whose dates would overlap the stock's other CUSIPs, names that do
not match, and any conversion where no investor's share count carried over unchanged: share counts
from a conversion at another ratio (Sirius XM's 2024 merger gave 0.8375 or 0.1 new shares) are not
comparable, so those are not linked.

Instead, `--conversion` records the ratio in `security_conversions`: holders of the converted CUSIP
received that many shares of the stock per share on that date (Sirius XM's merger gave 0.1 new SIRI
share per Sirius XM share and 0.8375 per Liberty SiriusXM share; record each converted CUSIP). In the
quarter of the conversion, the stock's page then shows the investor's shares as "Received in corporate
action", estimated from its holdings reported for the quarter before, with any difference shown as
buying or selling, instead of as a new position. The converted CUSIP must be real (known to OpenFIGI)
and reported by our filings for the quarter before, the stock must have a CUSIP for the quarter of
the conversion, and the source must be an official record stating the ratio. Holdings are not
changed or adjusted.

A CUSIP identifies a stock from the earliest quarter our filings reported it when the stock was
added. After older quarters are imported, `--extend-windows` moves each start date back to the
earliest quarter now reported, with that filing as evidence, when the filers' names match the stock.
Until then, stock pages show those quarters as "unclear" rather than as a zero.

## Checking the data

```sh
npm run check:data                    # read-only; uses the publishable key, which cannot write
npm run check:data -- --identities    # also re-checks every stock with OpenFIGI and SEC (about 2 minutes)
```

Lists what a person should review:

- **Freshness:** each investor's latest quarter against the latest quarter whose 13F reports are due
  (45 days after quarter end: 14 Feb, 15 May, 14 Aug and 14 Nov, or the next business day).
- **Stock links:** likely earlier CUSIPs (a holding that ends as an investor's holding of a stock
  starts with the same share count), mistyped CUSIPs, other CUSIPs under a stock's name (for example
  a predecessor converted at another ratio, which needs a person), holdings outside their CUSIP's
  recorded dates, and how much of each investor's latest value links to stock pages.
- **Values:** likely stock splits (labelled on stock pages), value per share that differs between
  investors for the same CUSIP and quarter or jumps more than fourfold between quarters (signs of a
  mistyped value or a value in thousands), invalid CUSIP check digits and confidential omissions.
- **Identities** (`--identities`): stocks whose CUSIP is no longer listed or now maps to another
  ticker, or whose ticker SEC no longer lists or lists elsewhere.

### After each import

1. Back up first: `npm run backup:db` ([supabase/README.md](../supabase/README.md#backups)).
2. Import, for example the new quarter after each filing deadline, and re-run the previous two or
   three quarters to pick up late amendments.
3. Run `npm run check:data` and resolve what it lists: `--extend-windows`, `--alias`,
   `--predecessor` and `--conversion` for stock links, and the SEC filing itself for value questions.
4. Each quarter, run `npm run check:data -- --identities` for ticker and CUSIP changes.

### Other notes

SEC access: requests send `SEC_USER_AGENT`, are spaced at least 200 ms apart (SEC allows 10 per
second), retry rate-limit and server errors with backoff, and stop on HTTP 403.

Historical quarters: filings made before 2023-01-03 report values in thousands; they are stored as
reported with `value_multiplier = 1000`. Older text-format filings, from before 13F reports were
filed as XML, are not supported.

Not yet handled: notices (13F-NT and 13F-NT/A), amendments for a quarter with no original 13F-HR,
mapping rows to `securities` (rows keep their reported CUSIPs with `security_id` empty), and
scheduling.
