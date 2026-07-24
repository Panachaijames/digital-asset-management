import { NextRequest } from "next/server";
import { Readable } from "stream";
import { requireApiKey } from "@/lib/api/auth";
import { apiError } from "@/lib/api/cors";
import { getAssetById } from "@/lib/api/search";
import { getDriveClient } from "@/lib/googleDrive";

export const runtime = "nodejs";

// GET /api/v1/assets/{id}/image — the full-resolution bytes, streamed from
// Drive through this server (Drive's own links don't work for callers without
// Drive permissions). Streamed, not buffered, so big files don't hold memory.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const row = await getAssetById(id).catch(() => null);
  if (!row) return apiError("not_found", "No asset with that id.", 404);

  try {
    const drive = getDriveClient();
    const res = await drive.files.get(
      { fileId: row.drive_file_id, alt: "media", supportsAllDrives: true },
      { responseType: "stream" }
    );

    const headers = new Headers({
      "Content-Type": row.mime_type || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    });
    // Filename for save-as; RFC 5987 form carries non-ASCII (e.g. Thai) names.
    const asciiName = row.name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    headers.set(
      "Content-Disposition",
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.name)}`
    );
    const len = res.headers["content-length"];
    if (len) headers.set("Content-Length", String(len));

    const body = Readable.toWeb(res.data as Readable) as ReadableStream;
    return new Response(body, { headers });
  } catch (err) {
    console.error("v1 image proxy error:", err);
    return apiError("not_found", "Image unavailable.", 404);
  }
}
