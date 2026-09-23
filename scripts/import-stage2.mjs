// Stage 2: turn the imported assets' folder paths into projects.
//
// Creates, from what Stage 1 already recorded:
//   dam_projects         one per distinct project, status 'unverified'
//   dam_project_aliases  one per folder_path, kind 'folder_path'
//   dam_external_ids     the OpenAsset code, on the PROJECT (never the asset —
//                        many assets share one code and the per-system unique
//                        index would collide)
//   dam_project_assets   every asset linked to its project, densely ranked
//
// GROUPING. A project is identified by its CODE where one parsed, so the same
// project reached by two folder paths — `_OpenAsset Projects/Singapore/12-65100
// Adani` and `dwp Projects/SINGAPORE/12-65100 Adani` — collapses to one project
// with two aliases rather than two projects with half the assets each. Where no
// code parsed, the key is (studio, lower(name)), which is the best available
// and is exactly why those rows land as 'unverified' with a needs_code flag.
//
// SAFETY
//   * Reads v2 only; v1 is not opened at all.
//   * Nothing written without --write.
//   * Idempotent: a folder_path already present in dam_project_aliases is
//     skipped, and an asset already linked is not re-linked.
//
// Usage:
//   node scripts/import-stage2.mjs            # dry run
//   node scripts/import-stage2.mjs --write
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { derivePath } from "./lib/derive.mjs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const WRITE = process.argv.includes("--write");
const REDERIVE = process.argv.includes("--rederive");
const PAGE = 1000, CONCURRENCY = 12;
const v2 = createClient(env.DAM_V2_SUPABASE_URL, env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const die = (what, e) => { console.error(`\n${what}:`, e?.message ?? e); process.exit(1); };
console.log(WRITE ? "MODE: WRITE\n" : "MODE: dry run — nothing will be written\n");

// ---- reference ------------------------------------------------------------
const { data: studios, error: se } = await v2.from("dam_studios").select("id, code, legacy_folder_names");
if (se) die("reading dam_studios", se);
const studioByFolder = new Map();
for (const s of studios) for (const f of s.legacy_folder_names ?? []) studioByFolder.set(f.toLowerCase(), s.id);

const { data: lvl, error: le } = await v2.from("dam_access_levels").select("id, slug").eq("is_default", true).single();
if (le) die("reading the default access level", le);
const DEFAULT_LEVEL = lvl.id;

// ---- every imported asset, with its path ----------------------------------
const assets = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await v2.from("dam_assets")
    .select("id, created_at, ingest_relative_path").order("id").range(from, from + PAGE - 1);
  if (error) die("reading dam_assets", error);
  assets.push(...data);
  if (data.length < PAGE) break;
}
console.log(`${assets.length} assets read`);

// Does re-derivation still agree with what Stage 1 recorded? If derive.mjs has
// changed, the grouping below would describe something other than what is in
// dam_assets.legacy.derived, and the two would quietly disagree forever.
//
// Drift is not always a mistake — fixing a derivation bug causes it on purpose.
// So it aborts by default and --rederive acknowledges it, which also refreshes
// the stored record so the blob keeps telling the truth.
{
  const { data: sample } = await v2.from("dam_assets").select("ingest_relative_path, legacy").limit(200);
  let drift = 0;
  for (const a of sample ?? []) {
    const rec = a.legacy?.derived, now = derivePath(a.ingest_relative_path);
    if (!rec) continue;
    if (rec.code !== now.code || rec.project !== now.project || rec.outcome !== now.outcome) drift++;
  }
  if (drift && !REDERIVE) {
    die("derivation drift", `${drift}/200 sampled assets derive differently now than at import.\n` +
      `  derive.mjs has changed since Stage 1. If that was deliberate, re-run with --rederive,\n` +
      `  which refreshes dam_assets.legacy.derived so the stored record matches the new rules.`);
  }
  console.log(drift
    ? `re-derivation differs for ${drift}/200 sampled — --rederive given, legacy.derived will be refreshed\n`
    : "re-derivation matches what Stage 1 recorded (200 sampled)\n");
}

