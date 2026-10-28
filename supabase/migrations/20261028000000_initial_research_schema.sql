-- Seven research tables. Requires PostgreSQL 15+ (Supabase roles are pre-existing).
begin;

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
create schema research_private;
revoke all on schema research_private from public, anon, authenticated;
grant usage on schema research_private to service_role;
set local search_path = public, extensions, pg_catalog;

create table public.investors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  cik text not null unique check (cik ~ '^[0-9]{10}$'),
  track_filings boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.securities (
  id uuid primary key default gen_random_uuid(),
  issuer_name text not null check (btrim(issuer_name) <> ''),
  share_class text,
  security_type text not null default 'unknown' check (btrim(security_type) <> ''),
  track_short_interest boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.security_identifiers (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references public.securities(id),
  identifier_type text not null check (identifier_type in ('cusip', 'ticker', 'provider_symbol', 'figi')),
  identifier_value text not null check (identifier_value = btrim(identifier_value) and identifier_value <> ''),
  -- Exchange MIC for tickers; provider name for provider symbols; empty for global IDs.
  namespace text not null default '' check (namespace = btrim(namespace)),
  valid_from date not null,
  valid_to date,
  source_reference text not null check (btrim(source_reference) <> ''),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  check (identifier_type <> 'ticker' or (namespace ~ '^[A-Z0-9]{4}$' and identifier_value = upper(identifier_value))),
  check (identifier_type <> 'provider_symbol' or namespace ~ '^[a-z0-9][a-z0-9_-]*$'),
  check (
    (identifier_type in ('ticker', 'provider_symbol') and btrim(namespace) <> '')
    or (identifier_type in ('cusip', 'figi') and namespace = '')
  ),
  constraint identifier_periods_do_not_overlap exclude using gist (
    identifier_type with =, namespace with =, identifier_value with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

create table public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  collector text not null check (collector in ('sec13f', 'short_interest')),
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9_-]*$'),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_processed integer not null default 0 check (records_processed >= 0),
  checkpoint jsonb not null default '{}'::jsonb,
  error_message text,
  check (finished_at is null or finished_at >= started_at),
  check ((status = 'running') = (finished_at is null))
);

create table public.filings (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references public.investors(id),
  collection_run_id uuid not null references public.collection_runs(id),
  accession_number text not null unique check (accession_number ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  report_period date not null check (to_char(report_period, 'MM-DD') in ('03-31', '06-30', '09-30', '12-31')),
  filed_at timestamptz not null,
  form_type text not null check (form_type in ('13F-HR', '13F-HR/A', '13F-NT', '13F-NT/A')),
  report_type text not null check (report_type in ('holdings', 'combination', 'notice')),
  amendment_type text not null default 'none' check (amendment_type in ('none', 'restatement', 'new_holdings')),
  amendment_number integer not null default 0 check (amendment_number >= 0),
  original_filing_id uuid,
  reported_entry_count integer check (reported_entry_count >= 0),
  reported_total_value numeric(24,4) check (reported_total_value >= 0 and reported_total_value <> 'NaN'::numeric),
  value_multiplier smallint not null check (value_multiplier in (1, 1000)),
  has_confidential_omissions boolean not null default false,
  other_managers jsonb not null default '[]'::jsonb check (jsonb_typeof(other_managers) = 'array'),
  source_url text not null check (source_url ~ '^https://'),
  source_checksum text check (source_checksum ~ '^[a-f0-9]{64}$'),
  source_document_reference text,
  import_status text not null default 'pending' check (import_status in ('pending', 'complete', 'failed')),
  collected_at timestamptz not null default now(),
  validated_at timestamptz,
  unique (id, investor_id, report_period),
  foreign key (original_filing_id, investor_id, report_period)
    references public.filings(id, investor_id, report_period),
  check ((report_type = 'notice') = (form_type in ('13F-NT', '13F-NT/A'))),
  check (
    (amendment_type = 'none' and amendment_number = 0 and original_filing_id is null and form_type in ('13F-HR', '13F-NT'))
    or (amendment_type <> 'none' and amendment_number > 0 and form_type in ('13F-HR/A', '13F-NT/A'))
  ),
  check (original_filing_id is distinct from id),
  check ((import_status = 'complete') = (validated_at is not null))
);

create table public.holdings (
  id bigint generated always as identity primary key,
  filing_id uuid not null references public.filings(id),
  source_row integer not null check (source_row > 0),
  security_id uuid references public.securities(id),
  reported_cusip text,
  reported_issuer text not null check (btrim(reported_issuer) <> ''),
  reported_class text,
  quantity numeric(24,4) not null check (quantity >= 0 and quantity <> 'NaN'::numeric),
  quantity_type text not null check (quantity_type in ('SH', 'PRN')),
  position_type text not null default 'long' check (position_type in ('long', 'put', 'call')),
  reported_value numeric(24,4) not null check (reported_value >= 0 and reported_value <> 'NaN'::numeric),
  investment_discretion text,
  voting_sole bigint check (voting_sole >= 0),
  voting_shared bigint check (voting_shared >= 0),
  voting_none bigint check (voting_none >= 0),
  other_manager_numbers text[] not null default '{}',
  raw_row jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_row) = 'object'),
  unique (filing_id, source_row),
  check (position_type = 'long' or quantity_type = 'SH')
);

