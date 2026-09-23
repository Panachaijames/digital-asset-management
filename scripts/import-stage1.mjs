// Stage 1 of the v1 -> v2 library import: assets, versions, external ids.
//
// No projects, no keywords, no judgement. Every value written here is either
// copied from v1 or derived by scripts/lib/derive.mjs, which is the same module
// that produces the CSV a human reviews.
//
// SAFETY
//   * v1 is opened with the ANON key and only ever SELECTed.
//   * Nothing is written unless --write is passed. The default is a dry run.
//   * Idempotent and restartable: every asset is keyed by its v1 uuid in
//     dam_external_ids (system 'dwp_dam_v1'), and a page skips ids already
//     present. A crash at row 20,000 resumes from row 20,000.
//
// WHAT IT WRITES, PER v1 ASSET
//   dam_assets            1 row
//   dam_asset_versions    1 row  (version_no 1, object_key = drive_file_id)
//   dam_assets UPDATE     sets current_version_id + version_count
//   dam_external_ids      2 rows (dwp_dam_v1 = the v1 uuid, google_drive = the
//                                 Drive file id)
//
// The OpenAsset project code is deliberately NOT written here. It identifies a
// PROJECT, and many assets share one; writing it per asset would collide on
// dam_external_ids_system_external_id_key. It belongs to Stage 2.
//
// Usage:
//   node scripts/import-stage1.mjs                  # dry run, writes nothing
//   node scripts/import-stage1.mjs --write          # perform the import
//   node scripts/import-stage1.mjs --write --limit 500
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { derivePath, fileKindFor, categorySlugFor } from "./lib/derive.mjs";

// ---- environment -----------------------------------------------------------
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const WRITE = process.argv.includes("--write");
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i > 0 ? Number(process.argv[i + 1]) : Infinity; })();
const PAGE = 1000;
const CHUNK = 200;   // .in() list size — beyond ~200 the GET URL is rejected

