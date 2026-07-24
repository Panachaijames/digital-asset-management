import { NextRequest, NextResponse } from "next/server";
import { uploadFileToDrive, ensureFolderPath } from "@/lib/googleDrive";
import { clearFolderPathCache } from "@/lib/drivePaths";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveSelectionFromTags, normalizeTags } from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";

export const runtime = "nodejs";

interface UploadedResult {
  index: number;
  fileName: string;
  id: string;
  drive_file_id: string;
  name: string;
  folder_id: string;
  folder_path: string;
  tags: string[];
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
  mime_type: string;
  size_bytes: number;
  web_view_link: string;
  thumbnail_link: string | null;
  created_at: string;
}

interface FailedResult {
  index: number;
  fileName: string;
  error: string;
}

// POST /api/upload
// FormData fields:
//   files: File[]        one or more, field name "files"
//   folderId: string      target Drive folder ID
//   folderPath: string     human-readable path, stored for display/browsing
//   tags: string           comma-separated tags applied to every file in this batch
//   fileTags: string       JSON string[][] — each file's OWN tags, aligned by
//                          index with `files` (per-image AI picks + edits)
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const folderId = formData.get("folderId") as string;
    const folderPath = (formData.get("folderPath") as string) || "";
    const driveId = (formData.get("driveId") as string) || "";
    const tagsRaw = (formData.get("tags") as string) || "";

    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Batch tags (typed + preset picks), applied to every file in this
    // request ON TOP of each file's own tags. Cleaned/deduped here.
    const batchTags = normalizeTags(tags);

    // Per-image tags (AI suggestions + card edits), aligned by index with
    // `files` — this is what makes tagging individual per image.
    const sanitizeTagList = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 30)
        : [];
    let fileTags: string[][] = [];
    try {
      const rawFileTags = formData.get("fileTags") as string | null;
      const parsedFileTags = rawFileTags ? JSON.parse(rawFileTags) : [];
      if (Array.isArray(parsedFileTags)) {
        fileTags = parsedFileTags.map(sanitizeTagList);
      }
    } catch {
      fileTags = [];
    }

    // Per-image folder path relative to the destination (from whole-folder
    // drops), aligned by index with `files`. Sanitised into safe segments.
    const sanitizeSegments = (p: unknown): string[] => {
      if (typeof p !== "string" || !p) return [];
      return p
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s && s !== "." && s !== "..")
        .slice(0, 20)
        .map((s) => s.slice(0, 200));
    };
    let relativePaths: string[][] = [];
    try {
      const raw = formData.get("relativePaths") as string | null;
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) relativePaths = parsed.map(sanitizeSegments);
    } catch {
      relativePaths = [];
    }

    // Folder-path → Drive folder ID cache, shared by all files in this request.
    const folderCache = new Map<string, string>();

    if (!files.length) {
      return NextResponse.json(
        { error: "No files were provided." },
        { status: 400 }
      );
    }
    if (!folderId) {
      return NextResponse.json(
        { error: "No destination folder was provided." },
        { status: 400 }
      );
    }

    const results: UploadedResult[] = [];
    const failures: FailedResult[] = [];

    // User-editable taxonomy (cached) — sector columns derive against this.
    const taxonomyTree = await getTaxonomyTree();

    // Uploaded sequentially — Drive's per-file resumable upload plus a
    // Supabase insert per file is already several round trips; running
    // them in parallel is possible but makes partial-failure handling and
    // Drive API rate limits harder to reason about for a first pass.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Each row's tags = its own per-image tags + the batch tags; the sector
      // columns are derived PER IMAGE from whichever tags match the taxonomy.
      const rowTags = normalizeTags([...(fileTags[i] ?? []), ...batchTags], 20);
      const taxonomy = deriveSelectionFromTags(rowTags, taxonomyTree);
      const segments = relativePaths[i] ?? [];
      try {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Recreate the dropped folder structure under the destination.
        let targetFolderId = folderId;
        let rowFolderPath = folderPath;
        if (segments.length && driveId) {
          targetFolderId = await ensureFolderPath(
            driveId,
            folderId,
            segments,
            folderCache
          );
          rowFolderPath = folderPath
            ? `${folderPath}/${segments.join("/")}`
            : segments.join("/");
        }

        const driveResult = await uploadFileToDrive(
          buffer,
          file.name,
          file.type || "application/octet-stream",
          targetFolderId
        );

        const { data, error } = await supabaseAdmin
          .from("common_dam_assets")
          .insert({
            drive_file_id: driveResult.id,
            name: driveResult.name,
            folder_id: targetFolderId,
            folder_path: rowFolderPath,
            tags: rowTags,
            macro_portfolio: taxonomy.macro_portfolio,
            core_sector: taxonomy.core_sector,
            sub_sectors: taxonomy.sub_sectors,
            mime_type: driveResult.mimeType,
            size_bytes: Number(driveResult.size) || buffer.byteLength,
            web_view_link: driveResult.webViewLink,
            thumbnail_link: driveResult.thumbnailLink,
          })
          .select()
          .single();

        if (error) throw new Error(error.message);

        results.push({ index: i, fileName: file.name, ...data });
      } catch (err) {
        console.error(`Upload failed for "${file.name}":`, err);
        failures.push({
          index: i,
          fileName: file.name,
          error: err instanceof Error ? err.message : "Upload failed.",
        });
      }
    }

    // A whole-folder drop may have created folders in Drive (ensureFolderPath)
    // — drop the cached folder tree so the browse page shows them right away
    // instead of only after the 60 s cache expires.
    if (folderCache.size > 0) clearFolderPathCache();

    return NextResponse.json({ results, failures });
  } catch (error) {
    console.error("Upload route error:", error);
    return NextResponse.json(
      { error: "Something went wrong processing the upload." },
      { status: 500 }
    );
  }
}
