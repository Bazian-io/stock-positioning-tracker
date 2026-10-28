-- holdings.raw_row held a full copy of each SEC information-table row, although the typed columns
-- already store the same fields. raw_row now keeps only what the columns cannot reproduce exactly:
-- fields the collector does not read (such as figi) and values in a non-standard format. The SEC row
-- is rebuilt as the columns' fields plus raw_row; collectors/sec13f/source-row.mts applies the same
-- rule to new imports and verifies it.
--
-- The table is rewritten (ALTER COLUMN ... USING), so no row is updated: the immutability trigger on
-- completed holdings stays in force, and the old rows' space is released when the transaction
-- commits. Every rewritten row is checked against a copy of the original; any difference rolls the
-- whole migration back. holdings is locked against reads and writes until the migration commits.
begin;

set local search_path = public, extensions, pg_catalog;

-- The information-table fields a holding's columns hold, in the SEC's XML format.
create function pg_temp.column_fields(
  issuer text, title_of_class text, cusip text, value numeric, quantity numeric, quantity_type text, position_type text,
  discretion text, other_managers text[], voting_sole bigint, voting_shared bigint, voting_none bigint
) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'nameOfIssuer', issuer,
    'titleOfClass', title_of_class,
    'cusip', cusip,
    'value', trim_scale(value)::text,
    'shrsOrPrnAmt', jsonb_build_object('sshPrnamt', trim_scale(quantity)::text, 'sshPrnamtType', quantity_type),
    'putCall', case position_type when 'put' then 'Put' when 'call' then 'Call' end,
    'investmentDiscretion', discretion,
    'otherManager', nullif(array_to_string(other_managers, ','), ''),
    'votingAuthority', jsonb_build_object('Sole', voting_sole::text, 'Shared', voting_shared::text, 'None', voting_none::text)
  ))
$$;

-- The parts of source that reproduced lacks or differs from, comparing nested objects field by field.
create function pg_temp.difference(source jsonb, reproduced jsonb) returns jsonb language plpgsql immutable as $$
declare
  field record;
  nested jsonb;
  result jsonb := '{}';
begin
  for field in select key, value from jsonb_each(source) loop
    if reproduced -> field.key = field.value then
      continue;
    elsif jsonb_typeof(field.value) = 'object' and jsonb_typeof(reproduced -> field.key) = 'object' then
      nested := pg_temp.difference(field.value, reproduced -> field.key);
      if nested <> '{}' then result := result || jsonb_build_object(field.key, nested); end if;
    else
      result := result || jsonb_build_object(field.key, field.value);
    end if;
  end loop;
  return result;
end;
$$;

create function pg_temp.merge(base jsonb, extra jsonb) returns jsonb language plpgsql immutable as $$
declare
  field record;
  result jsonb := base;
begin
  for field in select key, value from jsonb_each(extra) loop
    if jsonb_typeof(field.value) = 'object' and jsonb_typeof(result -> field.key) = 'object' then
      result := result || jsonb_build_object(field.key, pg_temp.merge(result -> field.key, field.value));
    else
      result := result || jsonb_build_object(field.key, field.value);
    end if;
  end loop;
  return result;
end;
$$;

create temporary table original_raw_rows on commit drop as select id, raw_row from public.holdings;

-- portfolio_holdings selects h.*, which blocks rewriting the column; it is recreated unchanged below.
drop view public.portfolio_holdings;

alter table public.holdings alter column raw_row type jsonb using pg_temp.difference(raw_row, pg_temp.column_fields(
  reported_issuer, reported_class, reported_cusip, reported_value, quantity, quantity_type, position_type,
  investment_discretion, other_manager_numbers, voting_sole, voting_shared, voting_none
));

do $$
begin
  if (select count(*) from public.holdings) <> (select count(*) from original_raw_rows) or exists (
    select 1 from original_raw_rows o join public.holdings h using (id)
    where pg_temp.merge(pg_temp.column_fields(
      h.reported_issuer, h.reported_class, h.reported_cusip, h.reported_value, h.quantity, h.quantity_type, h.position_type,
      h.investment_discretion, h.other_manager_numbers, h.voting_sole, h.voting_shared, h.voting_none
    ), h.raw_row) is distinct from o.raw_row
  ) then
    raise exception 'Compacting raw_row would lose source data; nothing was changed';
  end if;
end;
$$;

create view public.portfolio_holdings with (security_invoker = true) as
select p.investor_id, p.report_period, p.base_filing_id,
  h.*, h.reported_value * f.value_multiplier as value_usd, f.filed_at
from public.portfolio_filings p
join public.filings f on f.id = p.filing_id
join public.holdings h on h.filing_id = p.filing_id;

revoke all on public.portfolio_holdings from public, anon, authenticated, service_role;
grant select on public.portfolio_holdings to anon, authenticated, service_role;

drop function pg_temp.column_fields(text, text, text, numeric, numeric, text, text, text, text[], bigint, bigint, bigint),
  pg_temp.difference(jsonb, jsonb), pg_temp.merge(jsonb, jsonb);

comment on column public.holdings.raw_row is
  'Source fields the other columns cannot reproduce exactly (usually none). The SEC row is the columns'' fields plus raw_row; see collectors/sec13f/source-row.mts.';

commit;
