// Read-only check that the p1 migrations landed and the v2 read path works.
//
// Run after `supabase db push` and scripts/v2-backfill-search.mjs --write:
//
//   1. settings    every seeded dam_settings key is present and live, and
//                  dam_setting() answers
//   2. principals  the five system users (migration, worker, sync, ai, web)
//                  exist, flagged is_system and inactive
//   3. functions   the RPCs the app and scripts call are exposed by PostgREST
//   4. search      one dam_asset_search row per asset, none stale
//   5. as a user   with --email <addr> and DAM_V2_SUPABASE_JWT_SECRET set: looks
//                  that person up (NO provisioning) and runs dam_search_assets
//                  and dam_search_assets_count with a token minted exactly as
//                  the web app mints it — printing counts only
//
// Writes nothing: every call is a select or a STABLE function. Uses the
// service-role key for 1-4 and the anon key plus a minted token for 5. Prints
// no credential and no token. Exits 1 when any check fails.
//
// Usage:  node scripts/v2-verify.mjs
//         node scripts/v2-verify.mjs --email someone@dwp.com
//         (--env <file> reads another env file instead of .env.local)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const EMAIL = argValue("--email")?.trim().toLowerCase();

// --- credentials stay in the file and in memory; never printed -------------
const envPath = argValue("--env") ?? fileURLToPath(new URL("../.env.local", import.meta.url));
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
for (const k of ["DAM_V2_SUPABASE_URL", "DAM_V2_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!env[k]) {
    console.error(`${k} is not set in ${envPath}.`);
    process.exit(1);
  }
}
const URL_ = env.DAM_V2_SUPABASE_URL.replace(/\/+$/, "");
const noSession = { persistSession: false, autoRefreshToken: false };
const admin = createClient(URL_, env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY, { auth: noSession });

// The keys the p1 grants migration seeds (SPEC 2B.53 minus
// ai.autoaccept_confidence, plus users.default_cross_studio_visibility).
const EXPECTED_SETTINGS = [
  "albums.max_depth", "audit.redacted_columns", "firm.legal_name", "firm.timezone",
  "integrations.max_consecutive_failures", "jobs.visibility_timeout_seconds",
  "notifications.digest_hour", "privacy.ip_hash_salt_secret_name", "review.allow_self_approval",
  "rights.expiring_days", "search.default_limit", "search.max_limit", "shares.default_ttl_days",
  "templates.allow_self_approval", "text_blocks.allow_self_approval", "ai.runs_retention_months",
  "upload_requests.default_ttl_days", "uploads.max_file_bytes", "users.auto_activate_domains",
  "users.default_cross_studio_visibility", "watermark.default_text", "webhooks.rotation_overlap_hours",
];
const SYSTEM_USERS = [
  ["00000000-0000-0000-0000-000000000001", "migration"],
  ["00000000-0000-0000-0000-000000000002", "worker"],
  ["00000000-0000-0000-0000-000000000003", "sync"],
  ["00000000-0000-0000-0000-000000000004", "ai"],
  ["00000000-0000-0000-0000-000000000005", "web"],
];
const EXPECTED_RPCS = [
  "dam_setting", "dam_setting_text", "dam_setting_int", "dam_setting_bool",
  "dam_is_system", "dam_provision_user",
  "dam_rebuild_asset_search_batch", "dam_rebuild_asset_search", "dam_mark_search_stale", "dam_reindex_stale",
  "dam_search_assets", "dam_search_assets_count", "dam_search_facets",
];

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const note = (msg) => console.log(`  --    ${msg}`);

