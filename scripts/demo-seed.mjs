#!/usr/bin/env node
// `npm run demo:seed`: creates a throwaway demo organization in the LOCAL database and seeds it with the
// registered demo seeders, for trying the demo content by hand. Refuses anything that is not local.
// It writes only fictional fixture data. Remove it again with the SQL printed at the end.
import { spawnSync } from "node:child_process";
import { localDbViolations } from "./lib/assert-local-db.mjs";
import { withDockerPath } from "./lib/docker-path.mjs";

const problems = localDbViolations(process.env, process.argv.slice(2));
if (problems.length > 0) {
  console.error("demo:seed refused. It only runs against the local Supabase stack:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const sql = `
do $$
declare
  uid uuid := gen_random_uuid();
  oid uuid := gen_random_uuid();
begin
  insert into auth.users (id, is_anonymous, aud, role) values (uid, true, 'authenticated', 'authenticated');
  insert into public.organizations (id, name, kind, expires_at) values (oid, 'Demo Workspace (local seed)', 'demo', now() + interval '24 hours');
  insert into public.memberships (organization_id, user_id, role) values (oid, uid, 'owner');
  perform private.register_demo_workspace(oid, uid);
  perform private.seed_demo_workspace(oid);
  raise notice 'Seeded demo organization % (owner %), seed version %', oid, uid, private.demo_seed_version();
end $$;
`;
const result = spawnSync(
  "docker",
  [
    "exec",
    "supabase_db_opsdesk",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ],
  { env: withDockerPath(), encoding: "utf8" },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status === 0) {
  console.log(
    "\nRemove it with: delete from public.organizations where name = 'Demo Workspace (local seed)';",
  );
}
process.exit(result.status ?? 1);
