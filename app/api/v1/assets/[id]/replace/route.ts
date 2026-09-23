import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { getPublicBaseUrl, toPublicAsset } from "@/lib/api/serialize";
import { getAssetById } from "@/lib/api/search";
import { replaceDriveFile } from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/api/cors";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// POST /api/v1/assets/{id}/replace — swap the image FILE, keep the asset.
// multipart/form-data with one "file" field. Same id, same image/thumbnail
// URLs — pages already embedding this asset just start showing the new
// picture (after caches expire).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
  const isPdf =
    mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = mime.startsWith("image/");
  if (!isImage && !isPdf) {
    return apiError(
      "bad_request",
      `Only image and PDF uploads are allowed (got "${mime || "unknown"}").`,
      400
    );
  }
  const resolvedMime = isPdf ? "application/pdf" : mime;
  if (file.size > MAX_UPLOAD_BYTES) {
    return apiError("bad_request", "File is larger than the 30 MB limit.", 400);
  }

  const { id } = await params;
  try {
    const row = await getAssetById(id);
    if (!row) return apiError("not_found", "No asset with that id.", 404);

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await replaceDriveFile(row.drive_file_id, buffer, resolvedMime);

    const { data, error } = await supabaseAdmin
      .from("common_dam_assets")
      .update({
        mime_type: result.mimeType,
        size_bytes: Number(result.size) || buffer.byteLength,
        thumbnail_link: result.thumbnailLink,
      })
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    console.log(`[api-v1] replace site=${auth.site} id=${id}`);
    return jsonWithCors({ data: toPublicAsset(data, getPublicBaseUrl(request)) });
  } catch (err) {
    console.error("v1 replace error:", err);
    return apiError("server_error", "Replace failed.", 500);
  }
}
