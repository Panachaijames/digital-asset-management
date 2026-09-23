import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { studioPathFilter } from "@/lib/studios";

// GET /api/assets?tags=exterior,bangkok&q=lobby&macro=Lifestyle&core=Hospitality&sub=Luxury+Resort&path=Drive/ProjectX&studio=bangkok&sort=newest&limit=60
// tags:       comma-separated — returns assets that have ALL listed tags
// macro:      exact Macro Portfolio match
// core:       exact Core Sector match
// sub:        comma-separated Sub-Sectors — returns assets that have ALL of them
// q:          matches against the asset name (case-insensitive, partial)
// path:       exact folder_path match (current-folder view)
// pathPrefix: folder_path prefix match (folder + its subtree; client refines)
// studio:     a dwp studio / project location id from lib/studios.ts
//             ("bangkok", "dubai", …) — matched against the location folder in
//             folder_path. An unknown id is ignored, like `permission` below.
// sort:       newest (default) | oldest
// limit:      page size, 1-1000 (default 60) — Supabase caps any single
//             select at 1000 rows, so a larger value would truncate silently
// offset:     rows to skip, for paging (default 0). Safe to page with because
//             of the `id` tiebreaker below; without it created_at ties would
//             duplicate and drop rows across pages.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tagsParam = params.get("tags");
  const macro = params.get("macro");
  const core = params.get("core");
  const subParam = params.get("sub");
  const q = params.get("q");
  const path = params.get("path");
  const pathPrefix = params.get("pathPrefix");
  const studioFilter = studioPathFilter(params.get("studio"));
  const sort = params.get("sort");
  const permission = params.get("permission");
  // Parsed defensively: Number("abc") is NaN, and .range(0, NaN) is not a page
  // but a 500 from PostgREST.
  const limit = clampInt(params.get("limit"), 60, 1, 1000);
  const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  // count: "exact" rides along in the same round trip (~80ms on the widest
  // studio filter, nothing measurable unfiltered) and tells the client how
  // many rows the filters actually match, not just how many fitted in `limit`.
  // A broad filter — any studio — matches thousands, so without this the grid
  // shows 60 and looks complete. "planned"/"estimated" were 7% out and would
  // put a wrong number on screen.
  // created_at ties come in groups of ~100 (one import batch, one insert), so
  // which 60 rows count as "the newest 60" would otherwise shuffle between
  // refreshes of the same query — and, now that this route pages, duplicate
  // rows onto page 2 while dropping others entirely. `id` pins it, and keeps
  // the first page identical to /api/v1's.
  let query = supabaseAdmin
    .from("common_dam_assets")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: sort === "oldest" })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (permission && ["granted", "pending", "restricted"].includes(permission)) {
    query = query.eq("publish_permission", permission);
  }

  if (path) {
    query = query.eq("folder_path", path);
  } else if (pathPrefix && !pathPrefix.includes('"')) {
    // The folder itself, or anything under it — matched on a segment boundary.
    // A plain `LIKE '<prefix>%'` also swallows prefix-SIBLINGS: browsing
    // "21-0078 DH3" pulled in "21-0078 DH3 L" and "21-0078 DH3 S" (26 rows
    // where the folder has 8). The grid already refined that away client-side,
    // but `total` above is a server-side count, so an over-broad filter here
    // would put a number on screen that the grid disagrees with.
    //
    // pathPrefix is caller-supplied, so the values are double-quoted: real
    // folder names contain commas and brackets ("Philips Electronics,
    // Singapore", "Lucky Living Condo (Celes Asoke)"), which PostgREST would
    // otherwise read as punctuation in this expression. A quoted value can
    // only be escaped with a `"`, which is why one in the input skips the
    // filter entirely rather than being interpolated. `%`/`_` inside the
    // prefix stay wildcards — quoted values swallow backslash escapes — which
    // is the same slightly-broad behaviour as the previous `like`.
    query = query.or(
      `folder_path.eq."${pathPrefix}",folder_path.like."${pathPrefix}/%"`
    );
  }

  if (tagsParam) {
    const tags = tagsParam
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length) {
      // contains: every tag in `tags` must be present on the row
      query = query.contains("tags", tags);
    }
  }

  if (macro) query = query.eq("macro_portfolio", macro);
  if (core) query = query.eq("core_sector", core);

  if (subParam) {
    const subs = subParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (subs.length) query = query.contains("sub_sectors", subs);
  }

  // ANDed with path/pathPrefix above, so "this folder, Bangkok only" works —
  // the two constrain folder_path from different directions.
  if (studioFilter) query = query.or(studioFilter);

  if (q) {
    query = query.ilike("name", `%${q}%`);
  }

  const { data, error, count } = await query;

  if (error) {
    // Paging past the end is a 416 from PostgREST, not a fault: the client
    // asked for rows that no longer exist because the filters matched fewer
    // than it thought. An empty page with the real count is the honest answer.
    if (error.code === "PGRST103") {
      return NextResponse.json({ assets: [], total: count ?? 0 });
    }
    console.error("Asset search error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const assets = data ?? [];
  // `total` is how many rows match the filters; `assets` is the one page of
  // them asked for. They differ whenever a filter matches more than a page.
  return NextResponse.json({ assets, total: count ?? assets.length });
}

// A query parameter that must end up a usable integer. Anything unparseable
// falls back to `fallback` rather than reaching the query builder as NaN.
function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
