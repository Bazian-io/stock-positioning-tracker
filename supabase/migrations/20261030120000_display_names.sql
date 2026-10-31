-- Readable names for the website. Filers name themselves and companies in many styles ("STATE STREET
-- CORP", "BANK OF AMER CORP"); the names as filed stay unchanged, and pages show these instead:
-- - investors.display_name: a short name, such as "State Street"; empty shows the filed name.
-- - investors.segment: the kind of investor, which groups the Investors page.
-- - securities.listing_name: the security's name in Nasdaq's directory of US-listed securities, such as
--   "Bank of America Corporation Common Stock"; pages shorten it to "Bank of America".
-- The 20 tracked investors get their display names and segments here; collectors add listing names.
begin;

alter table public.investors
  add column display_name text check (display_name is null or (display_name = btrim(display_name) and display_name <> '')),
  add column segment text check (segment in ('asset_manager', 'active_manager', 'quantitative'));

comment on column public.investors.display_name is 'Short name shown on the website, such as "State Street"; empty shows the filed name.';
comment on column public.investors.segment is
  'Kind of investor: asset_manager (index and asset managers), active_manager (concentrated active funds) or quantitative.';

alter table public.securities
  add column listing_name text check (listing_name is null or btrim(listing_name) <> '');

comment on column public.securities.listing_name is
  'The security''s name in Nasdaq''s directory of US-listed securities, as listed; the website shows a shortened form.';

update public.investors as investor
set display_name = names.display_name, segment = names.segment
from (values
  ('blackrock', 'BlackRock', 'asset_manager'),
  ('state-street', 'State Street', 'asset_manager'),
  ('appaloosa', 'Appaloosa', 'active_manager'),
  ('baker-bros-advisors', 'Baker Bros. Advisors', 'active_manager'),
  ('baupost-group', 'Baupost Group', 'active_manager'),
  ('berkshire-hathaway', 'Berkshire Hathaway', 'active_manager'),
  ('coatue-management', 'Coatue Management', 'active_manager'),
  ('elliott-investment-management', 'Elliott Investment Management', 'active_manager'),
  ('greenlight-capital', 'Greenlight Capital', 'active_manager'),
  ('lone-pine-capital', 'Lone Pine Capital', 'active_manager'),
  ('pershing-square-capital-management', 'Pershing Square', 'active_manager'),
  ('tci-fund-management', 'TCI Fund Management', 'active_manager'),
  ('third-point', 'Third Point', 'active_manager'),
  ('tiger-global-management', 'Tiger Global Management', 'active_manager'),
  ('valueact-holdings', 'ValueAct Holdings', 'active_manager'),
  ('viking-global-investors', 'Viking Global Investors', 'active_manager'),
  ('bridgewater-associates', 'Bridgewater Associates', 'quantitative'),
  ('d-e-shaw', 'D. E. Shaw', 'quantitative'),
  ('renaissance-technologies', 'Renaissance Technologies', 'quantitative'),
  ('two-sigma-investments', 'Two Sigma', 'quantitative')
) as names(slug, display_name, segment)
where investor.slug = names.slug;

commit;
