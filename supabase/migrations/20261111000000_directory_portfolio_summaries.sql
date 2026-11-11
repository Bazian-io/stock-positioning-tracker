-- Only the position count and largest holding are needed by the Investors directory.
begin;

create function public.directory_portfolio_summaries(p_investor_ids uuid[], p_report_periods date[])
returns jsonb
language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_investor_ids is null or cardinality(p_investor_ids) not between 1 and 100
    or p_report_periods is null or cardinality(p_report_periods) <> cardinality(p_investor_ids)
    or array_ndims(p_investor_ids) <> 1 or array_ndims(p_report_periods) <> 1
    or array_position(p_investor_ids, null) is not null
    or array_position(p_report_periods, null) is not null
    or (select count(distinct id) from unnest(p_investor_ids) as ids(id)) <> cardinality(p_investor_ids) then
    raise exception 'Directory summaries require 1 to 100 distinct investors with one reporting period each'
      using errcode = '22023';
  end if;

  -- Zip the arrays: each investor has its own selected quarter, not every supplied quarter.
  -- Count the complete grouped portfolio once, before limiting to its largest position.
  return (
    select jsonb_agg(jsonb_build_array(
      requested.investor_id, requested.report_period::text, coalesce(top.position_count, 0)::text,
      top.reported_cusip, top.reported_issuer, top.value_usd::text
    ) order by requested.investor_id)
    from unnest(p_investor_ids, p_report_periods) as requested(investor_id, report_period)
    left join lateral (
      select count(*) over () as position_count, reported_cusip, reported_issuer, value_usd
      from public.portfolio_positions p
      where p.investor_id = requested.investor_id and p.report_period = requested.report_period
      -- Match getPositions' complete tie order, including options and principal positions.
      order by value_usd desc, reported_issuer, reported_cusip, reported_class, position_type, quantity_type
      limit 1
    ) top on true
  );
end;
$$;

revoke all on function public.directory_portfolio_summaries(uuid[], date[]) from public, anon, authenticated, service_role;
grant execute on function public.directory_portfolio_summaries(uuid[], date[]) to anon, authenticated, service_role;
comment on function public.directory_portfolio_summaries(uuid[], date[]) is
  'Read-only directory inputs as [investor, period, position count, largest CUSIP, issuer, USD value]. Caller must distinguish missing reports using quarterly_portfolios; caller RLS applies.';

notify pgrst, 'reload schema';
commit;
