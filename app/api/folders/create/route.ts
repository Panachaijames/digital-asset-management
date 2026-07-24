import { NextRequest, NextResponse } from "next/server";
import { createFolderAtPath } from "@/lib/googleDrive";
import { clearFolderPathCache } from "@/lib/drivePaths";

export const runtime = "nodejs";

// POST /api/folders/create
// Body: { parentPath: string, name: string }
//   parentPath — folder_path of the parent (first segment is the Shared Drive
//                name), e.g. "dwp_Digital_Asset/ProjectX"
//   name       — the new folder's name
// Creates the folder in Google Drive and returns its full path.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const parentPath = typeof body.parentPath === "string" ? body.parentPath : "";
    const name = typeof body.name === "string" ? body.name : "";

    const folder = await createFolderAtPath(parentPath, name);
    // Drop the cached folder list so the new folder shows on the next fetch.
    clearFolderPathCache();
    return NextResponse.json({ folder });
  } catch (error) {
    console.error("Create folder error:", error);
    const message =
      error instanceof Error ? error.message : "Could not create the folder.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
