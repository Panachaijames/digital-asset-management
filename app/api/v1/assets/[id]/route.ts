import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { getPublicBaseUrl, toPublicAsset } from "@/lib/api/serialize";
import { getAssetById } from "@/lib/api/search";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// GET /api/v1/assets/{id} — one asset's metadata.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const row = await getAssetById(id);
    if (!row) return apiError("not_found", "No asset with that id.", 404);
    return jsonWithCors({ data: toPublicAsset(row, getPublicBaseUrl(request)) });
  } catch (err) {
    console.error("v1 asset lookup error:", err);
    return apiError("server_error", "Lookup failed.", 500);
  }
}
