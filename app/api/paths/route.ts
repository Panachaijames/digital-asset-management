import { NextRequest, NextResponse } from "next/server";
import { getFolderPaths } from "@/lib/drivePaths";
import { pollFolderIndexNow } from "@/lib/folderIndex";

export const runtime = "nodejs";

// GET /api/paths[?r=<n>]
// Returns every folder path in the Shared Drives (drive name as the root
// segment) so the media-library tree mirrors the real Drive structure,
// including folders that don't have any assets yet. On a transient Drive
// failure returns { error } (not an empty list) so the client keeps its
// last-good tree instead of collapsing to nothing. `r` is the client's
// refresh counter: besides busting the browser cache it asks for a change-feed
// poll right now rather than within the usual few seconds.
export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.has("r")) await pollFolderIndexNow();
    const paths = await getFolderPaths();
    return NextResponse.json(
      { paths },
      // ~160KB of folder paths that the tree, the upload folder picker and the
      // import screen all ask for. A short browser cache means moving between
      // those screens reuses one response; the client appends ?r=<n> to bypass
      // it after an explicit refresh or a folder create. Kept short: the server
      // side is now fresh to within seconds (lib/folderIndex.ts), so this cache
      // would otherwise be the dominant staleness. If you change this, change
      // RESPONSE_CACHE_MS in lib/clientFolderChanges.ts to match.
      { headers: { "Cache-Control": "private, max-age=10" } }
    );
  } catch (error) {
    console.error("Path list error:", error);
    return NextResponse.json({ error: "unreachable" });
  }
}
