import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { renamePresetGroup, renamePresetTag } from "@/lib/presets";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// POST /api/v1/presets/update
// Rename a tag:   { group, tag, newTag }
// Rename a group: { group, newGroup }
// Renames do NOT touch tags already applied to images — the preset library
// is the menu, not the applied tags.
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const groups =
      body.newGroup !== undefined
        ? await renamePresetGroup(body.group, body.newGroup)
        : await renamePresetTag(body.group, body.tag, body.newTag);
    console.log(`[api-v1] preset-update site=${auth.site} group="${body.group}"`);
    return jsonWithCors({ data: groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update the preset.";
    return apiError("bad_request", message, 400);
  }
}
