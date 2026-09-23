// Apply SCHEMA.sql + every supabase/migrations file (or the ones named) to a
// throwaway in-process Postgres and report. Proves the chain applies; it does
// not prove the migrations apply to the populated v2 data — fixtures do that
// in test.mjs.
//
//   node apply.mjs                         # baseline + all migrations
//   node apply.mjs --files a.sql b.sql     # baseline + just these, in order
//   node apply.mjs --fixtures fixtures.sql # then load fixtures
import { createDb, migrationFiles } from "./harness.mjs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const pick = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(resolve(args[j]));
  return out;
};
const migrations = pick("--files") ?? migrationFiles();
const fixtures = pick("--fixtures") ?? [];

try {
  const db = await createDb({ migrations, fixtures, log: (m) => console.log(m) });
  const r = await db.query(`
    select (select count(*) from pg_tables where schemaname = 'public' and tablename like 'dam\\_%')::int as tables,
           (select count(*) from pg_policies where schemaname = 'public')::int as policies,
           (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'dam\\_%')::int as functions,
           (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and not t.tgisinternal)::int as triggers`);
  console.log("OK", r.rows[0]);
} catch (e) {
  console.error("FAILED", e.message);
  process.exitCode = 1;
}
