// In-process Postgres for the v2 schema: SCHEMA.sql plus supabase/migrations,
// applied to PGlite (Postgres compiled to WASM). Nothing here can reach a real
// database — there is no connection string anywhere in this folder.
//
// What differs from the Supabase project, and why each stub is safe:
//   * PGlite is Postgres 18; v2 runs 17.6. Nothing the schema uses changed.
//   * Supabase's roles (anon, authenticated, service_role) are created here
//     with the same attributes that matter: service_role bypasses RLS.
//   * Extensions live in schema "extensions", as on Supabase.
//   * pg_cron does not exist in PGlite. A stub schema "cron" records every
//     cron.schedule() call in cron.job so tests can assert on it.
//   * PostgREST is emulated by asPrincipal(): SET LOCAL ROLE plus the
//     request.jwt.claims setting, exactly the two things PostgREST does.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const BASELINE = join(REPO, "SCHEMA.sql");
export const MIGRATIONS_DIR = join(REPO, "supabase", "migrations");

const SUPABASE_STANDIN = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create extension pgcrypto schema extensions;
create extension pg_trgm schema extensions;
create extension unaccent schema extensions;
create extension vector schema extensions;
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
  language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
    returning jobid $$;
create function cron.unschedule(job_name text) returns boolean
  language sql as $$ with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
`;

// The v2 project was created under Supabase's LEGACY default privileges: every
// table, sequence and function postgres creates in public is granted to anon,
// authenticated and service_role. SCHEMA.sql relies on that (it grants nothing
// on tables, it only revokes anon). New Supabase projects use REVOKED
// defaults, which is also what a plain Postgres gives. Tests run under both so
// a migration that forgets an explicit grant fails here, not in production.
const LEGACY_DEFAULTS = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

/** Migration files in version order, excluding the baseline copy. */
export function migrationFiles() {
  let names = [];
  try {
    names = readdirSync(MIGRATIONS_DIR).filter((n) => /^\d+_.+\.sql$/.test(n)).sort();
  } catch {
    return [];
  }
  return names
    .filter((n) => !/_baseline\.sql$/.test(n))
    .map((n) => join(MIGRATIONS_DIR, n));
}

function prepareBaseline(sql) {
  // pg_cron cannot load in PGlite; the stub schema above stands in for it.
  return sql.replace(/create extension if not exists pg_cron[^;]*;/i, "-- pg_cron: stubbed by tools/pgtest");
}

/**
 * Create a database with the baseline and the given migrations applied.
 * `defaults` picks the privilege regime the baseline is applied under:
 * "legacy" (default) matches the v2 project; "revoked" matches a new one.
 * @param {{ migrations?: string[] | "all", fixtures?: string[], defaults?: "legacy" | "revoked", log?: (m: string) => void }} opts
 */
export async function createDb(opts = {}) {
  const log = opts.log ?? (() => {});
  const db = await PGlite.create({ extensions: { pg_trgm, unaccent, pgcrypto, vector } });
  await db.exec(SUPABASE_STANDIN);
  if ((opts.defaults ?? "legacy") === "legacy") await db.exec(LEGACY_DEFAULTS);
  await applyFile(db, BASELINE, prepareBaseline(readFileSync(BASELINE, "utf8")), log);
  const files = opts.migrations === undefined || opts.migrations === "all" ? migrationFiles() : opts.migrations;
  for (const f of files) await applyFile(db, f, readFileSync(f, "utf8"), log);
  for (const f of opts.fixtures ?? []) await applyFile(db, f, readFileSync(f, "utf8"), log);
  return db;
}

/**
 * Apply one file as one transaction, the way `supabase db push` does.
 * On failure the error names the file and, where Postgres gives a position,
 * the line.
 */
export async function applyFile(db, path, sql, log = () => {}) {
  const t0 = Date.now();
  try {
    await db.transaction(async (tx) => {
      await tx.exec(sql);
    });
  } catch (e) {
    const line = e.position ? sql.slice(0, Number(e.position)).split("\n").length : null;
    const where = e.where ? `\n  where: ${e.where}` : "";
    const err = new Error(`${path}${line ? `:${line}` : ""}: ${e.message}${where}`);
    err.cause = e;
    throw err;
  }
  log(`applied ${path.replace(REPO + "\\", "").replace(REPO + "/", "")} in ${Date.now() - t0} ms`);
}

/**
 * Run fn inside a transaction as a PostgREST principal would: the database
 * role switched to `role` and request.jwt.claims set to `claims`. Rolls back
 * afterwards unless opts.commit is true, so tests do not leak state.
 */
export async function asPrincipal(db, claims, fn, opts = {}) {
  const role = claims?.role ?? "authenticated";
  let result;
  const run = async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
    await tx.exec(`set local role ${role === "service_role" ? "service_role" : role === "anon" ? "anon" : "authenticated"}`);
    result = await fn(tx);
    if (!opts.commit) throw ROLLBACK;
  };
  try {
    await db.transaction(run);
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return result;
}
const ROLLBACK = Symbol("rollback");

/** Claims the web service mints for a signed-in user (SPEC 3.2.3 + the applied `principal` key). */
export function userClaims(userId, email = "someone@dwp.com") {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "dam", aud: "authenticated", role: "authenticated", sub: userId, email,
    principal: "user", principal_type: "user", iat: now, exp: now + 300,
  };
}

/** Claims the web service mints for platform-initiated writes (SPEC D-375). */
export const WEB_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000005";
export function systemClaims(userId = WEB_SYSTEM_USER_ID) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "dam", aud: "authenticated", role: "authenticated", sub: userId,
    principal: "system", principal_type: "system", iat: now, exp: now + 300,
  };
}
