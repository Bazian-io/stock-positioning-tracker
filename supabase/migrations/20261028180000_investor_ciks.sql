-- Institutional investors can file under more than one SEC CIK over time, for example when a
-- holding-company reorganization moves 13F reporting to a new legal entity. Each CIK belongs to
-- exactly one investor, so filings made under any of an investor's CIKs share one investor_id.
begin;

set local search_path = public, extensions, pg_catalog;

create table public.investor_ciks (
  cik text primary key check (cik ~ '^[0-9]{10}$'),
  investor_id uuid not null references public.investors(id),
  -- SEC's name for the entity, which can differ from the investor's name (e.g. a former parent).
  entity_name text not null check (btrim(entity_name) <> ''),
  source_reference text not null check (btrim(source_reference) <> ''),
  created_at timestamptz not null default now()
);

create index investor_ciks_investor_idx on public.investor_ciks(investor_id);

-- An investor's own CIK (investors.cik) is always one of its CIKs. Changing it keeps the old one.
create function research_private.register_investor_cik() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.investor_ciks (cik, investor_id, entity_name, source_reference)
  values (NEW.cik, NEW.id, NEW.name, 'https://data.sec.gov/submissions/CIK' || NEW.cik || '.json')
  on conflict (cik) do nothing;
  if not exists (select 1 from public.investor_ciks where cik = NEW.cik and investor_id = NEW.id) then
    raise exception 'CIK % already belongs to another investor', NEW.cik;
  end if;
  return NEW;
end;
$$;

create trigger register_investor_cik after insert or update of cik on public.investors
  for each row execute function research_private.register_investor_cik();

revoke all on function research_private.register_investor_cik() from public, anon, authenticated;
grant execute on function research_private.register_investor_cik() to service_role;

insert into public.investor_ciks (cik, investor_id, entity_name, source_reference)
select cik, id, name, 'https://data.sec.gov/submissions/CIK' || cik || '.json' from public.investors;

-- Reference data like investors: public read, writes through the server-side collector only.
alter table public.investor_ciks enable row level security;
revoke all on public.investor_ciks from public, anon, authenticated, service_role;
grant select on public.investor_ciks to anon, authenticated;
grant select, insert, update, delete on public.investor_ciks to service_role;
create policy public_read_investor_ciks on public.investor_ciks for select to anon, authenticated using (true);

comment on table public.investor_ciks is
  'Every SEC CIK an investor has filed under, including investors.cik. A CIK belongs to one investor.';

commit;
