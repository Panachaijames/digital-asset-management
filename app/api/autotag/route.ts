import { NextRequest, NextResponse } from "next/server";
import { getDriveImageForClassification } from "@/lib/googleDrive";
import { ClassifierUnavailableError } from "@/lib/gemini";
import { supabaseAdmin } from "@/lib/supabase";
import { isPrimaryMacro, type MacroPortfolio } from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";
import { clearTagCountCache } from "@/lib/tagCounts";
import {
  autoTagImage,
  buildFacetScaffold,
  buildVocab,
} from "@/lib/autoTagging";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

// One POST stops starting new images once this much time has passed and
// returns what it finished — well inside Cloud Run's 300 s request timeout.
// (A batch of large originals used to run past the timeout, and the browser
// saw a dead connection: "Failed to fetch".) The client re-queues whatever
// wasn't processed.
const TIME_BUDGET_MS = 45_000;

// Cap on how many asset IDs GET hands out per call (supports full library of 35k+ assets)
const MAX_IDS = 100_000;

interface DAMAssetRow {
  id: string;
  drive_file_id: string;
  name: string;
  folder_path: string;
  tags: string[] | null;
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[] | null;
  mime_type: string;
}

// Fetch all matching assets handling Supabase 1000-row limit pagination
async function fetchAllMatchingAssets(
  folderPath?: string,
  folderPaths?: string[],
  fields = "id, folder_path, tags, macro_portfolio, core_sector, mime_type"
): Promise<DAMAssetRow[]> {
  const PAGE_SIZE = 1000;
  let page = 0;
  let all: DAMAssetRow[] = [];

  const paths = Array.isArray(folderPaths) && folderPaths.length > 0
    ? folderPaths
    : folderPath
    ? [folderPath]
    : [];

  while (true) {
    let query = supabaseAdmin
      .from("common_dam_assets")
      .select(fields)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (paths.length > 0) {
      const orClauses = paths.flatMap((p) => [
        `folder_path.eq.${p}`,
        `folder_path.like.${p}/%`,
      ]);
      query = query.or(orClauses.join(","));
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    all = all.concat(data as unknown as DAMAssetRow[]);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

// Helper to determine if an asset is untagged / incomplete — i.e. still needs
// the AI classifier. As well as the obvious "no tags / no sector" cases, an
// asset whose macro_portfolio is a FACET (e.g. "Location Matrix") counts as
// incomplete: that classification came from a folder name, not from looking at
// the image, so the AI has never actually classified what it depicts. This is
// what lets the ~14k bulk-imported "Location Matrix / Australia" rows get
// picked up and re-tagged with a real primary sector.
function isUntagged(asset: {
  tags?: string[] | null;
  macro_portfolio?: string | null;
  core_sector?: string | null;
}): boolean {
  if (!Array.isArray(asset.tags) || asset.tags.length === 0) return true;
  if (!asset.macro_portfolio || !asset.core_sector) return true;
  if (!isPrimaryMacro(asset.macro_portfolio)) return true;
  return false;
}

// GET /api/autotag
// Returns total images, untagged count, and optionally an array of untagged
// asset IDs so the client can drive batch progress.
// Query params:
//   folderPath?: string
//   includeIds?: 1
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const folderPath = searchParams.get("folderPath")?.trim() || undefined;
    const includeIds = searchParams.get("includeIds") === "1";

    const allAssets = await fetchAllMatchingAssets(
      folderPath,
      undefined,
      "id, folder_path, tags, macro_portfolio, core_sector, mime_type"
    );

    // Filter to taggable media (images and PDFs)
    const images = allAssets.filter((a) =>
      a.mime_type && (a.mime_type.startsWith("image/") || a.mime_type === "application/pdf")
    );

    // Find untagged / incomplete images
    const untaggedImages = images.filter(isUntagged);

    return NextResponse.json({
      total: allAssets.length,
      totalImages: images.length,
      untaggedCount: untaggedImages.length,
      taggedCount: images.length - untaggedImages.length,
      ...(includeIds
        ? {
            untaggedIds: untaggedImages.slice(0, MAX_IDS).map((a) => a.id),
            allImageIds: images.slice(0, MAX_IDS).map((a) => a.id),
          }
        : {}),
    });
  } catch (error) {
    console.error("GET /api/autotag error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not fetch auto-tag stats.",
      },
      { status: 500 }
    );
  }
}

