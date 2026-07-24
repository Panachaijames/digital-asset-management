import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { deletePreset } from "@/lib/presets";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// POST /api/v1/presets/delete
// Delete a tag:         { group, tag }
// Delete a whole group: { group }
// Deleting a preset does NOT remove that tag from images already tagged.
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const groups = await deletePreset(body.group, body.tag);
    console.log(
      `[api-v1] preset-delete site=${auth.site} group="${body.group}" tag="${body.tag ?? "(whole group)"}"`
    );
    return jsonWithCors({ data: groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not delete the preset.";
    return apiError("bad_request", message, 400);
  }
}