create table public.short_interest (
  id bigint generated always as identity primary key,
  security_id uuid not null references public.securities(id),
  collection_run_id uuid not null references public.collection_runs(id),
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9_-]*$'),
  settlement_date date not null,
  published_at timestamptz,
  source_revision_at timestamptz,
  source_record_id text,
  revision integer not null check (revision > 0),
  shares_short bigint not null check (shares_short >= 0),
  float_shares bigint check (float_shares > 0),
  float_as_of date,
  average_daily_volume numeric(24,4) check (average_daily_volume >= 0 and average_daily_volume <> 'NaN'::numeric),
  volume_window_days integer check (volume_window_days > 0),
  volume_as_of date,
  -- Provider-reported metrics; preserve their methodology and do not assume a denominator.
  short_percent_float numeric(16,6) check (short_percent_float >= 0 and short_percent_float <> 'NaN'::numeric),
  days_to_cover numeric(16,6) check (days_to_cover >= 0 and days_to_cover <> 'NaN'::numeric),
  source_reference text not null check (btrim(source_reference) <> ''),
  source_checksum text check (source_checksum ~ '^[a-f0-9]{64}$'),
  raw_record jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_record) = 'object'),
  validation_status text not null default 'pending' check (validation_status in ('pending', 'accepted', 'rejected')),
  collected_at timestamptz not null default now(),
  validated_at timestamptz,
  unique (security_id, settlement_date, provider, revision),
  check ((validation_status = 'pending') = (validated_at is null))
);

create index security_identifiers_security_idx on public.security_identifiers(security_id);
create index tracked_short_interest_securities_idx on public.securities(id) where track_short_interest;
create index filings_investor_period_idx on public.filings(investor_id, report_period, filed_at desc);
create index filings_original_idx on public.filings(original_filing_id);
create index filings_run_idx on public.filings(collection_run_id);
create index holdings_security_filing_idx on public.holdings(security_id, filing_id);
create index short_interest_run_idx on public.short_interest(collection_run_id);
create index short_interest_latest_idx on public.short_interest(security_id, settlement_date, provider, revision desc)
  where validation_status = 'accepted';
create index collection_runs_collector_started_idx on public.collection_runs(collector, started_at desc);

-- Completion is a checked transition, not an unchecked flag supplied by a collector.
create function research_private.guard_filing() returns trigger
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
       or row_count <> NEW.reported_entry_count or last_row <> row_count or value_total <> NEW.reported_total_value then
      raise exception 'Filing row count or value total does not match its source summary';
    end if;
    NEW.validated_at := coalesce(NEW.validated_at, now());
  else
    NEW.validated_at := null;
  end if;
  return NEW;
end;
$$;

create trigger guard_filing before insert or update or delete on public.filings
  for each row execute function research_private.guard_filing();

create function research_private.guard_holding() returns trigger
language plpgsql set search_path = '' as $$
declare
  parent public.filings%rowtype;
