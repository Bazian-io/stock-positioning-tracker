-- One row per position in each quarterly portfolio. A filer can report one position in several
-- source rows, for example one per subsidiary or sub-adviser; this view combines them inside the
-- database, so a page reads only the positions it shows instead of every source row (BlackRock
-- reports about 50,000 rows per quarter). Read-only: it adds no table and changes no data.
begin;

set local search_path = public, extensions, pg_catalog;

-- Rows combine when they report the same security (CUSIP, or issuer and class when the CUSIP is
-- missing), position type and quantity type. Share classes have their own CUSIPs and options keep
-- their put/call type, so both stay separate. Built on portfolio_holdings, so amendments apply.
create view public.portfolio_positions with (security_invoker = true) as
select investor_id, report_period, reported_cusip,
  -- The security as named in its first source row.
  (array_agg(reported_issuer order by filed_at, filing_id, source_row))[1] as reported_issuer,
  (array_agg(reported_class order by filed_at, filing_id, source_row))[1] as reported_class,
  position_type, quantity_type,
  sum(quantity) as quantity,
  sum(value_usd) as value_usd,
  count(*) as holding_row_count
from public.portfolio_holdings
group by investor_id, report_period, reported_cusip,
  coalesce(reported_cusip, reported_issuer || '|' || coalesce(reported_class, '')), position_type, quantity_type;

revoke all on public.portfolio_positions from public, anon, authenticated, service_role;
grant select on public.portfolio_positions to anon, authenticated, service_role;

comment on view public.portfolio_positions is
  'Reported 13F positions per investor and quarter: portfolio_holdings rows for the same security, position type and quantity type combined.';

commit;
