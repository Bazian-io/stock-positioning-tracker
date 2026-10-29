-- Corporate actions in which holders of one security received shares of a stock at a fixed ratio,
-- such as Sirius XM's merger with Liberty Sirius XM Holdings on 9 September 2024 (0.1 new share for
-- each Sirius XM share, 0.8375 for each Liberty SiriusXM share). Stock pages use them to show shares an
-- investor received in the quarter of a conversion as received, estimated from its holdings reported
-- for the quarter before, instead of as a new position. Reported holdings are never changed.
begin;

create table public.security_conversions (
  id uuid primary key default gen_random_uuid(),
  -- The stock whose shares holders received.
  security_id uuid not null references public.securities(id),
  -- The security converted or held, as filers report it; it need not be a recorded stock.
  from_cusip text not null check (from_cusip ~ '^[0-9A-Z*@#]{9}$'),
  -- Shares of the stock received for each share of from_cusip, as the official record states it.
  shares_per_share numeric not null check (shares_per_share > 0),
  effective_date date not null,
  description text not null check (btrim(description) <> ''),
  source_reference text not null check (btrim(source_reference) <> ''),
  created_at timestamptz not null default now(),
  unique (security_id, from_cusip, effective_date)
);

-- Reference data like security identifiers: public read, writes through the server-side collector only.
alter table public.security_conversions enable row level security;
revoke all on public.security_conversions from public, anon, authenticated, service_role;
grant select on public.security_conversions to anon, authenticated;
grant select, insert, update, delete on public.security_conversions to service_role;
create policy public_read_security_conversions on public.security_conversions for select to anon, authenticated using (true);

comment on table public.security_conversions is
  'Official conversion ratios from corporate actions: holders of from_cusip received shares_per_share shares of the stock on effective_date. Reported holdings are not adjusted.';

commit;
