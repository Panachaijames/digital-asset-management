import { NextRequest, NextResponse } from "next/server";
import { getDriveFileMetadata, trashDriveFile } from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveSelectionFromTags, normalizeTags } from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";
import { clearTagCountCache } from "@/lib/tagCounts";

export const runtime = "nodejs";

// POST /api/upload/complete
// Called by the browser after it finished PUTting a file straight to a Drive
// resumable-upload session (opened via /api/upload/session). Verifies the
// file really landed in the claimed folder, then writes the metadata row to
// Supabase — the same row the classic /api/upload route wrote.
//
// JSON body:
//   driveFileId: string   the Drive file ID returned by the final upload PUT
//   folderId: string      destination folder ID (as returned by /session)
//   folderPath: string    human-readable path (as returned by /session)
//   fileTags: string[]    this image's own tags (AI picks + card edits)
//   batchTags: string[]   batch tags applied to every image in the batch
//
// Returns { result: DamAsset }.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const driveFileId =
      typeof body?.driveFileId === "string" ? body.driveFileId : "";
    const folderId = typeof body?.folderId === "string" ? body.folderId : "";
    const folderPath =
      typeof body?.folderPath === "string" ? body.folderPath : "";

    if (!driveFileId || !folderId) {
      return NextResponse.json(
        { error: "Missing driveFileId or folderId." },
        { status: 400 }
      );
    }

    const sanitizeTagList = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 30)
        : [];
    const fileTags = sanitizeTagList(body?.fileTags);
    const batchTags = sanitizeTagList(body?.batchTags);

    const validPermissions = ["granted", "pending", "restricted"];
    const rawPermission = body?.publishPermission ?? body?.publish_permission;
    const publishPermission = (
      typeof rawPermission === "string" && validPermissions.includes(rawPermission)
        ? rawPermission
        : "pending"
    ) as string;

    // Row tags = the image's own tags + the batch tags; sector columns are
    // derived from whichever tags match the taxonomy (same as classic upload).
    const rowTags = normalizeTags([...fileTags, ...batchTags], 20);
    const taxonomy = deriveSelectionFromTags(rowTags, await getTaxonomyTree());

    // Look the file up in Drive rather than trusting the client's metadata,
    // and confirm it sits in the folder the session was opened for — a stray
    // or mistyped ID must not register somebody else's file as an asset.
    const meta = await getDriveFileMetadata(driveFileId);
    if (!meta.parents.includes(folderId)) {
      return NextResponse.json(
        { error: "Uploaded file is not in the expected folder." },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from("common_dam_assets")
      .insert({
        drive_file_id: meta.id,
        name: meta.name,
        folder_id: folderId,
        folder_path: folderPath,
        tags: rowTags,
        macro_portfolio: taxonomy.macro_portfolio,
        core_sector: taxonomy.core_sector,
        sub_sectors: taxonomy.sub_sectors,
        publish_permission: publishPermission,
        mime_type: meta.mimeType,
        size_bytes: Number(meta.size) || 0,
        web_view_link: meta.webViewLink,
        thumbnail_link: meta.thumbnailLink,
      })
      .select()
      .single();

    if (error) {
      // The bytes are in Drive but the metadata row failed — trash the Drive
      // file so the two stores don't drift apart (an unregistered file would
      // be invisible to the DAM but still hold quota).
      try {
        await trashDriveFile(meta.id);
      } catch (cleanupErr) {
        console.error("Cleanup after failed insert also failed:", cleanupErr);
      }
      throw new Error(error.message);
    }

    // Tag counts changed — drop the cached facet list.
    clearTagCountCache();

    return NextResponse.json({ result: data });
  } catch (error) {
    console.error("Upload complete route error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not record the uploaded file.",
      },
      { status: 500 }
    );
  }
}
