-- Baseline migration (SIT-160). Proves the migration pipeline; creates no tables.
--
-- Conventions for every later migration (PRD section 6):
--   * primary keys: uuid default gen_random_uuid()
--   * instants: timestamptz; calendar dates: date; money: bigint integer cents
--   * name every constraint and index explicitly (e.g. customers_org_email_key)
--   * every tenant table: row level security enabled, explicit grants, tests in supabase/tests/
--   * migrations are forward-only and idempotent where practical

-- Trigram search (customer search, later issues). Installed into the `extensions` schema.
create extension if not exists pg_trgm with schema extensions;
