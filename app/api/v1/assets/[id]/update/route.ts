import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { getPublicBaseUrl, toPublicAsset } from "@/lib/api/serialize";
import { getAssetById } from "@/lib/api/search";
import { renameDriveFile } from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveSelectionFromTags, normalizeTags } from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";

export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/api/cors";

// POST /api/v1/assets/{id}/update — change name and/or tags.
// Body: { name?: string, tags?: string[] }
// tags REPLACES the whole list (send the full final set); the taxonomy
// columns are re-derived from it, same one code path as upload.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError("bad_request", "Expected a JSON body.", 400);
  }

  const hasName = body.name !== undefined;
  const hasTags = body.tags !== undefined;
  if (!hasName && !hasTags) {
    return apiError("bad_request", "Nothing to change — send name and/or tags.", 400);
  }

  let newName = "";
  if (hasName) {
    newName = typeof body.name === "string" ? body.name.trim() : "";
    if (!newName || newName.includes("/")) {
      return apiError(
        "bad_request",
        "name must be a non-empty string without slashes.",
        400
      );
    }
  }

  let newTags: string[] = [];
  if (hasTags) {
    const raw = Array.isArray(body.tags)
      ? body.tags.map(String)
      : typeof body.tags === "string"
        ? body.tags.split(",").map((t) => t.trim())
        : null;
    if (raw === null) {
      return apiError("bad_request", "tags must be an array of strings.", 400);
    }
    newTags = normalizeTags(raw.filter(Boolean));
  }

  const { id } = await params;
  try {
    const row = await getAssetById(id);
    if (!row) return apiError("not_found", "No asset with that id.", 404);

    const updates: Record<string, unknown> = {};
    if (hasName) {
      // Drive first, then the row, so the stored name reflects reality.
      updates.name = await renameDriveFile(row.drive_file_id, newName);
    }
    if (hasTags) {
      const taxonomy = deriveSelectionFromTags(newTags, await getTaxonomyTree());
      updates.tags = newTags;
      updates.macro_portfolio = taxonomy.macro_portfolio;
      updates.core_sector = taxonomy.core_sector;
      updates.sub_sectors = taxonomy.sub_sectors;
    }

    const { data, error } = await supabaseAdmin
      .from("common_dam_assets")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    console.log(
      `[api-v1] update site=${auth.site} id=${id} fields=${Object.keys(updates).join(",")}`
    );
    return jsonWithCors({ data: toPublicAsset(data, getPublicBaseUrl(request)) });
  } catch (err) {
    console.error("v1 update error:", err);
    return apiError("server_error", "Update failed.", 500);
  }
}
