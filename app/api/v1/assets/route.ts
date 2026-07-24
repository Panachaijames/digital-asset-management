import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { getPublicBaseUrl, toPublicAsset } from "@/lib/api/serialize";
import { csv, searchAssets } from "@/lib/api/search";
import { resolveFolderPathToId, uploadFileToDrive } from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveSelectionFromTags, normalizeTags } from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";

export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/api/cors";

// GET /api/v1/assets — external search. Same filter semantics as the internal
// /api/assets route, plus offset paging. Full contract: docs/API-PLAN.md.
export async function GET(request: NextRequest) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const p = request.nextUrl.searchParams;
  const limitRaw = p.get("limit");
  const offsetRaw = p.get("offset");

  const outcome = await searchAssets({
    q: p.get("q"),
    tags: csv(p.get("tags")),
    macro: p.get("macro"),
    core: p.get("core"),
    sub: csv(p.get("sub")),
    path: p.get("path"),
    pathPrefix: p.get("pathPrefix"),
    sort: p.get("sort"),
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Number(offsetRaw),
  });
  if (!outcome.ok) {
    return apiError(
      outcome.status === 400 ? "bad_request" : "server_error",
      outcome.message,
      outcome.status
    );
  }

  const base = getPublicBaseUrl(request);
  return jsonWithCors({
    data: outcome.rows.map((r) => toPublicAsset(r, base)),
    meta: { limit: outcome.limit, offset: outcome.offset, count: outcome.rows.length },
  });
}

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// POST /api/v1/assets — upload ONE image.
// multipart/form-data: file (image/*, ≤30 MB), folderPath (must already
// exist — create via POST /api/v1/folders first), tags (comma-separated,
// optional; taxonomy columns are derived from them like the internal upload).
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(
      "bad_request",
      "Expected multipart/form-data with a file field.",
      400
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError("bad_request", 'Missing "file" field.', 400);
  }
  const mime = file.type || "";
  if (!mime.startsWith("image/")) {
    return apiError(
      "bad_request",
      `Only image uploads are allowed (got "${mime || "unknown"}").`,
      400
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return apiError("bad_request", "File is larger than the 30 MB limit.", 400);
  }

  const folderPathRaw = form.get("folderPath");
  const folderPath = typeof folderPathRaw === "string" ? folderPathRaw.trim() : "";
  if (!folderPath) {
    return apiError("bad_request", 'Missing "folderPath" field.', 400);
  }

  const tags = normalizeTags(
    String(form.get("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  );
  const taxonomy = deriveSelectionFromTags(tags, await getTaxonomyTree());

  try {
    // Find-only resolution: a typo'd path errors instead of creating folders.
    const target = await resolveFolderPathToId(folderPath);
    const buffer = Buffer.from(await file.arrayBuffer());
    const driveResult = await uploadFileToDrive(buffer, file.name, mime, target.folderId);

    const { data, error } = await supabaseAdmin
      .from("common_dam_assets")
      .insert({
        drive_file_id: driveResult.id,
        name: driveResult.name,
        folder_id: target.folderId,
        folder_path: folderPath,
        tags,
        macro_portfolio: taxonomy.macro_portfolio,
        core_sector: taxonomy.core_sector,
        sub_sectors: taxonomy.sub_sectors,
        mime_type: driveResult.mimeType,
        size_bytes: Number(driveResult.size) || buffer.byteLength,
        web_view_link: driveResult.webViewLink,
        thumbnail_link: driveResult.thumbnailLink,
        uploaded_by: auth.site,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    console.log(`[api-v1] upload site=${auth.site} id=${data.id} name="${data.name}"`);
    return jsonWithCors(
      { data: toPublicAsset(data, getPublicBaseUrl(request)) },
      { status: 201 }
    );
  } catch (err) {
    console.error("v1 upload error:", err);
    const message = err instanceof Error ? err.message : "Upload failed.";
    // Path-resolution problems are the caller's to fix; the rest are ours.
    const callerFixable = /no longer exists|not found|is empty/i.test(message);
    return apiError(
      callerFixable ? "bad_request" : "server_error",
      callerFixable ? message : "Upload failed.",
      callerFixable ? 400 : 500
    );
  }
}