begin
  if TG_OP = 'UPDATE' and NEW.filing_id <> OLD.filing_id then
    raise exception 'A holding cannot be moved to another filing';
  end if;
  -- Serializes row imports with the completion check on the parent filing.
  select * into parent from public.filings
    where id = case when TG_OP = 'DELETE' then OLD.filing_id else NEW.filing_id end for update;
  if not found then raise exception 'Holding requires an existing filing'; end if;
  if parent.import_status = 'complete' then
    -- Identification can be resolved later without changing the source row.
    if TG_OP <> 'UPDATE' then raise exception 'Completed filing holdings are immutable'; end if;
    if (to_jsonb(NEW) - 'security_id') is distinct from (to_jsonb(OLD) - 'security_id') then
      raise exception 'Completed filing holdings are immutable except for security mapping';
    end if;
  end if;
  if TG_OP <> 'DELETE' and parent.report_type = 'notice' then
    raise exception 'Notice filings cannot contain holdings';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

create trigger guard_holding before insert or update or delete on public.holdings
  for each row execute function research_private.guard_holding();

create function research_private.guard_short_interest() returns trigger
language plpgsql set search_path = '' as $$
declare
  previous public.short_interest%rowtype;
  comparison_exclusions text[] := array[
    'id', 'collection_run_id', 'revision', 'collected_at', 'validated_at',
    'validation_status', 'source_checksum', 'source_reference'
  ];
begin
  if TG_OP = 'DELETE' then raise exception 'Short-interest history is append-only'; end if;
  perform pg_advisory_xact_lock(hashtext(NEW.security_id::text || ':' || NEW.provider),
    NEW.settlement_date - date '2000-01-01');
  if TG_OP = 'UPDATE' then
    if OLD.validation_status <> 'pending' and NEW is distinct from OLD then
      raise exception 'Validated observations are immutable; insert a correction instead';
    end if;
    if (to_jsonb(NEW) - array['validation_status', 'validated_at'])
       is distinct from (to_jsonb(OLD) - array['validation_status', 'validated_at']) then
      raise exception 'Observation values are immutable; insert a correction instead';
    end if;
  else
    if not exists (select 1 from public.collection_runs
      where id = NEW.collection_run_id and collector = 'short_interest' and provider = NEW.provider) then
      raise exception 'Observation must reference a matching short_interest provider run';
    end if;
    select * into previous from public.short_interest
      where security_id = NEW.security_id and settlement_date = NEW.settlement_date and provider = NEW.provider
      order by revision desc limit 1;
    if found and (to_jsonb(NEW) - comparison_exclusions) = (to_jsonb(previous) - comparison_exclusions) then
      return null; -- Re-fetching unchanged data does not create another revision.
    end if;
    NEW.revision := coalesce(previous.revision, 0) + 1;
  end if;
  if NEW.validation_status = 'accepted' and NEW.source_revision_at is not null and exists (
    select 1 from public.short_interest s where s.security_id = NEW.security_id
      and s.settlement_date = NEW.settlement_date and s.provider = NEW.provider
      and s.validation_status = 'accepted' and s.source_revision_at > NEW.source_revision_at
  ) then
    raise exception 'A known older provider revision cannot supersede accepted newer data';
  end if;
  if NEW.validation_status <> 'pending' then
    NEW.validated_at := coalesce(NEW.validated_at, now());
  else
    NEW.validated_at := null;
  end if;
  return NEW;
end;
$$;

create trigger guard_short_interest before insert or update or delete on public.short_interest
  for each row execute function research_private.guard_short_interest();

revoke all on function research_private.guard_filing(), research_private.guard_holding(),
  research_private.guard_short_interest() from public, anon, authenticated;
grant execute on function research_private.guard_filing(), research_private.guard_holding(),
  research_private.guard_short_interest() to service_role;

-- Latest validated original/restatement, plus later additions from the same original.
-- Notices are not zero-position portfolios. Incomplete imports never enter these views.
create view public.portfolio_filings with (security_invoker = true) as
with bases as (
  select distinct on (investor_id, report_period) f.*
  from public.filings f
  where import_status = 'complete' and report_type <> 'notice' and amendment_type in ('none', 'restatement')
  order by investor_id, report_period, filed_at desc, amendment_number desc, accession_number desc
)
select b.investor_id, b.report_period, b.id as base_filing_id, f.id as filing_id
from bases b join public.filings f on f.id = b.id or (
  f.investor_id = b.investor_id and f.report_period = b.report_period
  and f.amendment_type = 'new_holdings' and f.import_status = 'complete' and f.report_type <> 'notice'
  and f.original_filing_id = coalesce(b.original_filing_id, b.id)
  and (f.filed_at, f.amendment_number, f.accession_number) > (b.filed_at, b.amendment_number, b.accession_number)
);

