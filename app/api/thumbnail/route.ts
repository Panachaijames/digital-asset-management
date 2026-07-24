import { NextRequest, NextResponse } from "next/server";
import { getDriveClient } from "@/lib/googleDrive";

export const runtime = "nodejs";

// GET /api/thumbnail?id=<driveFileId>
// Drive's thumbnailLink URLs are signed and expire after a few hours, so the
// stored link in Supabase goes stale. The browse page requests thumbnails
// through this route instead: it asks Drive for a FRESH link (service-account
// auth) and 302-redirects to it. The Cache-Control lets the browser reuse the
// redirect for 30 minutes so a grid doesn't re-hit Drive on every render.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id || !/^[\w-]+$/.test(id)) {
    return NextResponse.json(
      { error: "Missing or invalid id." },
      { status: 400 }
    );
  }

  try {
    const drive = getDriveClient();
    const res = await drive.files.get({
      fileId: id,
      fields: "thumbnailLink",
      supportsAllDrives: true,
    });
    const link = res.data.thumbnailLink;
    if (!link) {
      // Drive hasn't generated a thumbnail (yet) for this file.
      return NextResponse.json({ error: "No thumbnail." }, { status: 404 });
    }

    // Drive links end in a size hint (e.g. "=s220") — bump it for crisp tiles.
    const sized = /=s\d+(-c)?$/.test(link)
      ? link.replace(/=s\d+(-c)?$/, "=s640")
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