function micros(ts) {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(ts ?? "");
  if (!m) return NaN;
  return Date.parse(m[1] + m[3]) * 1000 + Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

async function checkSettings() {
  console.log("1. settings");
  const { data, error } = await admin.from("dam_settings").select("key").is("deleted_at", null);
  if (error) return fail(`dam_settings unreadable: ${error.message}`);
  const present = new Set(data.map((r) => r.key));
  const missing = EXPECTED_SETTINGS.filter((k) => !present.has(k));
  if (missing.length) fail(`${missing.length} seeded key(s) missing: ${missing.join(", ")}`);
  else ok(`all ${EXPECTED_SETTINGS.length} seeded keys present (${present.size} live keys in total)`);
  const { data: limit, error: e2 } = await admin.rpc("dam_setting", { p_key: "search.default_limit" });
  if (e2) fail(`dam_setting('search.default_limit') failed: ${e2.code ?? ""} ${e2.message}`);
  else ok(`dam_setting('search.default_limit') = ${JSON.stringify(limit)}`);
}

async function checkPrincipals() {
  console.log("2. system principals");
  const { data, error } = await admin
    .from("dam_users")
    .select("id, is_system, is_active, deleted_at")
    .in("id", SYSTEM_USERS.map(([id]) => id));
  if (error) return fail(`dam_users unreadable: ${error.message}`);
  const byId = new Map(data.map((r) => [r.id, r]));
  for (const [id, name] of SYSTEM_USERS) {
    const r = byId.get(id);
    if (!r) fail(`${name} (${id}) missing`);
    else if (!r.is_system || r.is_active || r.deleted_at) fail(`${name} exists but is_system=${r.is_system}, is_active=${r.is_active}, deleted=${!!r.deleted_at}`);
    else ok(`${name}`);
  }
}

// PostgREST's OpenAPI document lists every function the calling role may
// execute. Best-effort: some projects switch the document off.
async function checkFunctions() {
  console.log("3. functions");
  let spec;
  try {
    const res = await fetch(`${URL_}/rest/v1/`, {
      headers: {
        apikey: env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/openapi+json",
      },
    });
    if (!res.ok) return note(`skipped: the OpenAPI document answered HTTP ${res.status}`);
    spec = await res.json();
  } catch (e) {
    return note(`skipped: ${e instanceof Error ? e.message : e}`);
  }
  const paths = new Set(Object.keys(spec?.paths ?? {}));
  const missing = EXPECTED_RPCS.filter((f) => !paths.has(`/rpc/${f}`));
  if (missing.length) fail(`not exposed: ${missing.join(", ")}`);
  else ok(`all ${EXPECTED_RPCS.length} functions exposed`);
  note("pg_cron's dam-reindex-stale job is not visible through PostgREST; check cron.job in the SQL editor");
}

async function checkSearchRows() {
  console.log("4. search rows");
  const head = async (table, key) => {
    const { count, error } = await admin.from(table).select(key, { count: "exact", head: true });
    if (error) throw new Error(`${table}: ${error.message}`);
    return count ?? 0;
  };
  let assets, rows;
  try {
    assets = await head("dam_assets", "id");
    rows = await head("dam_asset_search", "asset_id");
  } catch (e) {
    return fail(e.message);
  }
  if (rows === assets) ok(`${rows} search rows for ${assets} assets`);
  else fail(`${rows} search rows for ${assets} assets — run scripts/v2-backfill-search.mjs --write`);

  let stale = 0;
  let after = null;
  for (;;) {
    let q = admin.from("dam_asset_search").select("asset_id, updated_at, indexed_at").order("asset_id").limit(1000);
    if (after) q = q.gt("asset_id", after);
    const { data, error } = await q;
    if (error) return fail(`dam_asset_search unreadable: ${error.message}`);
    for (const r of data) if (micros(r.indexed_at) < micros(r.updated_at)) stale++;
    if (data.length < 1000) break;
    after = data[data.length - 1].asset_id;
  }
  // A handful of stale rows is normal between pg_cron's one-minute drains.
  if (stale === 0) ok("no stale rows");
  else note(`${stale} stale row(s) — the pg_cron drain picks these up within a minute`);
}

async function checkAsUser() {
  console.log("5. as a user");
  if (!EMAIL) return note("skipped: pass --email <addr> to run a search as that person");
  const secret = env.DAM_V2_SUPABASE_JWT_SECRET ?? "";
  if (secret.length < 32) return fail("DAM_V2_SUPABASE_JWT_SECRET is not set (or shorter than 32 characters)");
  if (!env.DAM_V2_SUPABASE_ANON_KEY) return fail("DAM_V2_SUPABASE_ANON_KEY is not set");

  // Look up only — provisioning is a write, and this script makes none.
  const { data: users, error } = await admin
    .from("dam_users")
    .select("id, role, is_active, deleted_at, cross_studio_visibility")
    .eq("email", EMAIL)
    .limit(1);
  if (error) return fail(`dam_users unreadable: ${error.message}`);
  const u = users?.[0];
  if (!u) return note(`no dam_users row for ${EMAIL} yet — it is created at their next sign-in or /api/v2 call`);
  const active = u.is_active && !u.deleted_at;
  note(`${EMAIL}: role ${u.role}, ${active ? "active" : "NOT active"}, cross-studio ${u.cross_studio_visibility ? "on" : "off"}`);

  // Minted exactly as lib/v2/jwt.ts mints a user token.
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: "dam", aud: "authenticated", role: "authenticated", sub: u.id, email: EMAIL,
    principal: "user", principal_type: "user", iat: now, exp: now + 300,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(secret));
  const asUser = createClient(URL_, env.DAM_V2_SUPABASE_ANON_KEY, {
    auth: { ...noSession, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const [page, total] = await Promise.all([
    asUser.rpc("dam_search_assets", { p: { limit: 60 } }),
    asUser.rpc("dam_search_assets_count", { p: {} }),
  ]);
  if (page.error) return fail(`dam_search_assets: HTTP ${page.status} ${page.error.code ?? ""} ${page.error.message}`);
  if (total.error) return fail(`dam_search_assets_count: HTTP ${total.status} ${total.error.code ?? ""} ${total.error.message}`);
  const c = Array.isArray(total.data) ? total.data[0] : total.data;
  const withDrive = page.data.filter((r) => r.storage_provider === "google_drive" && r.object_key).length;
  ok(`first page ${page.data.length} row(s) (${withDrive} with a Drive file id); visible in total ${c?.total}${c?.is_estimate ? " (estimate)" : ""}`);
  if (active && Number(c?.total) === 0) note("an active user who sees nothing: check their studio memberships and cross-studio flag");
}

try {
  await checkSettings();
  await checkPrincipals();
  await checkFunctions();
  await checkSearchRows();
  await checkAsUser();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
// exitCode, not process.exit(): exiting while fetch's sockets are still closing
// trips a libuv assertion on Windows ("UV_HANDLE_CLOSING") and turns a clean
// run into a crash code.
process.exitCode = failures ? 1 : 0;
