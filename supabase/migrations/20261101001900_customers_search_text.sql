-- SIT-215: customer search through the API. PostgREST filters on columns, not expressions, so the lower-cased
-- "name company e-mail" text the trigram index covers becomes a stored generated column the API can ILIKE.
-- (The index keeps its name; it now indexes the column, so ILIKE '%acm%' uses it.)
drop index public.customers_search_trgm_idx;

alter table public.customers
  add column search_text text generated always as (
    pg_catalog.lower(display_name || ' ' || coalesce(company_name, '') || ' ' || coalesce(email, ''))
  ) stored;

create index customers_search_trgm_idx on public.customers using gin (search_text extensions.gin_trgm_ops);

comment on column public.customers.search_text is 'Lower-cased display name, company and e-mail for trigram search. Generated; never written.';
