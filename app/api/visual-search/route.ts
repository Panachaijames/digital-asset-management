import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  analyzeVisualFeatures,
  ClassifierUnavailableError,
  UnsupportedMediaError,
} from "@/lib/gemini";
import { getDriveImageForClassification } from "@/lib/googleDrive";
import type {
  PublishPermission,
  VisualSearchResult,
  VisualSearchSummary,
} from "@/lib/types";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 120;

interface RawAssetRow {
  id: string;
  drive_file_id: string;
  name: string;
  folder_id: string;
  folder_path: string;
  tags: string[] | null;
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[] | null;
  publish_permission: PublishPermission | null;
  mime_type: string;
  size_bytes: number;
  web_view_link: string;
  thumbnail_link: string | null;
  uploaded_by: string | null;
  created_at: string;
}

function isGenericFileName(name: string): boolean {
  const base = name.replace(/\.[^/.]+$/, "").toLowerCase().trim();
  return (
    !base ||
    base === "image" ||
    base === "file" ||
    base === "upload" ||
    base === "screenshot" ||
    base === "download" ||
    base === "blob" ||
    base === "unnamed" ||
    /^image\s*\(\d+\)$/i.test(base) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(base)
  );
}

// Calculate visual similarity score and detect exact image matches
function scoreAssetSimilarity(
  asset: RawAssetRow,
  summary: VisualSearchSummary,
  queryFileInfo?: { fileName?: string; sizeBytes?: number }
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let isExactMatch = false;

  const assetName = asset.name || "";
  const assetNameLower = assetName.toLowerCase().trim();
  const assetTags = (asset.tags || []).map((t) => t.toLowerCase().trim());
  const assetSubs = (asset.sub_sectors || []).map((s) => s.toLowerCase().trim());
  const assetFolderLower = (asset.folder_path || "").toLowerCase();

  // 1. Exact File Identity Check (by Filename & Size)
  if (queryFileInfo?.fileName && !isGenericFileName(queryFileInfo.fileName)) {
    const qNameLower = queryFileInfo.fileName.toLowerCase().trim();
    const qBase = qNameLower.replace(/\.[^/.]+$/, "").replace(/^copy\s+of\s+/i, "").trim();
    const aBase = assetNameLower.replace(/\.[^/.]+$/, "").replace(/^copy\s+of\s+/i, "").trim();

    if (qNameLower === assetNameLower || (qBase.length >= 3 && qBase === aBase)) {
      isExactMatch = true;
      reasons.unshift("Exact original file match");
    } else if (
      aBase.length >= 5 &&
      (qBase.includes(aBase) || aBase.includes(qBase))
    ) {
      reasons.push(`Matching asset name: ${asset.name}`);
    }
  }

  // Exact file size match (within 512 bytes)
  if (
    queryFileInfo?.sizeBytes &&
    asset.size_bytes &&
    Math.abs(Number(asset.size_bytes) - queryFileInfo.sizeBytes) <= 512 &&
    queryFileInfo.sizeBytes > 1000
  ) {
    if (!isExactMatch) {
      isExactMatch = true;
      reasons.unshift("Identical file size signature");
    }
  }

  // 2. Core Sector Match (+25 points) & Portfolio Match (+12 points)
  let sectorPoints = 0;
  if (
    summary.core_sector &&
    asset.core_sector &&
    summary.core_sector.toLowerCase() === asset.core_sector.toLowerCase()
  ) {
    sectorPoints = 25;
    reasons.push(`Sector: ${asset.core_sector}`);
  } else if (
    summary.macro_portfolio &&
    asset.macro_portfolio &&
    summary.macro_portfolio.toLowerCase() === asset.macro_portfolio.toLowerCase()
  ) {
    sectorPoints = 12;
    reasons.push(`Portfolio: ${asset.macro_portfolio}`);
  }

  // 3. Sub-Sector / Typology Match (+15 points each, capped at 30)
  const matchedSubs: string[] = [];
  for (const querySub of summary.sub_sectors) {
    const qLower = querySub.toLowerCase();
    if (assetSubs.some((s) => s === qLower || s.includes(qLower) || qLower.includes(s))) {
      matchedSubs.push(querySub);
    }
  }
  let subPoints = 0;
  if (matchedSubs.length > 0) {
    subPoints = Math.min(30, matchedSubs.length * 15);
    reasons.push(`Typology: ${matchedSubs.join(", ")}`);
  }

  // 4. Visual & Material Tags Match (+8 points each, capped at 45)
  const matchedTags: string[] = [];
  const allQueryTerms = [
    ...summary.tags,
    ...summary.styleKeywords,
    ...summary.dominantColors,
  ];

  for (const term of allQueryTerms) {
    const tLower = term.toLowerCase();
    if (
      assetTags.some((tag) => tag === tLower || tag.includes(tLower) || tLower.includes(tag))
    ) {
      if (!matchedTags.includes(term)) matchedTags.push(term);
    }
  }

  let tagPoints = 0;
  if (matchedTags.length > 0) {
    tagPoints = Math.min(45, matchedTags.length * 9);
    // If the asset has tags and a high percentage of them match, boost score
    if (assetTags.length > 0) {
      const tagRecall = matchedTags.length / assetTags.length;
      if (tagRecall >= 0.6) {
        tagPoints += 15;
      }
    }
    reasons.push(`Visual features: #${matchedTags.slice(0, 4).join(" #")}`);
  }

  // 5. Space Type match bonus
  let spacePoints = 0;
  if (summary.spaceType) {
    const spLower = summary.spaceType.toLowerCase();
    if (
      assetNameLower.includes(spLower) ||
      assetTags.some((t) => t.includes(spLower)) ||
      assetSubs.some((s) => s.includes(spLower)) ||
      assetFolderLower.includes(spLower)
    ) {
      spacePoints = 15;
      if (!reasons.some((r) => r.startsWith("Space:") || r.startsWith("Typology:"))) {
        reasons.push(`Space: ${summary.spaceType}`);
      }
    }
  }

  // 6. Visual Description & Style Keyword match against asset name & folder
  let keywordPoints = 0;
  for (const kw of summary.styleKeywords) {
    const kwLower = kw.toLowerCase();
    if (assetNameLower.includes(kwLower) || assetFolderLower.includes(kwLower)) {
      keywordPoints += 5;
    }
  }
  keywordPoints = Math.min(15, keywordPoints);

  if (isExactMatch) {
    return { score: 100, reasons: reasons.length ? reasons : ["Exact image match"] };
  }

  // Sum raw points
  const rawScore = sectorPoints + subPoints + tagPoints + spacePoints + keywordPoints;

  // Normalized similarity percentage:
  // High quality matches (rawScore >= 80) scale from 85% to 98%
  // Moderate matches (rawScore 50-79) scale from 70% to 84%
  // Baseline matches (rawScore 25-49) scale from 50% to 69%
  let similarityPercentage = 0;
  if (rawScore >= 80) {
    similarityPercentage = Math.min(98, 85 + Math.round(((rawScore - 80) / 40) * 13));
  } else if (rawScore >= 50) {
    similarityPercentage = 70 + Math.round(((rawScore - 50) / 30) * 14);
  } else if (rawScore >= 25) {
    similarityPercentage = 50 + Math.round(((rawScore - 25) / 25) * 19);
  } else if (rawScore > 0) {
    similarityPercentage = 45;
  }

  return { score: similarityPercentage, reasons };
}

