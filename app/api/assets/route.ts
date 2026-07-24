import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/assets?tags=exterior,bangkok&q=lobby&macro=Lifestyle&core=Hospitality&sub=Luxury+Resort&path=Drive/ProjectX&sort=newest&limit=60
// tags:       comma-separated — returns assets that have ALL listed tags
// macro:      exact Macro Portfolio match
// core:       exact Core Sector match
// sub:        comma-separated Sub-Sectors — returns assets that have ALL of them
// q:          matches against the asset name (case-insensitive, partial)
// path:       exact folder_path match (current-folder view)
// pathPrefix: folder_path prefix match (folder + its subtree; client refines)
// sort:       newest (default) | oldest
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tagsParam = params.get("tags");
  const macro = params.get("macro");
  const core = params.get("core");
  const subParam = params.get("sub");
  const q = params.get("q");
  const path = params.get("path");
  const pathPrefix = params.get("pathPrefix");
  const sort = params.get("sort");
  const limit = Number(params.get("limit") ?? 60);

  let query = supabaseAdmin
    .from("common_dam_assets")
    .select("*")
    .order("created_at", { ascending: sort === "oldest" })
    .limit(limit);

  if (path) {
    query = query.eq("folder_path", path);
  } else if (pathPrefix) {
    query = query.like("folder_path", `${pathPrefix}%`);
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

  if (q) {
    query = query.ilike("name", `%${q}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Asset search error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ assets: data ?? [] });
}
