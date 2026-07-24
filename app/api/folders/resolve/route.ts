import { NextRequest, NextResponse } from "next/server";
import { resolveFolderPathToId } from "@/lib/googleDrive";

export const runtime = "nodejs";

// GET /api/folders/resolve?path=Drive/Sub/Folder
// Resolves a human-readable folder path to its Drive ids, for the upload
// destination picker — search results and recent-destination chips store only
// paths, and re-resolving on pick means a renamed/deleted folder fails loudly
// at selection time instead of mid-upload.
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path") ?? "";
  try {
    const { driveId, folderId } = await resolveFolderPathToId(path);
    const segments = path
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    return NextResponse.json({
      folder: {
        id: folderId,
        name: segments[segments.length - 1] ?? path,
        path: segments.join("/"),
        driveId,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Folder not found.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
