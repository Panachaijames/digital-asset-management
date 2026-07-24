import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { supabaseAdmin } from "@/lib/supabase";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// GET /api/v1/tags — every distinct tag in use with a count, most-used first.
// Same approach as the internal /api/tags route.
export async function GET(request: NextRequest) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const { data, error } = await supabaseAdmin
    .from("common_dam_assets")
    .select("tags");
  if (error) {
    console.error("v1 tag list error:", error);
    return apiError("server_error", "Could not list tags.", 500);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    for (const tag of row.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const tags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  return jsonWithCors({ data: tags });
}
