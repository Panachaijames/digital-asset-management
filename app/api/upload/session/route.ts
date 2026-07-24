import { NextRequest, NextResponse } from "next/server";
import {
  createResumableUploadSession,
  ensureFolderPath,
} from "@/lib/googleDrive";
import { clearFolderPathCache } from "@/lib/drivePaths";

export const runtime = "nodejs";

// POST /api/upload/session
// Opens a Google Drive resumable-upload session for ONE file so the browser
// can PUT the bytes straight to Drive (bypassing Cloud Run's 32 MiB request
// cap — this is what removes the old 30 MB per-file limit). Auth never
// leaves the server: only the capability-scoped session URL goes back.
//
// JSON body:
//   fileName: string       original file name
//   mimeType: string       file MIME type
//   sizeBytes: number      exact byte size (Drive validates the PUT against it)
//   folderId: string       destination Drive folder ID
//   folderPath: string     human-readable destination path (for display rows)
//   driveId: string        Shared Drive ID (needed to create subfolders)
//   relativePath: string   folder path relative to the drop, "" for loose files
//
// Returns { uploadUrl, folderId, folderPath } where folderId/folderPath are
// the FINAL destination after recreating any dropped subfolder structure —
// the client echoes them back to /api/upload/complete.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const fileName =
      typeof body?.fileName === "string" ? body.fileName.trim() : "";
    const mimeType =
      typeof body?.mimeType === "string" && body.mimeType
        ? body.mimeType
        : "application/octet-stream";
    const sizeBytes = Number(body?.sizeBytes);
    const folderId = typeof body?.folderId === "string" ? body.folderId : "";
    const folderPath =
      typeof body?.folderPath === "string" ? body.folderPath : "";
    const driveId = typeof body?.driveId === "string" ? body.driveId : "";

    if (!fileName) {
      return NextResponse.json(
        { error: "No file name was provided." },
        { status: 400 }
      );
    }
    if (!folderId) {
      return NextResponse.json(
        { error: "No destination folder was provided." },
        { status: 400 }
      );
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return NextResponse.json(
        { error: "Invalid file size." },
        { status: 400 }
      );
    }

    // Same segment sanitising as the classic upload route: no traversal, no
    // absurd depth, bounded segment length.
    const segments =
      typeof body?.relativePath === "string" && body.relativePath
        ? body.relativePath
            .split("/")
            .map((s: string) => s.trim())
            .filter((s: string) => s && s !== "." && s !== "..")
            .slice(0, 20)
            .map((s: string) => s.slice(0, 200))
        : [];

    // Recreate the dropped folder structure under the destination.
    let targetFolderId = folderId;
    let rowFolderPath = folderPath;
    if (segments.length && driveId) {
      targetFolderId = await ensureFolderPath(
        driveId,
        folderId,
        segments,
        new Map()
      );
      rowFolderPath = folderPath
        ? `${folderPath}/${segments.join("/")}`
        : segments.join("/");
      // New folders may exist now — drop the cached tree so /browse sees them.
      clearFolderPathCache();
    }

    // Google echoes this origin in CORS headers on the direct-upload PUTs;
    // the header is always present on a browser POST, URL origin is a
    // server-to-server fallback.
    const origin =
      request.headers.get("origin") ?? new URL(request.url).origin;

    const uploadUrl = await createResumableUploadSession(
      fileName,
      mimeType,
      sizeBytes,
      targetFolderId,
      origin
    );

    return NextResponse.json({
      uploadUrl,
      folderId: targetFolderId,
      folderPath: rowFolderPath,
    });
  } catch (error) {
    console.error("Upload session route error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not start the upload.",
      },
      { status: 500 }
    );
  }
}
