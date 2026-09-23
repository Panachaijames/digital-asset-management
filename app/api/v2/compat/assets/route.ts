import { NextRequest, NextResponse } from "next/server";
import { fromV1Query, toDamAsset } from "@/lib/v2/compat";
import { v2BrowseMode } from "@/lib/v2/config";
import { V2Error, v2ErrorResponse } from "@/lib/v2/errors";
import { requireV2User } from "@/lib/v2/identity";
import { searchAssets } from "@/lib/v2/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v2/compat/assets — the project library in /api/assets's shape.
//
// Takes exactly the /api/assets query string (tags, q, macro, core, sub, path,
// pathPrefix, studio, sort, limit, offset; `permission` is ignored) and answers
// { assets, total, source: "v2" }, each asset a v1 DamAsset plus v2_id/v1_id.
// This is what /browse calls in project-library mode, so the grid, tiles and
// details panel render v2 rows unchanged. The mapping lives in lib/v2/compat.ts.
//
// Read-only by construction: `id` is the v2 asset id, which no v1 write route
// can find. 404 while the library is switched off. Never 401 (lib/v2/errors.ts).
export async function GET(request: NextRequest) {
  try {
    if (v2BrowseMode() === "off") {
      throw new V2Error(404, "not_found", "The project library is not available on this server.");
    }
    const input = fromV1Query(request.nextUrl.searchParams);
    const user = await requireV2User(request);
    const result = await searchAssets(user, input);
    return NextResponse.json(
      { assets: result.rows.map(toDamAsset), total: result.total, source: "v2" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return v2ErrorResponse(e);
  }
}
