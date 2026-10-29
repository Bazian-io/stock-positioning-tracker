-- Permanent URL names for investors: /investors/[slug]. A slug is assigned once, when the investor is
-- added, from its name ("BlackRock, Inc." becomes "blackrock"). Later name changes leave it as it is,
-- so links stay valid. Existing investors get the URLs the website already uses.
begin;

set local search_path = public, extensions, pg_catalog;

-- A name as lowercase words joined by hyphens, without trailing legal forms (Inc, LLC, L.P., ...) or
-- SEC state tags such as "/MD/": "PRICE T ROWE ASSOCIATES INC /MD/" becomes "price-t-rowe-associates".
create function research_private.investor_name_slug(name text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  legal_forms constant text[] := array['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'lp', 'llp', 'ltd', 'limited', 'plc'];
  words text[] := array_remove(regexp_split_to_array(
    regexp_replace(regexp_replace(lower(name), '/[a-z]+/?', ' ', 'g'), '[''’.]', '', 'g'), '[^a-z0-9]+'), '');
begin
  while cardinality(words) > 1 and words[cardinality(words)] = any(legal_forms) loop
    words := words[1:cardinality(words) - 1];
  end loop;
  return array_to_string(words, '-');
end;
$$;

-- The slug for a new investor: its name's slug, followed by its CIK when another investor already
-- has that slug. A name without letters or digits gets the CIK alone.
create function research_private.new_investor_slug(name text, cik text) returns text
language plpgsql stable set search_path = '' as $$
declare
  base text := research_private.investor_name_slug(name);
  cik_number text := ltrim(cik, '0');
begin
  if base = '' then
    return cik_number;
  elsif exists (select 1 from public.investors where slug = base) then
    return base || '-' || cik_number;
  end if;
  return base;
end;
$$;

alter table public.investors add column slug text;

-- Existing investors, in the order they were added.
do $$
declare
  investor record;
begin
  for investor in select id, name, cik from public.investors order by created_at, id loop
    update public.investors set slug = research_private.new_investor_slug(investor.name, investor.cik) where id = investor.id;
  end loop;
end;
$$;

alter table public.investors
  alter column slug set not null,
  add constraint investors_slug_key unique (slug),
  add constraint investors_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- New investors, such as those the collector adds, get a slug unless one is given.
create function research_private.assign_investor_slug() returns trigger
language plpgsql set search_path = '' as $$
begin
  NEW.slug := coalesce(NEW.slug, research_private.new_investor_slug(NEW.name, NEW.cik));
  return NEW;
end;
$$;

create trigger assign_investor_slug before insert on public.investors
  for each row execute function research_private.assign_investor_slug();

revoke all on function research_private.investor_name_slug(text), research_private.new_investor_slug(text, text),
  research_private.assign_investor_slug() from public, anon, authenticated;
grant execute on function research_private.investor_name_slug(text), research_private.new_investor_slug(text, text),
  research_private.assign_investor_slug() to service_role;

comment on column public.investors.slug is
  'Permanent URL name (/investors/[slug]), assigned from the name when the investor is added. Name changes leave it unchanged.';

commit;