create view public.portfolio_holdings with (security_invoker = true) as
select p.investor_id, p.report_period, p.base_filing_id,
  h.*, h.reported_value * f.value_multiplier as value_usd, f.filed_at
from public.portfolio_filings p
join public.filings f on f.id = p.filing_id
join public.holdings h on h.filing_id = p.filing_id;

-- A portfolio summary also represents a verified zero-row report.
create view public.quarterly_portfolios with (security_invoker = true) as
select p.investor_id, p.report_period, p.base_filing_id,
  max(f.filed_at) as latest_filed_at, count(*) as source_filing_count,
  sum(f.reported_entry_count) as holding_row_count,
  sum(f.reported_total_value * f.value_multiplier) as value_usd,
  bool_or(f.report_type = 'combination') as has_other_reporting_managers,
  bool_or(f.has_confidential_omissions) as has_confidential_omissions
from public.portfolio_filings p join public.filings f on f.id = p.filing_id
group by p.investor_id, p.report_period, p.base_filing_id;

create view public.latest_short_interest with (security_invoker = true) as
select distinct on (security_id, settlement_date, provider) *
from public.short_interest where validation_status = 'accepted'
order by security_id, settlement_date, provider, revision desc;

-- Explicit grants override permissive Supabase defaults. Logs have no public read policy.
alter table public.investors enable row level security;
alter table public.securities enable row level security;
alter table public.security_identifiers enable row level security;
alter table public.collection_runs enable row level security;
alter table public.filings enable row level security;
alter table public.holdings enable row level security;
alter table public.short_interest enable row level security;

revoke all on public.investors, public.securities, public.security_identifiers,
  public.collection_runs, public.filings, public.holdings, public.short_interest,
  public.portfolio_filings, public.portfolio_holdings, public.quarterly_portfolios, public.latest_short_interest
  from public, anon, authenticated, service_role;
grant select on public.investors, public.securities, public.security_identifiers,
  public.filings, public.holdings, public.short_interest,
  public.portfolio_filings, public.portfolio_holdings, public.quarterly_portfolios, public.latest_short_interest
  to anon, authenticated;
grant select, insert, update, delete on public.investors, public.securities, public.security_identifiers,
  public.collection_runs, public.filings, public.holdings, public.short_interest to service_role;
grant select on public.portfolio_filings, public.portfolio_holdings, public.quarterly_portfolios,
  public.latest_short_interest to service_role;
revoke all on sequence public.holdings_id_seq, public.short_interest_id_seq from public, anon, authenticated, service_role;
grant usage, select on sequence public.holdings_id_seq, public.short_interest_id_seq to service_role;

create policy public_read_investors on public.investors for select to anon, authenticated using (true);
create policy public_read_securities on public.securities for select to anon, authenticated using (true);
create policy public_read_identifiers on public.security_identifiers for select to anon, authenticated using (true);
create policy public_read_complete_filings on public.filings for select to anon, authenticated using (import_status = 'complete');
create policy public_read_complete_holdings on public.holdings for select to anon, authenticated using (
  exists (select 1 from public.filings where filings.id = holdings.filing_id and filings.import_status = 'complete')
);
create policy public_read_accepted_short_interest on public.short_interest for select to anon, authenticated
  using (validation_status = 'accepted');

comment on table public.collection_runs is 'Private collector diagnostics. Never store credentials in logs or checkpoint JSON.';
comment on table public.security_identifiers is 'Verified, scoped identifiers only. valid_from is inclusive; valid_to is exclusive. Do not invent historical validity dates.';
comment on column public.filings.value_multiplier is 'Read the filing format: 1000 for values reported in thousands, 1 for dollar values. Do not infer solely from report_period.';
comment on column public.holdings.reported_value is 'Unmodified source value; portfolio_holdings.value_usd applies the filing multiplier.';
comment on view public.quarterly_portfolios is 'Latest validated public 13F data, not a full economic portfolio or a point-in-time backtest.';
comment on view public.latest_short_interest is 'Latest accepted revision for each security, settlement date and provider. Does not combine providers.';

commit;
