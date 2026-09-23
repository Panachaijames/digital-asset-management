// Fill, or top up, dam_asset_search — the one table every v2 search reads.
//
// The search-row migration keeps the table current from then on (synchronous
// rebuilds for asset and project changes, stale-marking plus a pg_cron drain
// for category and keyword changes). It does not rebuild the 35k rows that
// already existed when it was applied. dam_reindex_stale(p_limit) is the
// backfill as well as the drain: each call rebuilds up to p_limit assets that
// have no search row yet or whose row is stale, oldest first, and returns how
// many it rebuilt — so calling it until it returns 0 finishes the job.
//
// Dry run by default: counts only, writes nothing. --write runs the loop.
// Uses the v2 SERVICE-ROLE key (dam_reindex_stale is granted to service_role
// only). Prints no credential.
//
// Usage:  node scripts/v2-backfill-search.mjs            # dry run
//         node scripts/v2-backfill-search.mjs --write    # rebuild until done
//         node scripts/v2-backfill-search.mjs --write --batch 250
//         (--env <file> reads another env file instead of .env.local)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BATCH = Number(argValue("--batch") ?? 1000);
if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 5000) {
  console.error("--batch must be a whole number from 1 to 5000.");
  process.exit(1);
}

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
const v2 = createClient(env.DAM_V2_SUPABASE_URL, env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// timestamptz as PostgREST renders it ("…T10:00:00.123456+00:00") to whole
// microseconds. Date.parse alone keeps milliseconds, and a row rebuilt within
// the same millisecond as its asset changed would then look fresh.
function micros(ts) {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(ts ?? "");
  if (!m) return NaN;
  return Date.parse(m[1] + m[3]) * 1000 + Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

async function count(table, key) {
  const { count: n, error } = await v2.from(table).select(key, { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

// PostgREST cannot compare two columns in a filter, so stale rows
// (indexed_at < updated_at) are counted here, a thousand rows at a time.
async function staleCount() {
  let stale = 0;
  let after = null;
  for (;;) {
    let q = v2.from("dam_asset_search").select("asset_id, updated_at, indexed_at").order("asset_id").limit(1000);
    if (after) q = q.gt("asset_id", after);
    const { data, error } = await q;
    if (error) throw new Error(`dam_asset_search: ${error.message}`);
    for (const r of data) if (micros(r.indexed_at) < micros(r.updated_at)) stale++;
    if (data.length < 1000) return stale;
    after = data[data.length - 1].asset_id;
  }
}

async function report(label) {
  const assets = await count("dam_assets", "id");
  const rows = await count("dam_asset_search", "asset_id");
  const stale = await staleCount();
  // Search rows cascade with their asset, so every row has one: the gap is
  // exactly the assets with no row.
  const missing = Math.max(0, assets - rows);
  console.log(`${label}`);
  console.log(`  dam_assets           ${String(assets).padStart(8)}`);
  console.log(`  dam_asset_search     ${String(rows).padStart(8)}`);
  console.log(`    missing a row      ${String(missing).padStart(8)}`);
  console.log(`    stale              ${String(stale).padStart(8)}`);
  return { assets, rows, missing, stale };
}

async function main() {
  const before = await report("Before:");
  const todo = before.missing + before.stale;
  if (!WRITE) {
    console.log(
      `\nDry run. ${todo} asset(s) to rebuild, about ${Math.ceil(todo / BATCH)} call(s) of ` +
        `dam_reindex_stale(${BATCH}). Re-run with --write to do it.`
    );
    return 0;
  }
  if (todo === 0) {
    console.log("\nNothing to rebuild.");
    return 0;
  }

  console.log(`\nRebuilding with dam_reindex_stale(${BATCH})…`);
  // A loop that never reaches 0 would mean rows keep going stale as fast as
  // they are rebuilt (a busy writer, or a trigger fault). Stop well past the
  // expected number of calls rather than spin forever.
  const maxCalls = Math.ceil(before.assets / BATCH) * 2 + 10;
  let total = 0;
  let calls = 0;
  for (;;) {
    const t0 = Date.now();
    const { data, error } = await v2.rpc("dam_reindex_stale", { p_limit: BATCH });
    if (error) {
      console.error(`  dam_reindex_stale failed: ${error.code ?? ""} ${error.message}`);
      if (error.code === "57014") console.error("  Statement timeout: try a smaller --batch, e.g. --batch 250.");
      if (error.code === "PGRST202") console.error("  The function does not exist yet: apply the migrations first.");
      return 1;
    }
    const n = Number(data) || 0;
    if (n === 0) break;
    total += n;
    calls++;
    console.log(`  call ${String(calls).padStart(3)}: rebuilt ${String(n).padStart(5)}  (total ${total}, ${Date.now() - t0} ms)`);
    if (calls >= maxCalls) {
      console.error(`  Stopped after ${calls} calls without reaching 0. Check for a writer or trigger re-marking rows stale.`);
      break;
    }
  }
  console.log(`\nRebuilt ${total} asset(s) in ${calls} call(s).\n`);
  const after = await report("After:");
  return after.missing + after.stale === 0 ? 0 : 1;
}

// exitCode, not process.exit(): exiting while fetch's sockets are still closing
// trips a libuv assertion on Windows ("UV_HANDLE_CLOSING") and turns a clean
// run into a crash code.
try {
  process.exitCode = await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
