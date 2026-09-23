import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { countAllTags } from "@/lib/api/search";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// GET /api/v1/tags — every distinct tag in use with a count, most-used first.
// Counting is paginated in countAllTags — a plain select stops at Supabase's
// 1000-row cap, which silently undercounted once the library passed 1k assets.
export async function GET(request: NextRequest) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  try {
    const tags = await countAllTags();
    return jsonWithCors({ data: tags });
  } catch (err) {
    console.error("v1 tag list error:", err);
    return apiError("server_error", "Could not list tags.", 500);
  }
}
