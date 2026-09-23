import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

// GET /api/folders/assets?path=dwp_Digital_Asset/Residential&recursive=true
// Or POST /api/folders/assets with body: { paths: string[], recursive?: boolean }
// Returns all asset IDs and basic info under the given folder path(s) (including all nested subfolders).
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") ?? "";
    const recursive = searchParams.get("recursive") !== "false"; // default true
    const limit = Math.min(10000, Number(searchParams.get("limit") || 5000));

    if (!path && !searchParams.has("all")) {
      return NextResponse.json(
        { error: "Folder path parameter 'path' is required." },
        { status: 400 }
      );
    }

    let query = supabaseAdmin
      .from("common_dam_assets")
      .select("id, name, folder_path, mime_type, size_bytes, publish_permission")
      .limit(limit);

    if (path) {
      if (recursive) {
        query = query.or(`folder_path.eq.${path},folder_path.like.${path}/%`);
      } else {
        query = query.eq("folder_path", path);
      }
    }

    const { data: assets, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    const ids = (assets || []).map((a) => a.id);

    return NextResponse.json({
      folderPath: path,
      recursive,
      totalCount: ids.length,
      assetIds: ids,
      assets: assets || [],
    });
  } catch (err) {
    console.error("GET /api/folders/assets error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to fetch folder assets.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawPaths: unknown = body.paths || (body.path ? [body.path] : []);
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    const recursive = body.recursive !== false;
    const limit = Math.min(20000, Number(body.limit) || 10000);

    if (paths.length === 0) {
      return NextResponse.json(
        { error: "At least one folder path must be provided in 'paths'." },
        { status: 400 }
      );
    }

    // Build query conditions for all paths
    const filterClauses: string[] = [];
    for (const p of paths) {
      if (recursive) {
        filterClauses.push(`folder_path.eq.${p}`, `folder_path.like.${p}/%`);
      } else {
        filterClauses.push(`folder_path.eq.${p}`);
      }
    }

    const { data: assets, error } = await supabaseAdmin
      .from("common_dam_assets")
      .select("id, name, folder_path, mime_type, size_bytes, publish_permission")
      .or(filterClauses.join(","))
      .limit(limit);

    if (error) {
      throw new Error(error.message);
    }

    const ids = (assets || []).map((a) => a.id);

    return NextResponse.json({
      paths,
      recursive,
      totalCount: ids.length,
      assetIds: ids,
      assets: assets || [],
    });
  } catch (err) {
    console.error("POST /api/folders/assets error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to resolve folder assets.",
      },
      { status: 500 }
    );
  }
}
