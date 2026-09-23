// Read-only reconnaissance across both DAM databases.
//
// Run before any import writes a single row. It answers two questions that
// cannot be settled by reading SCHEMA.sql:
//
//   1. Is v1 readable and how much is actually in it?
//   2. Does v2 contain ONLY what SCHEMA.sql creates, or has something else
//      been applied since? The import hand-writes values (version_no,
//      current_version_id, the dam_assets mirror columns) that a table-specific
//      trigger would silently overwrite or collide with. SCHEMA.sql says those
//      triggers live in "the phase migrations"; whether any phase migration has
//      run against THIS project is not a question the file can answer.
//
// Writes nothing. Prints no credential.
//
// Usage:  node scripts/v2-probe.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- credentials stay in the file and in memory; never printed -------------
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}

const need = (k) => {
  if (!env[k]) { console.error(`missing ${k} in .env.local`); process.exit(2); }
  return env[k];
};

const host = (u) => { try { return new URL(u).host.split(".")[0]; } catch { return "?"; } };

const v1 = createClient(need("SUPABASE_URL"), need("SUPABASE_ANON_KEY"), {
  auth: { persistSession: false },
});
const v2 = createClient(need("DAM_V2_SUPABASE_URL"), need("DAM_V2_SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

console.log(`v1 project ref  ${host(env.SUPABASE_URL)}   (anon key, read-only)`);
console.log(`v2 project ref  ${host(env.DAM_V2_SUPABASE_URL)}   (service role)`);
if (host(env.SUPABASE_URL) === host(env.DAM_V2_SUPABASE_URL)) {
  console.error("\nREFUSING TO CONTINUE: both URLs point at the same project.");
  process.exit(2);
}
console.log();

const count = async (client, table) => {
  const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
  return error ? `ERROR ${error.code ?? ""} ${error.message}` : count;
};

// --- v1 ---------------------------------------------------------------------
console.log("--- v1 (production, read-only) ---");
for (const t of ["common_dam_assets", "common_dam_presets", "common_dam_drive_sync", "common_dam_taxonomy"]) {
  console.log(`  ${t.padEnd(24)} ${await count(v1, t)}`);
}

// --- v2 ---------------------------------------------------------------------
console.log("\n--- v2 (new project) ---");
const expected = {
  dam_studios: 20, dam_categories: 8, dam_access_levels: 4,
  dam_keyword_categories: 13, dam_aspect_ratios: 6, dam_sizes: 6,
};
let seedOk = true;
for (const [t, want] of Object.entries(expected)) {
  const got = await count(v2, t);
  const ok = got === want;
  if (!ok) seedOk = false;
  console.log(`  ${t.padEnd(24)} ${String(got).padEnd(6)} ${ok ? "ok" : `EXPECTED ${want}`}`);
}
console.log("\n  tables that must be EMPTY before an import:");
for (const t of ["dam_storage_locations", "dam_assets", "dam_asset_versions", "dam_external_ids", "dam_projects", "dam_users"]) {
  const got = await count(v2, t);
  console.log(`  ${t.padEnd(24)} ${String(got).padEnd(6)} ${got === 0 ? "empty" : "NOT EMPTY — investigate before writing"}`);
}

console.log(`\nseed state: ${seedOk ? "matches SCHEMA.sql exactly" : "DOES NOT MATCH — stop and investigate"}`);
console.log(`
Still unanswered, and PostgREST cannot reach it (pg_catalog is not exposed).
Run this in the v2 SQL editor — it decides whether the importer may write
version_no, current_version_id and the dam_assets mirror columns by hand:

  select tgname, tgrelid::regclass::text as on_table
    from pg_trigger
   where not tgisinternal
     and tgrelid::regclass::text like 'dam!_%' escape '!'
   order by 2, 1;

Expected: ONLY trg_<table>_updated_at, trg_<table>_audit, and
trg_users_guard_privileged_columns. Anything else — a version-numbering,
rank-assignment, mirror or keyword-path trigger — changes the import.
`);
