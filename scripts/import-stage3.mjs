// Stage 3: the sector taxonomy, on the projects.
//
// v1 recorded macro_portfolio / core_sector / sub_sectors on the ASSET. v2 puts
// sector on the PROJECT, so this builds the three-level Sector tree as project
// keywords and rolls each project's assets up onto it.
//
// Creates:
//   dam_keywords       the Sector tree in the 'project' namespace, 3 levels,
//                      under the seeded Sector keyword category
//   dam_keyword_links  project -> sector, weighted by the share of that
//                      project's assets carrying it. weight is exactly what
//                      the column is for: a project whose every asset says
//                      Hospitality gets 1.000, a single mis-tagged asset in a
//                      500-asset project gets 0.002 and is visibly a stray.
//
// Only values that appear in the real taxonomy become sectors. v1 also wrote
// preset GROUP names into those columns — Brand Activation, Staff & Culture,
// Portrait Style Variant — and they are counted and reported, never linked.
//
// Free-text v1 `tags` are asset-level and are NOT touched here.
//
// Usage:
//   node scripts/import-stage3.mjs            # dry run
//   node scripts/import-stage3.mjs --write
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

// ---- the taxonomy, from the v1 schema's own seed rows ----------------------
const taxonomy = [...readFileSync("supabase/schema.sql", "utf8")
  .matchAll(/^\s*\('([^']+)','([^']+)','([^']+)'\),?$/gm)]
  .map((m) => ({ macro: m[1], core: m[2], sub: m[3] }))
  .filter((r) => r.macro && r.core && r.sub);
if (taxonomy.length < 40) die("taxonomy", `only parsed ${taxonomy.length} rows from supabase/schema.sql`);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const VALID_MACRO = new Set(taxonomy.map((r) => r.macro));
const VALID_CORE = new Set(taxonomy.map((r) => r.core));
const VALID_SUB = new Set(taxonomy.map((r) => r.sub));
console.log(`taxonomy: ${VALID_MACRO.size} macro · ${VALID_CORE.size} core · ${VALID_SUB.size} sub (${taxonomy.length} rows)\n`);

// ---- the seeded Sector keyword category ------------------------------------
const { data: cat, error: ce } = await v2.from("dam_keyword_categories")
  .select("id, name, namespace, max_depth").eq("namespace", "project").eq("slug", "sector").single();
if (ce) die("finding the Sector keyword category", ce);
if (cat.max_depth < 3) die("Sector category", `max_depth is ${cat.max_depth}, the tree needs 3`);

// ---- build the tree ---------------------------------------------------------
// name -> { level, parentName }. Built from the taxonomy, deduplicated.
const nodes = new Map();
for (const r of taxonomy) {
  if (!nodes.has(r.macro)) nodes.set(r.macro, { name: r.macro, depth: 1, parent: null });
  const coreKey = `${r.macro}/${r.core}`;
  if (!nodes.has(coreKey)) nodes.set(coreKey, { name: r.core, depth: 2, parent: r.macro });
  const subKey = `${r.macro}/${r.core}/${r.sub}`;
  if (!nodes.has(subKey)) nodes.set(subKey, { name: r.sub, depth: 3, parent: coreKey });
}
console.log(`${nodes.size} sector keywords to exist\n`);

// ---- what each project's assets say ----------------------------------------
const linked = new Map();   // project_id -> Map(sectorKey -> assetCount)
const perProject = new Map();
const rejected = {};
{
  const byAsset = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await v2.from("dam_assets").select("id, legacy").order("id").range(from, from + PAGE - 1);
    if (error) die("reading assets", error);
    for (const a of data) byAsset.set(a.id, a.legacy ?? {});
    if (data.length < PAGE) break;
  }
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await v2.from("dam_project_assets").select("project_id, asset_id").order("id").range(from, from + PAGE - 1);
    if (error) die("reading project links", error);
    for (const l of data) {
      const L = byAsset.get(l.asset_id); if (!L) continue;
      perProject.set(l.project_id, (perProject.get(l.project_id) ?? 0) + 1);
      const keys = [];
      const macro = L.macro_portfolio, core = L.core_sector;
      if (macro && VALID_MACRO.has(macro)) keys.push(macro);
      else if (macro) rejected[macro] = (rejected[macro] ?? 0) + 1;
      if (macro && core && VALID_CORE.has(core) && nodes.has(`${macro}/${core}`)) keys.push(`${macro}/${core}`);
      else if (core && !VALID_CORE.has(core)) rejected[core] = (rejected[core] ?? 0) + 1;
      for (const s of L.sub_sectors ?? []) {
        const k = `${macro}/${core}/${s}`;
        if (VALID_SUB.has(s) && nodes.has(k)) keys.push(k);
        else if (s) rejected[s] = (rejected[s] ?? 0) + 1;
      }
      if (!linked.has(l.project_id)) linked.set(l.project_id, new Map());
      const m = linked.get(l.project_id);
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
  }
}
const totalLinks = [...linked.values()].reduce((n, m) => n + m.size, 0);
console.log(`${linked.size} projects carry a sector · ${totalLinks} project-to-sector links\n`);