// POST /api/visual-search
// Accepts:
// 1. Multipart form data with `image: File`
// 2. JSON body with `{ assetId: string }` or `{ base64: string, mimeType: string, name?: string, size?: number }`
export async function POST(request: NextRequest) {
  try {
    let base64 = "";
    let mimeType = "image/jpeg";
    let queryFileName: string | undefined = undefined;
    let queryFileSize: number | undefined = undefined;
    let excludeAssetId: string | null = null;
    let macroFilter: string | null = null;
    let coreFilter: string | null = null;
    let pathPrefix: string | null = null;
    let limit = DEFAULT_LIMIT;

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const imageFile = formData.get("image") as File | null;
      if (!imageFile) {
        return NextResponse.json(
          { error: "No image file provided in form data." },
          { status: 400 }
        );
      }
      const arrayBuffer = await imageFile.arrayBuffer();
      base64 = Buffer.from(arrayBuffer).toString("base64");
      mimeType = imageFile.type || "image/jpeg";
      queryFileName = imageFile.name || undefined;
      queryFileSize = imageFile.size || undefined;

      macroFilter = (formData.get("macro") as string) || null;
      coreFilter = (formData.get("core") as string) || null;
      pathPrefix = (formData.get("pathPrefix") as string) || null;
      const limitParam = formData.get("limit");
      if (limitParam) limit = Math.min(MAX_LIMIT, Math.max(1, Number(limitParam)));
    } else {
      const body = await request.json().catch(() => ({}));
      macroFilter = body.macro || null;
      coreFilter = body.core || null;
      pathPrefix = body.pathPrefix || null;
      if (body.limit) limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit)));

      if (body.assetId) {
        excludeAssetId = body.assetId;
        const { data: asset, error: assetErr } = await supabaseAdmin
          .from("common_dam_assets")
          .select("id, drive_file_id, mime_type, name, size_bytes")
          .eq("id", body.assetId)
          .single();

        if (assetErr || !asset) {
          return NextResponse.json(
            { error: "Asset not found in DAM catalog." },
            { status: 404 }
          );
        }

        queryFileName = asset.name || undefined;
        queryFileSize = Number(asset.size_bytes) || undefined;

        const driveImage = await getDriveImageForClassification(
          asset.drive_file_id
        );
        base64 = driveImage.buffer.toString("base64");
        mimeType = driveImage.mimeType || asset.mime_type || "image/jpeg";
      } else if (body.base64) {
        base64 = body.base64;
        mimeType = body.mimeType || "image/jpeg";
        queryFileName = body.name || undefined;
        queryFileSize = body.size ? Number(body.size) : undefined;
      } else {
        return NextResponse.json(
          { error: "Please provide either an image upload or an assetId." },
          { status: 400 }
        );
      }
    }

    if (!base64) {
      return NextResponse.json(
        { error: "Could not read image data for visual search." },
        { status: 400 }
      );
    }

    // 1. Analyze visual features using Gemini Vision AI
    const summary = await analyzeVisualFeatures(base64, mimeType);

    // 2. Parallel Multi-Strategy Candidate Retrieval from Supabase
    const candidateMap = new Map<string, RawAssetRow>();
    const queryPromises: Promise<any>[] = [];

    const selectFields =
      "id, drive_file_id, name, folder_id, folder_path, tags, macro_portfolio, core_sector, sub_sectors, publish_permission, mime_type, size_bytes, web_view_link, thumbnail_link, uploaded_by, created_at";

    // Strategy A: Filename match (if original filename is provided and not generic)
    if (queryFileName && !isGenericFileName(queryFileName)) {
      const cleanBase = queryFileName
        .replace(/\.[^/.]+$/, "")
        .replace(/^copy\s+of\s+/i, "")
        .trim();
      if (cleanBase.length >= 3) {
        queryPromises.push(
          Promise.resolve(
            supabaseAdmin
              .from("common_dam_assets")
              .select(selectFields)
              .ilike("name", `%${cleanBase}%`)
              .limit(60)
          )
        );
      }
    }

    // Strategy B: File size signature match
    if (queryFileSize && queryFileSize > 1000) {
      queryPromises.push(
        Promise.resolve(
          supabaseAdmin
            .from("common_dam_assets")
            .select(selectFields)
            .gte("size_bytes", queryFileSize - 1024)
            .lte("size_bytes", queryFileSize + 1024)
            .limit(60)
        )
      );
    }

    // Strategy C: Visual & Material Tag Overlap
    if (summary.tags && summary.tags.length > 0) {
      queryPromises.push(
        Promise.resolve(
          supabaseAdmin
            .from("common_dam_assets")
            .select(selectFields)
            .overlaps("tags", summary.tags.slice(0, 8))
            .limit(250)
        )
      );
    }

    // Strategy D: Sub-sector Typology Overlap
    if (summary.sub_sectors && summary.sub_sectors.length > 0) {
      queryPromises.push(
        Promise.resolve(
          supabaseAdmin
            .from("common_dam_assets")
            .select(selectFields)
            .overlaps("sub_sectors", summary.sub_sectors)
            .limit(200)
        )
      );
    }

    // Strategy E: Sector & Macro Filter/Match
    if (coreFilter) {
      queryPromises.push(
        Promise.resolve(
          supabaseAdmin
            .from("common_dam_assets")
            .select(selectFields)
            .eq("core_sector", coreFilter)
            .limit(300)
        )
      );
    } else if (summary.core_sector) {
      queryPromises.push(
        Promise.resolve(
          supabaseAdmin
            .from("common_dam_assets")
            .select(selectFields)
            .eq("core_sector", summary.core_sector)
            .limit(300)
        )
      );
    }

    // Strategy F: General broad pool of recent assets
    queryPromises.push(
      Promise.resolve(
        supabaseAdmin
          .from("common_dam_assets")
          .select(selectFields)
          .order("created_at", { ascending: false })
          .limit(300)
      )
    );

    // Run all query strategies concurrently
    const queryResults = await Promise.allSettled(queryPromises);
    for (const res of queryResults) {
      if (res.status === "fulfilled" && res.value?.data) {
        for (const row of res.value.data as RawAssetRow[]) {
          if (!candidateMap.has(row.id)) {
            // Apply optional pathPrefix or macroFilter
            if (pathPrefix && !row.folder_path?.startsWith(pathPrefix)) continue;
            if (macroFilter && row.macro_portfolio !== macroFilter) continue;
            candidateMap.set(row.id, row);
          }
        }
      }
    }

    // 3. Multi-Factor Scoring and Ranking
    const scored: VisualSearchResult[] = [];
    const queryFileInfo = {
      fileName: queryFileName,
      sizeBytes: queryFileSize,
    };

    for (const raw of candidateMap.values()) {
      if (excludeAssetId && raw.id === excludeAssetId) continue;

      const { score, reasons } = scoreAssetSimilarity(raw, summary, queryFileInfo);
      if (score >= 45) {
        scored.push({
          id: raw.id,
          drive_file_id: raw.drive_file_id,
          name: raw.name,
          folder_id: raw.folder_id,
          folder_path: raw.folder_path,
          tags: Array.isArray(raw.tags) ? raw.tags : [],
          macro_portfolio: raw.macro_portfolio,
          core_sector: raw.core_sector,
          sub_sectors: Array.isArray(raw.sub_sectors) ? raw.sub_sectors : [],
          mime_type: raw.mime_type,
          size_bytes: Number(raw.size_bytes) || 0,
          publish_permission: raw.publish_permission || "pending",
          web_view_link: raw.web_view_link,
          thumbnail_link: raw.thumbnail_link,
          uploaded_by: raw.uploaded_by,
          created_at: raw.created_at,
          similarityScore: score,
          matchReasons: reasons.length > 0 ? reasons : ["Visual theme match"],
        });
      }
    }

    // Sort by similarity score descending (exact matches at 100% will appear first)
    scored.sort((a, b) => b.similarityScore - a.similarityScore);

    const results = scored.slice(0, limit);

    return NextResponse.json({
      querySummary: summary,
      results,
      totalMatches: scored.length,
    });
  } catch (error) {
    if (error instanceof ClassifierUnavailableError) {
      return NextResponse.json(
        {
          error:
            "Visual search is unavailable because GEMINI_API_KEY is not configured.",
          disabled: true,
        },
        { status: 503 }
      );
    }
    if (error instanceof UnsupportedMediaError) {
      return NextResponse.json(
        {
          error:
            "The image format could not be decoded. Please upload a standard JPG, PNG, WEBP, or HEIC image.",
        },
        { status: 400 }
      );
    }
    console.error("Visual search API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred during visual search.",
      },
      { status: 500 }
    );
  }
}
