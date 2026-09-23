// Stage 4: the asset keyword vocabulary.
//
// v1's free-text `tags` are AI auto-tag output: 93,354 distinct values over
// 34,949 assets, a clean head and an enormous one-off tail. v1-tag-analysis.mjs
// cut it at 20+ uses, three rounds of classification sorted the survivors into
// categories, and tag-normalise.mjs made those categories CONSISTENT. This
// stage turns that result into real rows.
//
// Creates:
//   dam_keyword_categories  the 7 asset-namespace categories v2 has no seed for
//   dam_keywords            one flat keyword per kept tag, source 'migration'
//   dam_keyword_links       asset -> keyword, one per tag the asset carries
//
// Everything is keyed on the keyword's path, so a re-run creates nothing twice
// and a half-finished run resumes where it stopped.
//
// THREE GUARDS THIS SCRIPT CANNOT LEAN ON. SCHEMA.sql documents them in
// comments but never wires them up, which is why this script does the work
// itself rather than letting the database refuse a bad row:
//   - dam_assert_keyword_target()  named at dam_keyword_links.target_id. It does
//     not exist. Nothing checks that target_id is a live asset or that the
//     keyword's namespace matches target_type. Every target here comes from a
//     dam_assets row this script read, so it is valid by construction.
//   - dam_assert_target_exists()   defined, never attached to any table.
//   - trg_dam_keywords_path        named at dam_keywords.namespace as the
//     maintainer of namespace/path/depth and the enforcer of max_depth. It does
//     not exist, so this script sets all four columns explicitly. Stage 3 did
//     the same, which is why it worked.
//
// Usage:
//   node scripts/import-stage4.mjs            # dry run
//   node scripts/import-stage4.mjs --write
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
const WRITE = process.argv.includes("--write");
const PAGE = 1000;
const v2 = createClient(env.DAM_V2_SUPABASE_URL, env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const die = (w, e) => { console.error(`\n${w}:`, e?.message ?? e); process.exit(1); };
console.log(WRITE ? "MODE: WRITE\n" : "MODE: dry run — nothing will be written\n");

// ---- the classified vocabulary ----------------------------------------------
const assignments = JSON.parse(readFileSync("scripts/tag-assignments-final.json", "utf8"));
const categoryOf = new Map(assignments.map((a) => [a.tag, a.category]));
const kept = assignments.filter((a) => a.category !== "drop");
console.log(`vocabulary: ${assignments.length} classified · ${kept.length} kept · ${assignments.length - kept.length} dropped\n`);

// The 7 categories v2 has no seed for. Names are Title Case and carry no
// ampersand, per the UI standard's copy rules.
// max_depth 3 throughout: it is a ceiling, not a commitment. Every keyword this
// stage writes is depth 1, but a curator who later wants to nest
// "pendant lighting" under "decorative lighting" can do it without a migration.
const NEW_CATEGORIES = [
  { slug: "architectural-element", name: "Architectural Element", description: "Built elements of the space: facades, ceilings, staircases, screens." },
  { slug: "furniture-fittings",    name: "Furniture and Fittings", description: "Loose and fixed furniture, joinery, sanitaryware and equipment." },
  { slug: "design-style",          name: "Design Style",           description: "The design language the work is in." },
  { slug: "lighting",              name: "Lighting",               description: "Luminaires and the quality of illumination." },
  { slug: "sustainability",        name: "Sustainability",         description: "Planting, greenery and green building features." },
  { slug: "setting",               name: "Setting",                description: "Where the subject sits: urban, coastal, waterfront." },
  { slug: "medium",                name: "Medium",                 description: "What the image itself is: photograph, render, sketch, model." },
];

// ---- existing categories -----------------------------------------------------
const { data: existingCats, error: ce } = await v2.from("dam_keyword_categories")
  .select("id, slug, namespace, max_depth, is_exclusive, sort_order").eq("namespace", "asset");
if (ce) die("reading keyword categories", ce);
const catBySlug = new Map(existingCats.map((c) => [c.slug, c]));

const usedCategories = [...new Set(kept.map((a) => a.category))].sort();
const missing = usedCategories.filter((s) => !catBySlug.has(s) && !NEW_CATEGORIES.some((c) => c.slug === s));
if (missing.length) die("category mapping", `no v2 category and no definition for: ${missing.join(", ")}`);

const toCreate = NEW_CATEGORIES.filter((c) => !catBySlug.has(c.slug));
console.log(`categories: ${existingCats.length} exist in the asset namespace · ${toCreate.length} to create`);
for (const c of toCreate) console.log(`    + ${c.slug.padEnd(22)} ${c.name}`);
// An exclusive category means the UI lets an asset hold only ONE of its
// keywords. Nothing in the database enforces that, so this script does: where a
// v1 asset carried several, the FIRST is kept and the rest are counted below.
const EXCLUSIVE = new Set(existingCats.filter((c) => c.is_exclusive).map((c) => c.slug));
console.log(`exclusive categories (one keyword per asset): ${[...EXCLUSIVE].sort().join(", ") || "none"}\n`);

// ---- tag -> keyword identity -------------------------------------------------
// Two tags can slug to one keyword ("high-tech" and "high tech"). They ARE one
// keyword, so both tags point at it rather than one of them being lost to the
// sibling-slug unique index at insert time.
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const keywordByPath = new Map();   // path -> { name, categorySlug, tags[] }
const unslugabl = [];
for (const { tag, category } of kept) {
  const slug = slugify(tag);
  if (!slug) { unslugabl.push(tag); continue; }
  const path = slug;   // depth 1: path IS the slug
  if (!keywordByPath.has(path)) keywordByPath.set(path, { name: tag, slug, path, categorySlug: category, tags: [] });
  const k = keywordByPath.get(path);
  if (k.categorySlug !== category) {
    // tag-normalise unifies equivalence classes by WORDS; two tags that slug
    // alike always have the same words, so this is unreachable. Loud if it is.
    die("slug collision", `"${tag}" [${category}] collides with "${k.name}" [${k.categorySlug}] on slug "${slug}"`);
  }
  k.tags.push(tag);
}
const merged = [...keywordByPath.values()].filter((k) => k.tags.length > 1);
console.log(`keywords: ${keywordByPath.size} distinct · ${merged.length} absorb a second spelling · ${unslugabl.length} unslugable`);
for (const k of merged.slice(0, 8)) console.log(`    ${k.path.padEnd(28)} <- ${k.tags.join(" | ")}`);
if (unslugabl.length) console.log(`    UNSLUGABLE (dropped): ${unslugabl.join(" | ")}`);
console.log();

// ---- what the assets carry ---------------------------------------------------
const pathForTag = new Map();
for (const k of keywordByPath.values()) for (const t of k.tags) pathForTag.set(t, k.path);

let assetCount = 0, tagApplications = 0, matchedApplications = 0;
let exclusiveDropped = 0;
const perAsset = new Map();        // asset_id -> Set(path)
const useCount = new Map();        // path -> assets carrying it
for (let from = 0; ; from += PAGE) {
  const { data, error } = await v2.from("dam_assets").select("id, legacy").order("id").range(from, from + PAGE - 1);
  if (error) die("reading assets", error);
  for (const a of data) {
    assetCount++;
    const tags = a.legacy?.tags ?? [];
    tagApplications += tags.length;
    const paths = new Set();
    const exclusiveTaken = new Set();
    for (const t of tags) {                       // v1 order is the AI's own ranking
      const path = pathForTag.get(t);
      if (!path) continue;                        // below the cut, or dropped
      matchedApplications++;
      const cat = categoryOf.get(t);
      if (EXCLUSIVE.has(cat)) {
        if (exclusiveTaken.has(cat)) { exclusiveDropped++; continue; }
        exclusiveTaken.add(cat);
      }
      if (paths.has(path)) continue;              // two spellings, one keyword
      paths.add(path);
      useCount.set(path, (useCount.get(path) ?? 0) + 1);
    }
    if (paths.size) perAsset.set(a.id, paths);
  }
  if (data.length < PAGE) break;
}
const totalLinks = [...perAsset.values()].reduce((n, s) => n + s.size, 0);
console.log(`assets: ${assetCount} read · ${perAsset.size} carry at least one kept tag`);
console.log(`tag applications: ${tagApplications} in v1 · ${matchedApplications} matched the kept vocabulary (${(100 * matchedApplications / tagApplications).toFixed(1)}%)`);
console.log(`links to write: ${totalLinks}  (${(totalLinks / Math.max(1, perAsset.size)).toFixed(1)} per tagged asset)`);
if (exclusiveDropped) console.log(`  ${exclusiveDropped} extra keywords in an exclusive category were NOT linked — first one wins`);
const never = [...keywordByPath.keys()].filter((p) => !useCount.has(p));
if (never.length) console.log(`  ${never.length} keywords no live asset carries: ${never.slice(0, 10).join(", ")}${never.length > 10 ? " ..." : ""}`);
console.log();

// Every link fires trg_keyword_links_audit. That is the schema's own design,
// but at this volume it is worth saying out loud before it happens.
console.log(`NOTE: dam_keyword_links is audited, so this also writes ~${totalLinks} rows to dam_audit_log.\n`);

const top = [...useCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log("most-carried keywords:");
for (const [p, n] of top) console.log(`  ${String(n).padStart(6)}  ${p}`);
console.log();

if (!WRITE) {
  const byCat = {};
  for (const k of keywordByPath.values()) byCat[k.categorySlug] = (byCat[k.categorySlug] ?? 0) + 1;
  console.log("keywords by category:");
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log("\ndry run — nothing written. Re-run with --write.");
  process.exit(0);
}

// ---- write the categories ----------------------------------------------------
let sortOrder = Math.max(0, ...existingCats.map((c) => c.sort_order ?? 0));
if (toCreate.length) {
  const rows = toCreate.map((c) => ({
    namespace: "asset", name: c.name, slug: c.slug, description: c.description,
    max_depth: 3, is_exclusive: false, sort_order: ++sortOrder,
    // NOT is_system: the protect triggers refuse to delete or re-slug a system
    // row, and these are a migration's judgement, not the product's.
    is_system: false, is_active: true,
  }));
  const { data, error } = await v2.from("dam_keyword_categories").insert(rows).select("id, slug, is_exclusive, sort_order");
  if (error) die("inserting keyword categories", error);
  for (const c of data) catBySlug.set(c.slug, c);
  console.log(`  ${data.length} keyword categories created`);
}

// ---- write the keywords ------------------------------------------------------
const idOfPath = new Map();
for (const slug of usedCategories) {
  const cat = catBySlug.get(slug);
  if (!cat) die("category", `still missing after create: ${slug}`);
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await v2.from("dam_keywords").select("id, path").eq("category_id", cat.id).order("id").range(from, from + PAGE - 1);
    if (error) die("reading existing keywords", error);
    for (const k of data) idOfPath.set(k.path, k.id);
    if (data.length < PAGE) break;
  }
}
const newKeywords = [...keywordByPath.values()].filter((k) => !idOfPath.has(k.path));
for (let i = 0; i < newKeywords.length; i += 500) {
  const batch = newKeywords.slice(i, i + 500).map((k) => ({
    namespace: "asset", category_id: catBySlug.get(k.categorySlug).id, parent_id: null,
    name: k.name, slug: k.slug, path: k.path, depth: 1,
    source: "migration", is_active: true,
  }));
  const { data, error } = await v2.from("dam_keywords").insert(batch).select("id, path");
  if (error) die("inserting keywords", error);
  for (const k of data) idOfPath.set(k.path, k.id);
}
console.log(`  ${newKeywords.length} keywords created (${idOfPath.size} now exist across those categories)`);

// ---- write the links ---------------------------------------------------------
// Read what is already linked so a resumed run writes only the remainder. Only
// the keywords this stage owns are considered, so Stage 3's project links and
// any manual work are untouched.
const owned = new Set([...keywordByPath.keys()].map((p) => idOfPath.get(p)).filter(Boolean));
const already = new Set();
for (let from = 0; ; from += PAGE) {
  const { data, error } = await v2.from("dam_keyword_links")
    .select("keyword_id, target_id").eq("target_type", "asset").order("id").range(from, from + PAGE - 1);
  if (error) die("reading existing links", error);
  for (const r of data) if (owned.has(r.keyword_id)) already.add(`${r.keyword_id}:${r.target_id}`);
  if (data.length < PAGE) break;
}
const rows = [];
for (const [assetId, paths] of perAsset) {
  for (const p of paths) {
    const kid = idOfPath.get(p);
    if (!kid || already.has(`${kid}:${assetId}`)) continue;
    // weight 1.000, not a share. Stage 3 weighted a project's sector by how
    // many of its assets carried it, which is a real measurement. Here the tag
    // either was on the asset or was not; there is nothing to be fractional
    // about, and v1 recorded no confidence to carry over.
    rows.push({ keyword_id: kid, target_type: "asset", target_id: assetId, source: "migration", weight: 1.000 });
  }
}
console.log(`  ${already.size} links already present · ${rows.length} to write`);
let made = 0;
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await v2.from("dam_keyword_links").insert(rows.slice(i, i + 500));
  if (error) die(`inserting keyword links (batch starting ${i})`, error);
  made += Math.min(500, rows.length - i);
  if (made % 25000 < 500) console.log(`    ${made} / ${rows.length}`);
}
console.log(`\nwritten: ${newKeywords.length} keywords, ${made} asset-to-keyword links`);
