# stock-positioning-tracker
A stock market research platform tracking institutional ownership through SEC 13F filings and short-interest trends in U.S.-listed equities. Analyzes portfolio holdings, ownership changes, and historical short positions to provide insights into institutional and market-wide positioning.

## Run the dashboard locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
   The web app uses only the publishable key, which can read research data but not write it.
3. Start the app with `npm run dev` and open http://localhost:3000/investors/berkshire-hathaway.

Data is loaded on the server, so no database key reaches the browser. Checks: `npm run test:web`,
`npm run typecheck` and `npm run lint`. Data collection and the database are described in
[collectors/README.md](collectors/README.md) and [supabase/README.md](supabase/README.md).
