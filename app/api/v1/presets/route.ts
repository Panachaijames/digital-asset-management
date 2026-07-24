import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { addPresetTags, getPresetGroups } from "@/lib/presets";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// GET /api/v1/presets — the preset tag library, grouped:
// { data: [{ group, tags: [...] }, ...] }
export async function GET(request: NextRequest) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const groups = await getPresetGroups();
  return jsonWithCors({ data: groups });
}

// POST /api/v1/presets — add tags to a group (creates the group if new).
// Body: { group: string, tags: string[] }. Duplicates are skipped silently.
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const groups = await addPresetTags(body.group, body.tags);
    console.log(`[api-v1] preset-add site=${auth.site} group="${body.group}"`);
    return jsonWithCors({ data: groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not add the preset.";
    return apiError("bad_request", message, 400);
  }
}
