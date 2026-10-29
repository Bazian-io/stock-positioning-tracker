-- A CIK can count for an investor from a given quarter on. Pershing Square, Inc. reports Pershing
-- Square's portfolio from Q2 2026; before that it filed small separate reports of its own holdings while
-- Pershing Square Capital Management reported the portfolio, so those earlier reports are not the
-- investor's portfolio. Empty, as for every existing link, means every quarter.
begin;

alter table public.investor_ciks add column first_report_period date
  check (first_report_period is null
    or first_report_period = (date_trunc('quarter', first_report_period) + interval '3 months - 1 day')::date);

comment on column public.investor_ciks.first_report_period is
  'The first quarter end from which this CIK''s 13F reports count for the investor; empty means every quarter.';

commit;
