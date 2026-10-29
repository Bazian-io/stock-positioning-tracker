-- Stock pages read one security's positions across every investor and quarter. Securities are matched
-- to holdings by their CUSIP identifiers (security_identifiers) when a page is read, so this index lets
-- portfolio_positions find those rows directly instead of scanning every holding. About 10 bytes per
-- holding row; it changes no data.
create index holdings_reported_cusip_idx on public.holdings (reported_cusip);
