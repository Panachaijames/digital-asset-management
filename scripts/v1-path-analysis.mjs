// Can folder_path be turned into projects by script, or does it need a human?
//
// Reads every folder_path out of v1 (read-only), parses it per collection, and
// reports how many paths yield a usable project — a code, a name, a studio —
// and how many do not. Writes nothing to either database.
//
// The answer decides whether the Stage 2 derivation is a script with a review
// pass or a data-cleaning project.
//
// Usage:  node scripts/v1-path-analysis.mjs [--list]
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
const v1 = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

// ---- read every path (paginated; PostgREST caps a page at 1000) ------------
const paths = new Map(); // folder_path -> asset count
for (let from = 0; ; from += 1000) {
  const { data, error } = await v1
    .from("common_dam_assets")
    .select("folder_path")
    .order("folder_path")
    .range(from, from + 999);
  if (error) { console.error(error); process.exit(1); }
  if (!data.length) break;
  for (const r of data) paths.set(r.folder_path, (paths.get(r.folder_path) ?? 0) + 1);
  if (data.length < 1000) break;
}
const totalAssets = [...paths.values()].reduce((a, b) => a + b, 0);
console.log(`${paths.size} distinct paths, ${totalAssets} assets\n`);

// ---- project-code shapes seen in the sample --------------------------------
// 007639 - Yallambee Lodge | 0306-04 Pacific Eye Centre | 202336 Reliance…
// VNHCM-15-0036 Marie Curie ID | 23-0126 Informa Office Bahrain
// Widened after looking at the first pass: the narrow set missed S6879,
// S21810, 12-65100, 10064 and 5002779, which pushed real projects into the
// "no code" bucket. Order matters — the dashed forms must be tried before the
// bare numeric one, or `0306-04` parses as `0306`.
const CODE = [
  { name: "studio-prefixed", re: /^([A-Z]{2,6}-\d{2}-\d{3,5})\b/ },   // VNHCM-15-0036
  { name: "yy-nnnnn",        re: /^(\d{2}-\d{4,5})\b/ },              // 23-0126, 12-65100
  { name: "nnnn-nn",         re: /^(\d{4}-\d{2})\b/ },                // 0306-04
  { name: "letter-prefixed", re: /^([A-Z]\d{4,6})\b/ },               // S6879, S21810, M21935
  { name: "numeric",         re: /^(\d{4,7})\b/ },                    // 007639, 202336, 5002779
];
const parseCode = (seg) => {
  if (!seg) return null;
  for (const c of CODE) {
    const m = seg.match(c.re);
    if (m) return { code: m[1], shape: c.name, name: seg.slice(m[1].length).replace(/^[\s\-–—_]+/, "").trim() };
  }
  return null;
};

// Google Takeout / Drive-download artefacts: "…-20260409T084946Z-3-001"
const TAKEOUT = /-\d{8}T\d{6}Z-\d+-\d+$/;
// Subfolders that are clearly not a project
const LEAF = /^(photos?|images?|renders?|renderings?|drawings?|logos?|brand assets.*|final|finals|selects?|hi-?res|low-?res|reduced file size.*|for (award|press|web).*|archive[d]?)$/i;

const COUNTRY = new Set(["australia","bahrain","thailand","china","uae","vietnam","hong kong","united kingdom","uk",
  "malaysia","myanmar","new zealand","philippines","manila","saudi arabia","ksa","singapore","usa","united states",
  "aus_archived","indonesia","india","qatar","oman","japan","korea","taiwan","cambodia","laos"]);

const rows = [];
for (const [path, assets] of paths) {
  const seg = path.split("/");
  const collection = seg[1] ?? "";
  const rest = seg.slice(2);

  let studio = null, projSeg = null, note = "";

  if (collection === "Marketing Hub" || collection === "Portfolio" || collection === "Proposal") {
    rows.push({ path, assets, collection, studio: null, code: null, project: null, outcome: "no-project (by design)" });
    continue;
  }
  if (!collection) {
    rows.push({ path, assets, collection: "(root)", studio: null, code: null, project: null, outcome: "orphan" });
    continue;
  }
  // A segment starting with "_" directly under a project collection is a
  // content bucket, not a project — `_dwp Videos` holds events and showreels,
  // not client work. Its children are occasions, so nothing here becomes a
  // project and the assets keep their studio only.
  if (rest[0]?.startsWith("_")) {
    rows.push({ path, assets, collection, studio: null, code: null,
                project: null, outcome: "no-project (content bucket)" });
    continue;
  }

  // First segment after the collection that looks like a country is the studio.
  const ci = rest.findIndex((s) => COUNTRY.has(s.trim().toLowerCase()));
  if (ci >= 0) { studio = rest[ci]; projSeg = rest.slice(ci + 1); } else { projSeg = rest; note = "no country segment"; }

  // Drop trailing leaf folders and Takeout wrappers, then take the first
  // remaining segment that yields a code, else the first non-leaf segment.
  const cand = projSeg.filter((s) => !LEAF.test(s.trim()));
  let picked = null, parsed = null;
  for (const s of cand) {
    const clean = s.replace(TAKEOUT, "");
    const p = parseCode(clean);
    if (p) { picked = clean; parsed = p; break; }
  }
  if (!picked && cand.length) picked = cand[0].replace(TAKEOUT, "");

  rows.push({
    path, assets, collection, studio,
    code: parsed?.code ?? null,
    shape: parsed?.shape ?? null,
    project: parsed?.name || picked || null,
    outcome: parsed ? "code + name" : picked ? "name only (unverified, no code)" : "NO PROJECT",
    note,
  });
}

// ---- report ---------------------------------------------------------------
const by = (f) => rows.reduce((m, r) => { const k = f(r); (m[k] ??= { paths: 0, assets: 0 }); m[k].paths++; m[k].assets += r.assets; return m; }, {});
const table = (title, obj) => {
  console.log(title);
  for (const [k, v] of Object.entries(obj).sort((a, b) => b[1].assets - a[1].assets)) {
    console.log(`  ${String(k).padEnd(34)} ${String(v.paths).padStart(5)} paths  ${String(v.assets).padStart(6)} assets`);
  }
  console.log();
};

table("OUTCOME", by((r) => r.outcome));
table("BY COLLECTION", by((r) => r.collection));
table("CODE SHAPE (where a code parsed)", by((r) => r.shape ?? "—"));
table("STUDIO SEGMENT", by((r) => r.studio ?? "(none found)"));

const withCode = rows.filter((r) => r.code);
const distinctCodes = new Set(withCode.map((r) => r.code));
const named = rows.filter((r) => !r.code && r.project);
const distinctNames = new Set(named.map((r) => r.project.toLowerCase()));
console.log(`distinct project CODES parsed : ${distinctCodes.size}`);
console.log(`distinct code-less project NAMES: ${distinctNames.size}`);
console.log(`estimated projects to create   : ~${distinctCodes.size + distinctNames.size}`);

if (process.argv.includes("--list")) {
  const csv = ["folder_path,assets,collection,studio,code,project,outcome"]
    .concat(rows.sort((a, b) => b.assets - a.assets).map((r) =>
      [r.path, r.assets, r.collection, r.studio ?? "", r.code ?? "", r.project ?? "", r.outcome]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")));
  writeFileSync("scripts/v1-path-derivation.csv", csv.join("\n"), "utf8");
  console.log(`\nwrote scripts/v1-path-derivation.csv (${rows.length} rows) for review`);
}
