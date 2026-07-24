import { NextResponse } from "next/server";
import { getFolderPaths } from "@/lib/drivePaths";

export const runtime = "nodejs";

// GET /api/paths
// Returns every folder path in the Shared Drives (drive name as the root
// segment) so the media-library tree mirrors the real Drive structure,
// including folders that don't have any assets yet. On a transient Drive
// failure returns { error } (not an empty list) so the client keeps its
// last-good tree instead of collapsing to nothing.
export async function GET() {
  try {
    const paths = await getFolderPaths();
    return NextResponse.json({ paths });
  } catch (error) {
    console.error("Path list error:", error);
    return NextResponse.json({ error: "unreachable" });
  }
}
