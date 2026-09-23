import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { supabaseAdmin } from "@/lib/supabase";
import { getDriveClient, getDriveImageForClassification } from "@/lib/googleDrive";

export const runtime = "nodejs";

// GET /api/assets/download?id=<assetId>&driveId=<driveFileId>&name=<fileName>
// Streams original image bytes from Drive through this server with
// Content-Disposition: attachment for direct client browser downloading.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const driveIdParam = request.nextUrl.searchParams.get("driveId");
  const nameParam = request.nextUrl.searchParams.get("name");

  let driveFileId = driveIdParam;
  let fileName = nameParam || "image.jpg";
  let mimeType = "application/octet-stream";
  let sizeBytes: number | null = null;

  if (id) {
    // Lookup asset in Supabase
    const { data: asset } = await supabaseAdmin
      .from("common_dam_assets")
      .select("id, drive_file_id, name, mime_type, size_bytes")
      .or(`id.eq.${id},drive_file_id.eq.${id}`)
      .maybeSingle();

    if (asset) {
      driveFileId = asset.drive_file_id;
      fileName = asset.name || fileName;
      mimeType = asset.mime_type || mimeType;
      sizeBytes = asset.size_bytes || null;
    }
  }

  if (!driveFileId) {
    return NextResponse.json(
      { error: "Asset not found or driveId missing." },
      { status: 404 }
    );
  }

  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const contentDisposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

  // 1. Try streaming full original file from Google Drive
  try {
    const drive = getDriveClient();
    const res = await drive.files.get(
      { fileId: driveFileId, alt: "media", supportsAllDrives: true },
      { responseType: "stream" }
    );

    const headers = new Headers({
      "Content-Type": mimeType,
      "Content-Disposition": contentDisposition,
      "Cache-Control": "private, max-age=3600",
    });

    const len = res.headers["content-length"] || sizeBytes;
    if (len) headers.set("Content-Length", String(len));

    const body = Readable.toWeb(res.data as Readable) as ReadableStream;
    return new Response(body, { headers });
  } catch (driveErr) {
    console.warn(
      `Direct Drive alt=media stream failed for ${driveFileId}, falling back to high-res thumbnail:`,
      driveErr
    );

    // 2. Fallback to high-res pre-rendered image buffer from Drive thumbnail
    try {
      const fallback = await getDriveImageForClassification(driveFileId);
      if (fallback && fallback.buffer.length > 0) {
        const headers = new Headers({
          "Content-Type": fallback.mimeType || "image/jpeg",
          "Content-Disposition": contentDisposition,
          "Content-Length": String(fallback.buffer.length),
          "Cache-Control": "private, max-age=3600",
        });

        return new Response(new Uint8Array(fallback.buffer), { headers });
      }
    } catch (fbErr) {
      console.error("High-res thumbnail fallback failed:", fbErr);
    }

    return NextResponse.json(
      { error: "Image file could not be retrieved from Google Drive." },
      { status: 502 }
    );
  }
}