// ---- group into projects ---------------------------------------------------
const projects = new Map();   // key -> { key, code, name, studioId, paths:Set, assets:[], openasset:bool, studios:Set }
let noProject = 0;
for (const a of assets) {
  const d = derivePath(a.ingest_relative_path);
  if (!d.project) { noProject++; continue; }
  const studioId = d.studioFolder ? studioByFolder.get(d.studioFolder.toLowerCase()) ?? null : null;
  const key = d.code ? `C:${d.code.toUpperCase()}` : `N:${studioId ?? "-"}:${d.project.toLowerCase()}`;
  let p = projects.get(key);
  if (!p) {
    p = { key, code: d.code ?? null, name: null, studioId, paths: new Set(), assets: [], openasset: false, studios: new Set() };
    projects.set(key, p);
  }
  // A name stripped to nothing (the folder was only a code) falls back to it.
  const nm = (d.project || d.code || "").trim().slice(0, 200);
  if (nm && (!p.name || nm.length > p.name.length)) p.name = nm;
  p.paths.add(a.ingest_relative_path);
  p.assets.push(a);
  if (d.collection === "_OpenAsset Projects") p.openasset = true;
  if (studioId) p.studios.add(studioId);
  if (!p.studioId && studioId) p.studioId = studioId;
}
const split = [...projects.values()].filter((p) => p.studios.size > 1);
console.log(`${projects.size} projects  ·  ${[...projects.values()].reduce((n, p) => n + p.paths.size, 0)} folder paths  ·  ${assets.length - noProject} assets to link`);
console.log(`${noProject} assets have no project (Marketing Hub, content buckets, unresolved)`);
console.log(`${[...projects.values()].filter((p) => !p.code).length} projects have no code  ·  ${split.length} span more than one studio\n`);

// ---- what already exists ---------------------------------------------------
const existingAlias = new Map();     // lower(path) -> project_id
for (let from = 0; ; from += PAGE) {
  const { data, error } = await v2.from("dam_project_aliases")
    .select("alias, project_id").eq("kind", "folder_path").order("id").range(from, from + PAGE - 1);
  if (error) die("reading dam_project_aliases", error);
  for (const r of data) existingAlias.set(r.alias.toLowerCase(), r.project_id);
  if (data.length < PAGE) break;
}
const linked = new Set();
for (let from = 0; ; from += PAGE) {
  const { data, error } = await v2.from("dam_project_assets").select("asset_id").order("id").range(from, from + PAGE - 1);
  if (error) die("reading dam_project_assets", error);
  for (const r of data) linked.add(r.asset_id);
  if (data.length < PAGE) break;
}
if (existingAlias.size || linked.size) console.log(`resuming: ${existingAlias.size} aliases and ${linked.size} links already present\n`);

const todo = [...projects.values()].filter((p) => ![...p.paths].every((x) => existingAlias.has(x.toLowerCase())));

if (!WRITE) {
  const rows = [...projects.values()].sort((a, b) => b.assets.length - a.assets.length);
  writeFileSync("scripts/v1-projects-preview.csv",
    ["code,name,studio,paths,assets,openasset"].concat(rows.map((p) =>
      [p.code ?? "", p.name ?? "", studios.find((s) => s.id === p.studioId)?.code ?? "", p.paths.size, p.assets.length, p.openasset]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))).join("\n"), "utf8");
  console.log(`would create ${todo.length} projects, ${[...projects.values()].reduce((n,p)=>n+p.paths.size,0)} aliases, ${assets.length - noProject - linked.size} links`);
  console.log("wrote scripts/v1-projects-preview.csv");
  console.log("\ntop 10 by asset count:");
  for (const p of rows.slice(0, 10)) console.log(`  ${(p.code ?? "—").padEnd(16)} ${String(p.assets.length).padStart(5)} assets  ${p.paths.size} path(s)  ${p.name}`);
  console.log("\ndry run — nothing written. Re-run with --write.");
  process.exit(0);
}

// ---- write -----------------------------------------------------------------