const v1 = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const v2 = createClient(env.DAM_V2_SUPABASE_URL, env.DAM_V2_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ref = (u) => { try { return new URL(u).host.split(".")[0]; } catch { return "?"; } };
if (ref(env.SUPABASE_URL) === ref(env.DAM_V2_SUPABASE_URL)) {
  console.error("REFUSING: source and target are the same project."); process.exit(2);
}
const die = (what, e) => { console.error(`\n${what}:`, e?.message ?? e); process.exit(1); };

console.log(`source ${ref(env.SUPABASE_URL)} (read-only)  ->  target ${ref(env.DAM_V2_SUPABASE_URL)}`);
console.log(WRITE ? "MODE: WRITE\n" : "MODE: dry run — nothing will be written\n");

// ---- reference data from v2 -----------------------------------------------
const { data: studios, error: se } = await v2.from("dam_studios").select("id, code, legacy_folder_names");
if (se) die("reading dam_studios", se);
const studioByFolder = new Map();
for (const s of studios) for (const f of s.legacy_folder_names ?? []) studioByFolder.set(f.toLowerCase(), s.id);

const { data: cats, error: ce } = await v2.from("dam_categories").select("id, slug");
if (ce) die("reading dam_categories", ce);
const categoryBySlug = new Map(cats.map((c) => [c.slug, c.id]));

// ---- the storage location every version points at --------------------------
const LOC_SLUG = "drive-dwp-digital-asset";
let locationId = null;
{
  const { data } = await v2.from("dam_storage_locations").select("id").eq("slug", LOC_SLUG).maybeSingle();
  if (data) locationId = data.id;
  else if (WRITE) {
    const { data: made, error } = await v2.from("dam_storage_locations").insert({
      name: "Drive — dwp_Digital_Asset",
      slug: LOC_SLUG,
      provider: "google_drive",
      tier: "hot",
      // container is the Shared Drive id and root_key the subtree folder id;
      // neither is in v1, and both are nullable. They can be filled in later
      // without touching a single version row, because a version addresses its
      // object by (storage_location_id, object_key) and object_key is the Drive
      // fileId — which is already globally unique.
      is_default_originals: true,
      allow_register_in_place: true,   // the corpus already lives here; nothing is copied
      notes: "Registered in place by the v1 import. Objects are addressed by Drive fileId.",
    }).select("id").single();
    if (error) die("creating the storage location", error);
    locationId = made.id;
    console.log(`created dam_storage_locations "${LOC_SLUG}"\n`);
  }
}
if (!locationId && WRITE) die("storage location", "could not resolve or create it");

// ---- walk v1 ---------------------------------------------------------------
const stat = { seen: 0, skipped: 0, assets: 0, versions: 0, extIds: 0 };
const outcomes = {}, statuses = {}, categories = {}, unknownStudio = new Map();
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

// v1's publish_permission is NOT a lifecycle. It only ever meant "may this go
// outside", and its observed values are pending (34,485), granted (463) and
// restricted (1) — the 34,485 being the column default that nobody ever
// changed. So v1 carries no review state at all, and the question is what a
// library already in production use should arrive as.
//
// It must NOT be 'pending'. dam_can_read_asset() hides a pending asset from
// anyone who is neither its creator nor an editor, and every imported asset has
// created_by = null because v1 has no user records. Importing as pending would
// make the whole library invisible to viewers and contributors on day one.
//
// So: 'approved' — reviewed and cleared, which is what four consumer sites
// serving these files for years amounts to. NOT 'published': D-005 makes
// publishing a separate explicit act. The single 'restricted' row is a rights
// concern rather than a lifecycle one, so it lands pending and flagged for a
// human. This is one UPDATE to reverse if you disagree.
const STATUS_FOR = (perm) => {
  switch (String(perm ?? "").toLowerCase()) {
    case "restricted": return "pending";
    case "rejected": case "denied": return "rejected";
    default: return "approved";   // pending (the untouched default) and granted
  }
};

const titleFrom = (name) =>
  String(name ?? "").replace(/\.[A-Za-z0-9]{1,6}$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || null;

for (let from = 0; from < LIMIT; from += PAGE) {
  const to = Math.min(from + PAGE, LIMIT) - 1;
  const { data: rows, error } = await v1.from("common_dam_assets")
    .select("id, drive_file_id, name, folder_id, folder_path, tags, macro_portfolio, core_sector, sub_sectors, mime_type, size_bytes, web_view_link, uploaded_by, publish_permission, created_at")
    .order("id").range(from, to);
  if (error) die("reading v1", error);
  if (!rows.length) break;
  stat.seen += rows.length;

  // Which of these are already imported? Chunked — a long .in() list makes an
  // oversized GET URL that PostgREST rejects.
  const already = new Set();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ids = rows.slice(i, i + CHUNK).map((r) => r.id);
    const { data, error } = await v2.from("dam_external_ids")
      .select("external_id").eq("system", "dwp_dam_v1").in("external_id", ids);
    if (error) die("checking already-imported ids", error);
    for (const r of data) already.add(r.external_id);
  }

  const todo = rows.filter((r) => !already.has(r.id));
  stat.skipped += rows.length - todo.length;
  if (!todo.length) { if (rows.length < PAGE) break; continue; }

  // ---- shape the rows
  const assetRows = todo.map((r) => {
    const d = derivePath(r.folder_path);
    bump(outcomes, d.outcome);
    bump(statuses, String(r.publish_permission ?? "(null)"));
    const slug = categorySlugFor(r.folder_path, d.collection);
    bump(categories, slug);
    const studioId = d.studioFolder ? studioByFolder.get(d.studioFolder.toLowerCase()) ?? null : null;
    if (d.studioFolder && !studioId) unknownStudio.set(d.studioFolder, (unknownStudio.get(d.studioFolder) ?? 0) + 1);

    return {
      filename: r.name,
      title: titleFrom(r.name),
      title_source: "filename",
      category_id: categoryBySlug.get(slug),
      status: STATUS_FOR(r.publish_permission),
      studio_id: studioId,
      file_kind: fileKindFor(r.mime_type),
      mime_type: r.mime_type,
      size_bytes: r.size_bytes ?? 0,
      created_at: r.created_at,
      ingest_relative_path: r.folder_path,
      // D-238: migration evidence in one blob rather than six dead columns.
      legacy: {
        folder_id: r.folder_id, folder_path: r.folder_path, web_view_link: r.web_view_link,
        publish_permission: r.publish_permission, uploaded_by: r.uploaded_by,
        tags: r.tags ?? [], macro_portfolio: r.macro_portfolio ?? null,
        core_sector: r.core_sector ?? null, sub_sectors: r.sub_sectors ?? [],
        derived: { collection: d.collection, studio_folder: d.studioFolder, code: d.code, project: d.project, outcome: d.outcome },
      },
      flags: [
        ...(d.outcome.startsWith("code") || d.outcome.startsWith("name") ? [] : ["needs_project"]),
        // v1 said this one may not be published freely; v2 records rights on
        // dam_asset_rights, which Stage 1 does not write, so flag it rather
        // than let the fact disappear into the legacy blob.
        ...(String(r.publish_permission ?? "").toLowerCase() === "restricted" ? ["needs_review"] : []),
      ],
      _v1: r,   // stripped before insert
    };
  });

  if (!WRITE) {
    stat.assets += assetRows.length; stat.versions += assetRows.length; stat.extIds += assetRows.length * 2;
    if (rows.length < PAGE) break;
    continue;
  }

  // ---- write: assets, then versions, then the back-pointer, then ids
  const payload = assetRows.map(({ _v1, ...a }) => a);
  const { data: made, error: ae } = await v2.from("dam_assets").insert(payload).select("id, filename, ingest_relative_path");
  if (ae) die(`inserting assets at offset ${from}`, ae);
  stat.assets += made.length;

  const versions = made.map((a, i) => ({
    asset_id: a.id, version_no: 1, storage_location_id: locationId,
    object_key: assetRows[i]._v1.drive_file_id,
    original_filename: assetRows[i]._v1.name,
    mime_type: assetRows[i]._v1.mime_type,
    size_bytes: assetRows[i]._v1.size_bytes ?? 0,
    provider_url: assetRows[i]._v1.web_view_link,
    object_container: "dwp_Digital_Asset",
  }));
  const { data: vmade, error: ve } = await v2.from("dam_asset_versions").insert(versions).select("id, asset_id");
  if (ve) die(`inserting versions at offset ${from}`, ve);
  stat.versions += vmade.length;

  // The asset points at its current version and the version points back at its
  // asset, so this back-pointer cannot be part of either insert: the FK would
  // reference a row that does not exist yet. It is one UPDATE per asset by
  // necessity — but serially that is 34,949 round trips, about half an hour of
  // pure latency, so they go out in bounded batches.
  const CONCURRENCY = 12;
  for (let i = 0; i < vmade.length; i += CONCURRENCY) {
    const results = await Promise.all(
      vmade.slice(i, i + CONCURRENCY).map((v) =>
        v2.from("dam_assets").update({ current_version_id: v.id, version_count: 1 }).eq("id", v.asset_id))
    );
    for (const r of results) if (r.error) die("setting current_version_id", r.error);
  }

  const extIds = made.flatMap((a, i) => {
    const r = assetRows[i]._v1;
    return [
      { target_type: "asset", target_id: a.id, system: "dwp_dam_v1", external_id: r.id },
      { target_type: "asset", target_id: a.id, system: "google_drive", external_id: r.drive_file_id,
        external_url: /^https?:\/\//.test(r.web_view_link ?? "") ? r.web_view_link : null },
    ];
  });
  const { error: ee } = await v2.from("dam_external_ids").insert(extIds);
  if (ee) die(`inserting external ids at offset ${from}`, ee);
  stat.extIds += extIds.length;

  console.log(`  ${String(from + rows.length).padStart(6)} / read   assets ${stat.assets}  versions ${stat.versions}  ids ${stat.extIds}`);
  if (rows.length < PAGE) break;
}

// ---- report ----------------------------------------------------------------
const show = (t, o) => { console.log(`\n${t}`); for (const [k, v] of Object.entries(o).sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(36)} ${v}`); };
console.log(`\nv1 rows read        ${stat.seen}`);
console.log(`already imported    ${stat.skipped}`);
console.log(`${WRITE ? "written" : "would write"}: ${stat.assets} assets, ${stat.versions} versions, ${stat.extIds} external ids  (${stat.assets + stat.versions + stat.extIds} rows)`);
show("PROJECT DERIVATION (recorded in legacy.derived; no projects created yet)", outcomes);
show("v1 publish_permission -> dam_asset_status", statuses);
show("CATEGORY ASSIGNED", categories);
if (unknownStudio.size) show("STUDIO FOLDER WITH NO MATCH in dam_studios.legacy_folder_names", Object.fromEntries(unknownStudio));
else console.log("\nevery studio folder resolved to a seeded studio");
if (!WRITE) console.log("\ndry run — nothing was written. Re-run with --write to perform the import.");
