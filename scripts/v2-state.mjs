// What is actually in the v2 database right now.
//
// Read-only. Answers "which migration stages have landed?" without opening the
// Supabase console, so the answer is a count rather than a memory.
//
// Usage:  node scripts/v2-state.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const v2 = createClient(env.DAM_V2_SUPABASE_URL, env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TABLES = [
  ["dam_studios", "stage 1"], ["dam_assets", "stage 1"], ["dam_asset_versions", "stage 1"],
  ["dam_external_ids", "stage 1"], ["dam_categories", "seed"],
  ["dam_projects", "stage 2"], ["dam_project_aliases", "stage 2"], ["dam_project_assets", "stage 2"],
  ["dam_keyword_categories", "seed + stage 4"], ["dam_keywords", "stage 3 + stage 4"],
  ["dam_keyword_links", "stage 3 + stage 4"],
  ["dam_users", "—"], ["dam_clients", "—"], ["dam_employees", "—"], ["dam_albums", "—"],
  ["dam_jobs", "—"],
  // dam_asset_search is keyed on asset_id and has no id column.
  ["dam_asset_search", "—", "asset_id"],
  ["dam_ai_suggestions", "—"],
  ["dam_field_values", "—"], ["dam_asset_rights", "—"], ["dam_text_blocks", "—"],
  ["dam_derivatives", "—"], ["dam_audit_log", "audit"],
];

console.log("table                      rows        written by");
let failed = 0;
for (const [t, by, key] of TABLES) {
  const { count, error } = await v2.from(t).select(key ?? "id", { count: "exact", head: true });
  if (error) { console.log(`  ${t.padEnd(24)} ERROR  ${error.message}`); failed++; continue; }
  console.log(`  ${t.padEnd(24)} ${String(count).padStart(8)}        ${by}`);
}

// Stage 4 is the only stage whose completion is ambiguous from a row count
// alone, because stage 3 also writes keywords. Split them by namespace.
const { count: assetKw } = await v2.from("dam_keywords").select("id", { count: "exact", head: true }).eq("namespace", "asset");
const { count: projKw } = await v2.from("dam_keywords").select("id", { count: "exact", head: true }).eq("namespace", "project");
console.log(`\n  dam_keywords by namespace: asset ${assetKw} (stage 4 writes 1135) · project ${projKw} (stage 3 wrote 54)`);
console.log(`  STAGE 4: ${assetKw >= 1135 ? "written" : assetKw > 0 ? "PARTIAL — resume with --write" : "NOT YET WRITTEN"}`);
if (failed) console.log(`\n  ${failed} table(s) unreadable`);