const show = (t, o) => { console.log(t); for (const [k, v] of Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(v).padStart(6)}  ${k}`); console.log(); };
if (Object.keys(rejected).length) show("NOT a sector — counted, never linked (preset group names in v1's sector columns):", rejected);

if (!WRITE) {
  const dist = {}, band = {};
  for (const [pid, m] of linked) {
    const total = perProject.get(pid) || 1;
    for (const [k, n] of m) {
      dist[k.split("/")[0]] = (dist[k.split("/")[0]] ?? 0) + 1;
      const w = n / total;
      const b = w >= 0.9 ? "0.9-1.0  the project is this"
              : w >= 0.5 ? "0.5-0.9  dominant"
              : w >= 0.2 ? "0.2-0.5  a real secondary sector"
              : w >= 0.05 ? "0.05-0.2 minor"
              : "<0.05    almost certainly a mis-tagged asset";
      band[b] = (band[b] ?? 0) + 1;
    }
  }
  show("LINKS by macro portfolio:", dist);
  console.log("LINK WEIGHT — the share of a project's assets carrying that sector");
  for (const [k, v] of Object.entries(band).sort()) console.log(`  ${String(v).padStart(6)}  ${k}`);
  console.log();
  console.log("dry run — nothing written. Re-run with --write.");
  process.exit(0);
}

// ---- write the tree ---------------------------------------------------------
const idOf = new Map();
{
  const { data: existing } = await v2.from("dam_keywords").select("id, path").eq("category_id", cat.id);
  for (const k of existing ?? []) idOf.set(k.path, k.id);
}
for (const depth of [1, 2, 3]) {
  const batch = [...nodes.entries()].filter(([, n]) => n.depth === depth).map(([key, n]) => {
    const parentPath = n.parent ? pathOf(n.parent) : null;
    const path = (parentPath ? parentPath + "/" : "") + slug(n.name);
    return { key, path, row: {
      namespace: "project", category_id: cat.id,
      parent_id: n.parent ? idOf.get(parentPath) ?? null : null,
      name: n.name, slug: slug(n.name), path, depth: n.depth,
      source: "migration",
    } };
  }).filter((b) => !idOf.has(b.path));
  if (!batch.length) continue;
  const { data, error } = await v2.from("dam_keywords").insert(batch.map((b) => b.row)).select("id, path");
  if (error) die(`inserting depth-${depth} keywords`, error);
  for (const k of data) idOf.set(k.path, k.id);
  console.log(`  depth ${depth}: ${data.length} keywords`);
}
function pathOf(key) {
  const n = nodes.get(key); if (!n) return null;
  return (n.parent ? pathOf(n.parent) + "/" : "") + slug(n.name);
}

// ---- write the links --------------------------------------------------------
const already = new Set();
for (let from = 0; ; from += PAGE) {
  const { data, error } = await v2.from("dam_keyword_links").select("keyword_id, target_id").eq("target_type", "project").order("id").range(from, from + PAGE - 1);
  if (error) die("reading existing links", error);
  for (const r of data) already.add(`${r.keyword_id}:${r.target_id}`);
  if (data.length < PAGE) break;
}
const rows = [];
for (const [projectId, m] of linked) {
  const total = perProject.get(projectId) || 1;
  for (const [key, n] of m) {
    const kid = idOf.get(pathOf(key)); if (!kid) continue;
    if (already.has(`${kid}:${projectId}`)) continue;
    // weight = the share of this project's assets carrying the sector, so a
    // stray mis-tagged asset is visibly a stray rather than an equal claim.
    rows.push({ keyword_id: kid, target_type: "project", target_id: projectId,
                source: "migration", weight: Math.max(0.001, Math.min(1, n / total)).toFixed(3) });
  }
}
let made = 0;
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await v2.from("dam_keyword_links").insert(rows.slice(i, i + 500));
  if (error) die("inserting keyword links", error);
  made += Math.min(500, rows.length - i);
}
console.log(`\nwritten: ${idOf.size} sector keywords, ${made} project-to-sector links`);