// --rederive: bring dam_assets.legacy.derived back in line with the rules that
// are about to create the projects, so the blob does not sit there describing a
// grouping that never happened.
//
// ONLY the rows that actually changed. Rewriting all 34,949 would fire the
// audit trigger 34,949 times, and each audit row stores a full before and after
// image of the asset — roughly 140 MB to refresh a convenience field. Touching
// only what moved costs a tenth of that.
if (REDERIVE) {
  const stale = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await v2.from("dam_assets")
      .select("id, ingest_relative_path, legacy").order("id").range(from, from + PAGE - 1);
    if (error) die("reading legacy blobs", error);
    for (const a of data) {
      const rec = a.legacy?.derived; if (!rec) continue;
      const d = derivePath(a.ingest_relative_path);
      const now = { collection: d.collection, studio_folder: d.studioFolder, sector: d.sector ?? null,
                    code: d.code, project: d.project, outcome: d.outcome };
      if (JSON.stringify(rec) !== JSON.stringify(now)) stale.push({ id: a.id, legacy: { ...a.legacy, derived: now } });
    }
    if (data.length < PAGE) break;
  }
  console.log(`refreshing legacy.derived on ${stale.length} of ${assets.length} assets`);
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    const res = await Promise.all(stale.slice(i, i + CONCURRENCY)
      .map((r) => v2.from("dam_assets").update({ legacy: r.legacy }).eq("id", r.id)));
    for (const r of res) if (r.error) die("refreshing legacy.derived", r.error);
  }
  console.log("legacy.derived is current");
}
const CHUNK = 250;
let madeProjects = 0, madeAliases = 0, madeIds = 0, madeLinks = 0;

for (let i = 0; i < todo.length; i += CHUNK) {
  const batch = todo.slice(i, i + CHUNK);

  const { data: created, error: pe } = await v2.from("dam_projects").insert(batch.map((p) => ({
    code: p.code, code_source: p.code ? "folder" : null,
    name: p.name, studio_id: p.studioId,
    access_level_id: DEFAULT_LEVEL,
    status: "unverified",                       // D-212: the entry state for folder-derived rows
    legacy_code: p.code, legacy_folder_path: [...p.paths][0],
    flags: [...(p.code ? [] : ["needs_code"]), ...(p.studios.size > 1 ? ["sector_conflict"] : [])],
  }))).select("id, code, name");
  if (pe) die(`inserting projects at ${i}`, pe);
  madeProjects += created.length;
  batch.forEach((p, k) => { p.id = created[k].id; });

  const aliases = batch.flatMap((p) => [...p.paths]
    .filter((x) => !existingAlias.has(x.toLowerCase()))
    .map((x) => ({ project_id: p.id, alias: x, kind: "folder_path", source: "migration", is_verified: false })));
  if (aliases.length) {
    const { error } = await v2.from("dam_project_aliases").insert(aliases);
    if (error) die("inserting aliases", error);
    madeAliases += aliases.length;
  }

  const oa = batch.filter((p) => p.openasset && p.code)
    .map((p) => ({ target_type: "project", target_id: p.id, system: "openasset", external_id: p.code }));
  if (oa.length) {
    const { error } = await v2.from("dam_external_ids").insert(oa);
    if (error) die("inserting OpenAsset project ids", error);
    madeIds += oa.length;
  }

  // Links, densely ranked 1..n per project in the assets' own creation order.
  const links = batch.flatMap((p) => p.assets
    .filter((a) => !linked.has(a.id))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    .map((a, n) => ({ project_id: p.id, asset_id: a.id, rank: n + 1, source: "migration" })));
  for (let j = 0; j < links.length; j += 500) {
    const { error } = await v2.from("dam_project_assets").insert(links.slice(j, j + 500));
    if (error) die("inserting project-asset links", error);
    madeLinks += Math.min(500, links.length - j);
  }
  console.log(`  projects ${madeProjects}  aliases ${madeAliases}  links ${madeLinks}`);
}

console.log(`\nwritten: ${madeProjects} projects, ${madeAliases} aliases, ${madeIds} OpenAsset ids, ${madeLinks} links`);
