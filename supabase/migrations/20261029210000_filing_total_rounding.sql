-- Filers round each row's value to a whole dollar (or thousand), so a 13F summary page's total can
-- differ from the sum of its rows by up to half a unit per row: ValueAct, Elliott and TCI by 1 or 2.
-- Completing a filing now accepts that rounding; any larger difference is still rejected. Only the
-- value-total check changes; the rest of guard_filing is as before.
begin;

create or replace function research_private.guard_filing() returns trigger
language plpgsql set search_path = '' as $$
declare
  original public.filings%rowtype;
  row_count bigint;
  last_row integer;
  value_total numeric;
begin
  if TG_OP = 'DELETE' then
    if OLD.import_status = 'complete' then
      raise exception 'Completed filings are immutable';
    end if;
    return OLD;
  end if;
  if TG_OP = 'UPDATE' and OLD.import_status = 'complete' and NEW is distinct from OLD then
    raise exception 'Completed filings are immutable';
  end if;
  if TG_OP = 'UPDATE' and NEW.amendment_type <> 'none' and exists (
    select 1 from public.filings where original_filing_id = OLD.id
  ) then
    raise exception 'An original filing referenced by amendments must remain an original';
  end if;
  if not exists (select 1 from public.collection_runs where id = NEW.collection_run_id and collector = 'sec13f') then
    raise exception 'A filing must reference a sec13f collection run';
  end if;
  if NEW.original_filing_id is not null then
    select * into original from public.filings where id = NEW.original_filing_id;
    if not found or original.investor_id <> NEW.investor_id or original.report_period <> NEW.report_period
       or original.amendment_type <> 'none' or original.filed_at > NEW.filed_at then
      raise exception 'Amendment must reference the original filing for the same investor and quarter';
    end if;
  end if;
  if NEW.import_status = 'complete' then
    if NEW.amendment_type <> 'none' and NEW.original_filing_id is null then
      raise exception 'Resolve the original filing before completing an amendment';
    end if;
    select count(*), coalesce(max(source_row), 0), coalesce(sum(reported_value), 0) into row_count, last_row, value_total
      from public.holdings where filing_id = NEW.id;
    if NEW.report_type = 'notice' then
      if row_count <> 0 then raise exception 'Notice filings cannot contain holdings'; end if;
    elsif NEW.reported_entry_count is null or NEW.reported_total_value is null
       or row_count <> NEW.reported_entry_count or last_row <> row_count
       or abs(value_total - NEW.reported_total_value) * 2 > row_count then
      raise exception 'Filing row count or value total does not match its source summary';
    end if;
    NEW.validated_at := coalesce(NEW.validated_at, now());
  else
    NEW.validated_at := null;
  end if;
  return NEW;
end;
$$;

commit;