// POST /api/autotag
// Runs AI auto-tagging for untagged image assets in batches. Tags are
// written per image, and the request stops starting new images once
// TIME_BUDGET_MS is spent — `results` says exactly which assets were
// processed; the client re-queues the rest.
// JSON body:
//   limit?: number          (default 10, max 30)
//   folderPath?: string     (optional folder path filter)
//   folderPaths?: string[]  (optional multiple folder paths)
//   assetIds?: string[]     (optional specific list of asset UUIDs to tag)
//   excludeIds?: string[]   (optional asset UUIDs to skip from search, e.g. already attempted)
//   forceAll?: boolean      (if true, re-tags even if already tagged)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(
      Math.max(1, Number(body?.limit) || DEFAULT_LIMIT),
      MAX_LIMIT
    );
    const folderPath =
      typeof body?.folderPath === "string" ? body.folderPath.trim() : "";
    const folderPaths = Array.isArray(body?.folderPaths)
      ? body.folderPaths.filter((p: unknown): p is string => typeof p === "string" && !!p)
      : [];
    const specificIds = Array.isArray(body?.assetIds)
      ? body.assetIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    const excludeIds = Array.isArray(body?.excludeIds)
      ? body.excludeIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    const forceAll = Boolean(body?.forceAll);

    let allAssets: DAMAssetRow[] = [];
    if (specificIds.length > 0) {
      // Chunk specificIds into blocks of 40 to prevent HTTP 414 URI length errors
      const CHUNK_SIZE = 40;
      // Fetch up to the needed batch size + buffer (max 120 per request)
      const targetIds = specificIds.slice(0, Math.max(limit * 3, 120));
      for (let i = 0; i < targetIds.length; i += CHUNK_SIZE) {
        const chunk = targetIds.slice(i, i + CHUNK_SIZE);
        const { data, error } = await supabaseAdmin
          .from("common_dam_assets")
          .select(
            "id, drive_file_id, name, folder_path, tags, macro_portfolio, core_sector, sub_sectors, mime_type"
          )
          .in("id", chunk);
        if (error) throw new Error(error.message);
        if (data) {
          allAssets.push(...(data as unknown as DAMAssetRow[]));
        }
      }
    } else {
      allAssets = await fetchAllMatchingAssets(
        folderPath,
        folderPaths,
        "id, drive_file_id, name, folder_path, tags, macro_portfolio, core_sector, sub_sectors, mime_type"
      );
    }

    // Filter to taggable media (images and PDFs)
    let candidates = allAssets.filter((a) =>
      a.mime_type && (a.mime_type.startsWith("image/") || a.mime_type === "application/pdf")
    );

    // Exclude previously attempted asset IDs in this run
    if (excludeIds.length > 0) {
      const excludeSet = new Set(excludeIds);
      candidates = candidates.filter((a) => !excludeSet.has(a.id));
    }

    // Skip already-tagged assets even when explicit assetIds were sent — the
    // client batches from a list snapshot, and anything tagged since (by a
    // parallel run, or a batch retried after a network drop) must not be
    // re-tagged. forceAll remains the explicit re-tag override.
    if (!forceAll) {
      candidates = candidates.filter(isUntagged);
    }

    const totalMatching = candidates.length;
    const batch = candidates.slice(0, limit);

    if (batch.length === 0) {
      return NextResponse.json({
        processed: 0,
        tagged: 0,
        failed: 0,
        remaining: 0,
        results: [],
        message: "No untagged image assets found to process.",
      });
    }

    const tree = await getTaxonomyTree();
    const vocab = buildVocab(tree);
    const facetScaffold = buildFacetScaffold(tree);

    let taggedCount = 0;
    let failedCount = 0;
    const results: {
      id: string;
      name: string;
      folderPath?: string;
      driveFileId?: string;
      status: "success" | "failed";
      tags?: string[];
      macro?: string | null;
      core?: string | null;
      spaceType?: string | null;
      error?: string;
    }[] = [];

    const startedAt = Date.now();
    for (const asset of batch) {
      // Stop starting new images once the time budget is spent; whatever is
      // missing from `results` gets re-queued by the client. Keeps the
      // request far away from the platform timeout even when images are slow.
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      try {
        // 1. Fetch image bytes from Google Drive — Drive's ~1600px thumbnail
        // when available (fast, decodable), the original only as fallback.
        const { buffer, mimeType } = await getDriveImageForClassification(
          asset.drive_file_id
        );

        // 2. Classify image with Gemini Vision AI & apply taxonomy
        const tagged = await autoTagImage({
          image: buffer,
          mimeType,
          folderPath: asset.folder_path,
          existingTags: asset.tags ?? [],
          tree,
          vocab,
          facetScaffold,
          fallbackOnError: false,
        });

        // 3. Update database row
        const { error: updateErr } = await supabaseAdmin
          .from("common_dam_assets")
          .update({
            tags: tagged.tags,
            macro_portfolio: tagged.macro_portfolio,
            core_sector: tagged.core_sector,
            sub_sectors: tagged.sub_sectors,
          })
          .eq("id", asset.id);

        if (updateErr) throw new Error(updateErr.message);

        taggedCount++;
        results.push({
          id: asset.id,
          name: asset.name,
          folderPath: asset.folder_path,
          driveFileId: asset.drive_file_id,
          status: "success",
          tags: tagged.tags,
          macro: tagged.macro_portfolio,
          core: tagged.core_sector,
          spaceType: tagged.space_type,
        });
      } catch (err) {
        // Only a GLOBAL failure aborts the batch: no API key means AI is off
        // for every image, so there's no point continuing. A per-image problem
        // (an undecodable file -> UnsupportedMediaError, a transient Gemini
        // error, a Drive hiccup) must NOT abort — skip that one asset and keep
        // tagging the rest, or a single bad file blocks the whole library.
        if (err instanceof ClassifierUnavailableError) {
          return NextResponse.json(
            {
              error: err.message,
              disabled: true,
            },
            { status: 400 }
          );
        }
        failedCount++;
        const msg = err instanceof Error ? err.message : "Classification failed";
        console.error(`Auto-tag error for asset ${asset.id} (${asset.name}):`, err);
        results.push({
          id: asset.id,
          name: asset.name,
          folderPath: asset.folder_path,
          driveFileId: asset.drive_file_id,
          status: "failed",
          error: msg,
        });
      }
    }

    // results.length, not batch.length — the time budget may have cut the
    // batch short, and unprocessed assets must count as remaining.
    const remaining = Math.max(0, totalMatching - results.length);

    // Tag counts changed — drop the cached facet list.
    clearTagCountCache();

    return NextResponse.json({
      processed: results.length,
      tagged: taggedCount,
      failed: failedCount,
      remaining,
      results,
    });
  } catch (error) {
    console.error("POST /api/autotag error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process auto-tagging.",
      },
      { status: 500 }
    );
  }
}
