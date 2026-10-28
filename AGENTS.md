<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

This is an existing project with real data in production. The block above is managed by
`next dev`; keep project rules outside it.

### Understand before changing

- Before modifying code, read [README.md](README.md), then [collectors/README.md](collectors/README.md)
  and [supabase/README.md](supabase/README.md) as relevant, and the code you will touch.
- Extend existing modules; do not rebuild functionality that exists. For example, the
  short-interest tables and views already exist, and the 13F collector already handles
  amendments and multiple CIKs.
- Match the surrounding code's style, naming and comment density. Prefer the simplest change.

### Credentials

- `.env.local` holds real secrets. Never print, log, copy or commit its values, or paste them into
  commands or tool output. Check variable names only.
- The web app uses only `SUPABASE_PUBLISHABLE_KEY`, on the server. `SUPABASE_SECRET_KEY` is for
  collectors only. Never give any key a `NEXT_PUBLIC_` prefix.

### Financial data and the database

The Supabase database holds validated SEC data that took real effort to collect. Preserve it.

- **Allowed without asking:** read-only queries with the publishable key, collector runs with
  `--dry-run`, the offline checks (`npm run test:db`, `test:collectors`, `test:web`, `typecheck`,
  `lint`), and writing new migration files.
- **Ask the user first, every time:** anything that writes to Supabase. That includes
  `npm run collect:13f` or `npm run link:cik` without `--dry-run`, applying migrations
  (`supabase db push`), and any insert, update or delete. One approval does not cover later
  changes.
- **Never:** `supabase db reset`, dropping or truncating tables, deleting completed filings, or
  editing a migration that has already been applied (add a new migration instead).
- Run one collector process at a time. Before importing large filers, consider Supabase storage
  limits (see README "Known limitations").

### Git

- Do not commit or push unless the user explicitly asks. One approval does not cover later commits.
- Never commit `.env.local` or other credentials.

### Working with the user

The user is relatively new to software development. Keep explanations short and plain, explain
significant architectural decisions, and avoid unnecessary complexity.
