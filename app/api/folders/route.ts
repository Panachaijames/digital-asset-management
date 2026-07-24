import { NextRequest, NextResponse } from "next/server";
import { listSharedDrives, listDriveFolders } from "@/lib/googleDrive";
import type { DriveFolder } from "@/lib/types";

// GET /api/folders
//   (no params)                          -> the Shared Drives the service account can access
//   ?driveId=D                           -> folders at the root of drive D
//   ?driveId=D&parentId=P&parentPath=... -> subfolders of folder P inside drive D
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const driveId = params.get("driveId");
    const parentId = params.get("parentId");
    const parentPath = params.get("parentPath") ?? "";

    if (!driveId) {
      // Top level: list the Shared Drives (a service account has no My Drive).
      const drives = await listSharedDrives();
      const folders: DriveFolder[] = drives.map((d) => ({
        id: d.id,
        name: d.name,
        path: d.name,
        driveId: d.id,
      }));
      return NextResponse.json({ folders });
    }

    // Folders under `parentId` (defaults to the drive root) within the drive.
    const rawFolders = await listDriveFolders(driveId, parentId || driveId);
    const folders: DriveFolder[] = rawFolders.map((f) => ({
      id: f.id,
      name: f.name,
      path: parentPath ? `${parentPath}/${f.name}` : f.name,
      driveId,
    }));

    return NextResponse.json({ folders });
  } catch (error) {
    console.error("Failed to list Drive folders:", error);
    return NextResponse.json(
      {
        folders: [],
        error:
          "Could not reach Google Drive. Check the service account has been added to the Shared Drive.",
      },
      { status: 200 }
    );
  }
}
