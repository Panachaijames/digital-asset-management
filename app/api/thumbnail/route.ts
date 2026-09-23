import { NextRequest, NextResponse } from "next/server";
import { getThumbnailLink } from "@/lib/driveThumbnails";

export const runtime = "nodejs";

const SIZES = new Set([320, 640, 1024, 1600]);

// GET /api/thumbnail?id=<driveFileId>&folder=<driveFolderId>&size=640
// Drive's thumbnailLink URLs are signed and expire after a few hours, so the
// stored link in Supabase goes stale. The browse page requests thumbnails
// through this route instead: it resolves a FRESH link (service-account auth)
// and 302-redirects to it. The Cache-Control lets the browser reuse the
// redirect for 30 minutes so a grid doesn't re-hit this route on every render.
// folder (optional) is the asset's Drive folder — passing it lets the resolver
// warm the whole folder's links in one Drive call instead of one per tile
// (see lib/driveThumbnails.ts).
// size (optional, default 640) picks the longest edge — the grid uses the
// default, the full-screen preview asks for 1600.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id || !/^[\w-]+$/.test(id)) {
    return NextResponse.json(
      { error: "Missing or invalid id." },
      { status: 400 }
    );
  }
  const sizeRaw = request.nextUrl.searchParams.get("size");
  const size = sizeRaw === null ? 640 : Number(sizeRaw);
  if (!SIZES.has(size)) {
    return NextResponse.json(
      { error: "size must be 320, 640, 1024 or 1600." },
      { status: 400 }
    );
  }
  const folder = request.nextUrl.searchParams.get("folder");

  try {
    const link = await getThumbnailLink(id, folder);
    if (!link) {
      // Drive hasn't generated a thumbnail (yet) for this file.
      return NextResponse.json({ error: "No thumbnail." }, { status: 404 });
    }

    // Drive links end in a size hint (e.g. "=s220") — bump it for crisp tiles.
    const sized = /=s\d+(-c)?$/.test(link)
      ? link.replace(/=s\d+(-c)?$/, `=s${size}`)
      : link;

    return NextResponse.redirect(sized, {
      status: 302,
      headers: { "Cache-Control": "public, max-age=1800" },
    });
  } catch (e) {
    console.error("Thumbnail proxy error:", e);
    return NextResponse.json({ error: "Thumbnail unavailable." }, { status: 404 });
  }
}
