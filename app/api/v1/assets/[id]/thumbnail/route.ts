import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError } from "@/lib/api/cors";
import { getAssetById } from "@/lib/api/search";
import { getThumbnailLink } from "@/lib/driveThumbnails";

export const runtime = "nodejs";

const SIZES = new Set([320, 640, 1024]);

// GET /api/v1/assets/{id}/thumbnail?size=640 — same fresh-link + 302 trick as
// the internal /api/thumbnail route (Drive thumbnail links expire after a few
// hours, so we resolve a fresh one and let the browser cache the redirect for
// 30 minutes). Resolution goes through lib/driveThumbnails.ts, so a consumer
// walking a folder pays one Drive call for the whole folder, not one per
// asset.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const sizeRaw = request.nextUrl.searchParams.get("size");
  const size = sizeRaw === null ? 640 : Number(sizeRaw);
  if (!SIZES.has(size)) {
    return apiError("bad_request", "size must be 320, 640 or 1024.", 400);
  }

  const { id } = await params;
  const row = await getAssetById(id).catch(() => null);
  if (!row) return apiError("not_found", "No asset with that id.", 404);

  try {
    const link = await getThumbnailLink(row.drive_file_id, row.folder_id);
    if (!link) {
      // Drive hasn't generated a thumbnail (yet) for this file.
      return apiError("not_found", "No thumbnail for this asset (yet).", 404);
    }

    const sized = /=s\d+(-c)?$/.test(link)
      ? link.replace(/=s\d+(-c)?$/, `=s${size}`)
      : link;

    return NextResponse.redirect(sized, {
      status: 302,
      headers: { "Cache-Control": "public, max-age=1800" },
    });
  } catch (err) {
    console.error("v1 thumbnail proxy error:", err);
    return apiError("not_found", "Thumbnail unavailable.", 404);
  }
}
