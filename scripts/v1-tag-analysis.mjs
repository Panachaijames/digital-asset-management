// How much of the v1 tag vocabulary is worth turning into real keywords?
//
// v1's tags are AI auto-tag output. There are 93,354 distinct values over
// 34,889 assets — a clean, useful head and an enormous one-off tail. Importing
// all of them as dam_keywords would make the taxonomy screen unusable and
// balloon dam_asset_search.asset_keyword_ids for no gain.
//
// This finds where the distribution actually cuts, and separates the tags that
// restate something already modelled (sector, studio) from the ones that
// describe the picture and have nowhere else to live.
//
// Reads v2 only. Writes nothing to any database.
import { readFileSync, writeFileSync } from "node:fs";
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

const tag = {};
for (let from = 0; ; from += 1000) {
  const { data, error } = await v2.from("dam_assets").select("legacy").order("id").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  for (const a of data) for (const x of a.legacy?.tags ?? []) tag[x] = (tag[x] ?? 0) + 1;
  if (data.length < 1000) break;
}
const entries = Object.entries(tag).sort((a, b) => b[1] - a[1]);
const total = entries.reduce((n, [, v]) => n + v, 0);

console.log(`${entries.length} distinct tags · ${total} applications\n`);
console.log("cut     tags kept   covers");
for (const c of [500, 200, 100, 50, 20, 10, 5, 2]) {
  const kept = entries.filter(([, v]) => v >= c);
  const cov = kept.reduce((n, [, v]) => n + v, 0);
  console.log(`  >=${String(c).padEnd(5)} ${String(kept.length).padStart(6)}     ${(100 * cov / total).toFixed(1)}% of all tag uses`);
}

// Tags that restate something v2 already models elsewhere. Re-importing these
// as asset keywords would record the same fact twice, in two places that can
// then disagree.
// All THREE levels of the taxonomy, read from the v1 seed rather than listed by
// hand. The first pass only listed macro and core, which made `luxury resort`,
// `global hq`, `showflat` and every other sub-sector look like fresh vocabulary
// when Stage 3 had already put them on the projects.
const SECTOR_WORDS = new Set(
  [...readFileSync("supabase/schema.sql", "utf8").matchAll(/^\s*\('([^']+)','([^']+)','([^']+)'\),?$/gm)]
    .flatMap((m) => [m[1], m[2], m[3]])
    .map((s) => s.toLowerCase())
);
const PLACE_WORDS = new Set(["apac", "mena", "emea", "australia", "thailand", "bangkok", "singapore", "uae",
  "dubai", "vietnam", "hong kong", "china", "malaysia", "myanmar", "philippines", "new zealand", "bahrain",
  "london", "united kingdom", "usa", "saudi arabia", "riyadh", "manila", "uk", "americas", "europe"]);

const head = entries.filter(([, v]) => v >= 20);
const dupSector = head.filter(([k]) => SECTOR_WORDS.has(k.toLowerCase()));
const dupPlace = head.filter(([k]) => PLACE_WORDS.has(k.toLowerCase()));
const fresh = head.filter(([k]) => !SECTOR_WORDS.has(k.toLowerCase()) && !PLACE_WORDS.has(k.toLowerCase()));

console.log(`\nof the ${head.length} tags used 20+ times:`);
console.log(`  ${dupSector.length} restate the SECTOR already on the project`);
console.log(`  ${dupPlace.length} restate the STUDIO/region already on the asset`);
console.log(`  ${fresh.length} describe the picture and have nowhere else to live`);

console.log("\ntop 30 of those that genuinely describe the picture:");
for (const [k, v] of fresh.slice(0, 30)) console.log(`  ${String(v).padStart(5)}  ${k}`);

writeFileSync("scripts/v1-tag-vocabulary.csv",
  ["tag,uses,classification"].concat(head.map(([k, v]) => {
    const c = SECTOR_WORDS.has(k.toLowerCase()) ? "already modelled: sector"
            : PLACE_WORDS.has(k.toLowerCase()) ? "already modelled: studio"
            : "describes the asset";
    return `"${k.replace(/"/g, '""')}",${v},"${c}"`;
  })).join("\n"), "utf8");
console.log(`\nwrote scripts/v1-tag-vocabulary.csv (${head.length} rows)`);
