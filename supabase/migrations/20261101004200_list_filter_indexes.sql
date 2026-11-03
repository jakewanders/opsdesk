-- SIT-250: indexes for the filters added to the four list endpoints (PRD F15, 7.3). Every list query starts with `organization_id = $1`;
-- each index below leads with it, so a workspace's rows are found without touching anyone else's.
--   customers      created-day range                      (organization_id, created_at desc)
--   opportunities  amount range, sort by amount            (organization_id, amount_cents)
--   tasks          due-day range without a status         (organization_id, due_date)
--   quotes         issue-day range, valid-until range     (organization_id, issue_date), partial (organization_id, valid_until)
-- NOT added: a GIN index on customers.tags. The 10,000-row EXPLAIN showed it is never used: the row level security policy's
-- `private.is_member(organization_id)` must be evaluated before any filter whose operator is not "leakproof", and the array
-- containment operator is not (neither is the ILIKE behind the existing trigram search index). Those two filters therefore scan the
-- workspace's rows with the membership test on each (about 60 ms at 10,000 customers, inside the budget); an index only starts to
-- matter if the policy or the operator changes. Recorded in docs/DECISIONS.md.
-- The "updated" range and the archived / status / stage / owner / customer filters were already served by the SIT-208, 213, 214 and 222 indexes.
create index customers_org_created_idx on public.customers (organization_id, created_at desc);
create index opportunities_org_amount_idx on public.opportunities (organization_id, amount_cents);
create index tasks_org_due_idx on public.tasks (organization_id, due_date);
create index quotes_org_issue_date_idx on public.quotes (organization_id, issue_date);
create index quotes_org_valid_until_idx on public.quotes (organization_id, valid_until) where valid_until is not null;
