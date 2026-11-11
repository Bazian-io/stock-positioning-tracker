-- Read one complete comparison input without re-aggregating the portfolio for each API page.
-- This adds no stored data. Amendment selection, units and source-row grouping stay in the views.
begin;

create function public.comparison_positions(p_investor_ids uuid[], p_report_periods date[])
returns jsonb
language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_investor_ids is null or cardinality(p_investor_ids) not between 1 and 2
    or p_report_periods is null or cardinality(p_report_periods) not between 1 and 2
    or cardinality(p_investor_ids) * cardinality(p_report_periods) > 2
    or array_position(p_investor_ids, null) is not null
    or array_position(p_report_periods, null) is not null then
    raise exception 'A comparison requires one or two investors and one or two reporting periods, at most two portfolios'
      using errcode = '22023';
  end if;

  -- Tuples avoid repeating field names thousands of times. Quantities and USD values stay exact
  -- decimal strings, just like the previous PostgREST ::text projections. Null CUSIPs/classes stay null.
  return coalesce((
    select jsonb_agg(jsonb_build_array(
      investor_id, report_period::text, reported_cusip, reported_issuer, reported_class,
      quantity::text, value_usd::text
    ) order by investor_id, report_period, reported_cusip, reported_issuer, reported_class)
    from public.portfolio_positions
    where investor_id = any(p_investor_ids) and report_period = any(p_report_periods)
      and position_type = 'long' and quantity_type = 'SH'
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.comparison_positions(uuid[], date[]) from public, anon, authenticated, service_role;
grant execute on function public.comparison_positions(uuid[], date[]) to anon, authenticated, service_role;
comment on function public.comparison_positions(uuid[], date[]) is
  'Read-only long-share comparison inputs as [investor, period, CUSIP, issuer, class, quantity, USD value]. At most two portfolios; caller RLS applies.';

notify pgrst, 'reload schema';
commit;
