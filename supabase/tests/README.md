# Database tests (pgTAP)

`npm run test:db` runs every `*.sql` file in this folder with pgTAP against the **local** Supabase database (`npm run db:start` first; the script refuses anything that is not local). Files run in alphabetical order, each in its own session. Every test file **rolls back**, so a run leaves the database as it found it.

## The shared helpers: `000-test-helpers.test.sql`

It runs first and _commits_ a `tests` schema of helpers, so any later file can use them without copy/paste. The schema exists only in the test database (no migration creates it; `db:reset` removes it; the file re-creates it each run).

**Identities** (deterministic, readable UUIDs; the prefix says who):

| Label                                     | Who                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `a_owner` `a_admin` `a_member` `a_viewer` | real users, members of **org A** with that role                           |
| `b_owner` `b_admin` `b_member` `b_viewer` | real users, members of **org B**                                          |
| `outsider`                                | real user in no organization                                              |
| `g1` `g2`                                 | anonymous guests, each owns a live demo (`tests.org_id('g1')`, `'g2'`)    |
| `g3`                                      | anonymous guest whose demo (`tests.org_id('expired')`) is already expired |

`tests.uid(label)` and `tests.org_id(label)` return the ids (orgs: `a`, `b`, `g1`, `g2`, `expired`). `tests.create_fixtures()` inserts all of it (users with profiles, organizations, memberships, demo mappings); call it once at the top of your file, inside your transaction.

**Acting as someone** (always pair with `tests.reset()`; everything is local to the transaction):

| Helper                                              | Effect                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `tests.act_as('a_member')`                          | `authenticated` role, JWT `sub` = that user, `is_anonymous` true for `g*` |
| `tests.act_as_uid(uuid, anonymous)`                 | the same for any user id you created yourself                             |
| `tests.act_as_role('service_role', uid, anonymous)` | any Postgres role with explicit claims (forged claims, service role)      |
| `tests.act_as_anon()` / `tests.act_as_service()`    | the public key / the service key                                          |
| `tests.reset()`                                     | back to the runner (`postgres`), claims cleared                           |

**One-shot forms** (act, run, reset in one call, so they work inside a `select count(*) from unnest(...) u where ...` loop): `tests.rows_changed_as(label, stmt)`, `tests.denied_as(label, stmt)`, `tests.visible_count_as(label, table, where)`, `tests.denied_as_anon(stmt)`. Plain forms for the current role: `tests.rows_changed(stmt)`, `tests.denied(stmt)`, `tests.sqlstate_of(stmt)`, `tests.visible_count(table, where)`, `tests.explain_text(query)`, plus `tests.public_tables()` and `tests.real_users()` for loops.

## Writing a new RLS test

1. Start the file with `begin; select plan(N); select tests.create_fixtures();` and end with `select * from finish(); rollback;`.
2. Assert the **negative** first: what must NOT work. RLS hides rows silently, so a denied `UPDATE`/`DELETE` changes **0 rows** (assert with `rows_changed`), while a missing grant raises `42501` (assert with `denied`). Reads of another tenant return **0 rows**, not an error.
3. Cover every role that matters (owner, admin, member, viewer, a guest, the other tenant, `anon`), not just one: loop over labels, as in `tenancy-isolation.test.sql`.
4. For a new table also add it to the "tenancy tables under test" list there, and give it the standard denials (no `anon`, restrictive write policies if clients may not write). The catalog tests fail until RLS is on and `anon` has no grants.
5. If you must prove a trigger, switch RLS off inside your rolled-back transaction (`alter table ... disable row level security`) rather than weakening a policy.
6. Run `npm run test:db`, then **mutation-check** it: deliberately weaken the policy or grant (for example `alter policy ... using (true)`, `grant delete ... to authenticated`) and confirm the suite fails; `npm run db:reset` restores it. A test that cannot fail proves nothing.

## Files

| File                                                                                                                                      | What it covers                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `000-test-helpers.test.sql`                                                                                                               | the helpers above, and a self-test of them                                                                                                                   |
| `tenancy-isolation.test.sql`                                                                                                              | cross-tenant select/update/delete for every role, no direct membership writes, no self-promotion, no kind/expiry changes, anon reads nothing, catalog guards |
| `rls-tenancy.test.sql`                                                                                                                    | the policy and grant contract per table, the exact policy list, defaults for new objects                                                                     |
| `rls-helpers.test.sql`, `profiles`, `organizations`, `last-owner-guard`, `immutability`, `demo-workspaces`, `demo-seed`, `bootstrap-demo` | each feature's own constraints and behavior                                                                                                                  |
