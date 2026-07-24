import { NextRequest, NextResponse } from "next/server";
import { getDriveImageForClassification } from "@/lib/googleDrive";
import { classifyImage, ClassifierUnavailableError } from "@/lib/gemini";
import { supabaseAdmin } from "@/lib/supabase";
import {
  deriveSelectionFromTags,
  isPrimaryMacro,
  normalizeTags,
  type MacroPortfolio,
} from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

// One POST stops starting new images once this much time has passed and
// returns what it finished — well inside Cloud Run's 300 s request timeout.
// (A batch of large originals used to run past the timeout, and the browser
// saw a dead connection: "Failed to fetch".) The client re-queues whatever
// wasn't processed.
const TIME_BUDGET_MS = 45_000;

// Cap on how many untagged asset IDs GET hands out per call (the client
// works through them and refreshes the list when done).
const MAX_IDS = 20_000;

function buildVocab(tree: MacroPortfolio[]): Map<string, string> {
  const vocab = new Map<string, string>();
  for (const m of tree) {
    if (!vocab.has(m.name.toLowerCase())) vocab.set(m.name.toLowerCase(), m.name);
    for (const c of m.coreSectors) {
      if (!vocab.has(c.name.toLowerCase()))
        vocab.set(c.name.toLowerCase(), c.name);
      for (const t of c.subSectors) {
        if (!vocab.has(t.toLowerCase())) vocab.set(t.toLowerCase(), t);
      }
    }
  }
  return vocab;
}

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
  fields = "id, folder_path, tags, macro_portfolio, core_sector, mime_type"
): Promise<DAMAssetRow[]> {
  const PAGE_SIZE = 1000;
  let page = 0;
  let all: DAMAssetRow[] = [];

  while (true) {
    let query = supabaseAdmin
      .from("common_dam_assets")
      .select(fields)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (folderPath) {
      query = query.or(
        `folder_path.eq.${folderPath},folder_path.like.${folderPath}/%`
      );
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
  const hasNoTags = !asset.tags || asset.tags.length === 0;
  const hasNoTaxonomy = !asset.macro_portfolio || !asset.core_sector;
  const facetOnly = !!asset.macro_portfolio && !isPrimaryMacro(asset.macro_portfolio);
  return hasNoTags || hasNoTaxonomy || facetOnly;
}

// GET /api/autotag
// Returns summary statistics of untagged image assets in dwp.dam.
// With ?includeIds=1 the response also carries the untagged asset IDs (capped
// at MAX_IDS) — the auto-tag run works through that fixed list in small
// POST batches instead of re-deriving "what's untagged" on every batch.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const folderPath = searchParams.get("folderPath") || "";
    const includeIds = searchParams.get("includeIds") === "1";

    const assets = await fetchAllMatchingAssets(folderPath);

    const totalAssets = assets.length;
    const imageAssets = assets.filter((a) =>
      a.mime_type && a.mime_type.startsWith("image/")
    );
    const untaggedImages = imageAssets.filter(isUntagged);

    return NextResponse.json({
      total: totalAssets,
      totalImages: imageAssets.length,
      untaggedCount: untaggedImages.length,
      ...(includeIds
        ? { untaggedIds: untaggedImages.slice(0, MAX_IDS).map((a) => a.id) }
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
    const specificIds = Array.isArray(body?.assetIds)
      ? body.assetIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    const excludeIds = Array.isArray(body?.excludeIds)
      ? body.excludeIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    const forceAll = Boolean(body?.forceAll);

    let allAssets: DAMAssetRow[];
    if (specificIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("common_dam_assets")
        .select(
          "id, drive_file_id, name, folder_path, tags, macro_portfolio, core_sector, sub_sectors, mime_type"
        )
        .in("id", specificIds);
      if (error) throw new Error(error.message);
      allAssets = (data as unknown as DAMAssetRow[]) ?? [];
    } else {
      allAssets = await fetchAllMatchingAssets(
        folderPath,
        "id, drive_file_id, name, folder_path, tags, macro_portfolio, core_sector, sub_sectors, mime_type"
      );
    }

    // Filter to images
    let candidates = allAssets.filter((a) =>
      a.mime_type && a.mime_type.startsWith("image/")
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

    // Pure structural names of facet macros / core sectors — e.g. "location
    // matrix", "global region", "studio hub (jurisdiction)". These are
    // scaffolding, never descriptive tags, so strip them from the written tag
    // set: re-tagged rows shed the stale "location matrix / global region"
    // labels the bulk import left behind, and they never reappear.
    //   • Facet SUB-sector tags ("australia", "coastal") are kept — useful.
    //   • A facet whose core name IS its own tag (e.g. "Biophilic Design",
    //     "Award Winner") is a real tag, so anything that also exists as a
    //     sub-sector is excluded from the scaffold set and kept.
    const subVocab = new Set<string>();
    for (const m of tree)
      for (const c of m.coreSectors)
        for (const s of c.subSectors) subVocab.add(s.toLowerCase());

    const facetScaffold = new Set<string>();
    for (const m of tree) {
      if (isPrimaryMacro(m.name)) continue;
      const macroL = m.name.toLowerCase();
      if (!subVocab.has(macroL)) facetScaffold.add(macroL);
      for (const c of m.coreSectors) {
        const coreL = c.name.toLowerCase();
        if (!subVocab.has(coreL)) facetScaffold.add(coreL);
      }
    }

    let taggedCount = 0;
    let failedCount = 0;
    const results: {
      id: string;
      name: string;
      status: "success" | "failed";
      tags?: string[];
      macro?: string | null;
      core?: string | null;
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
        const base64 = buffer.toString("base64");

        // 2. Classify image with Gemini Vision AI
        const assessment = await classifyImage(base64, mimeType);

        // 3. Extract folder path taxonomy terms
        const pathSegments = asset.folder_path
          .split("/")
          .map((s: string) => s.trim())
          .filter(Boolean);
        const folderTags = pathSegments
          .map((s: string) => vocab.get(s.toLowerCase()))
          .filter((s: string | undefined): s is string => Boolean(s));

        // 4. Taxonomy selection (AI selection takes priority, fall back to derived from tags)
        let macro_portfolio = assessment.macro_portfolio;
        let core_sector = assessment.core_sector;
        let sub_sectors = assessment.sub_sectors || [];

        // 5. Combine sub-sectors (sub-tags), macro, core, preset tags, folder tags, and existing tags
        const existingTags = Array.isArray(asset.tags) ? asset.tags : [];
        const combinedRaw = [
          ...existingTags,
          ...folderTags,
          ...(macro_portfolio ? [macro_portfolio] : []),
          ...(core_sector ? [core_sector] : []),
          ...sub_sectors,
          ...(assessment.presetTags || []),
        ];
        // normalizeTags lower-cases + dedupes; then drop facet scaffolding
        // names ("location matrix", "global region", ...) that shouldn't live
        // in the tag list. macro_portfolio/core_sector below are primary-only,
        // so this never removes the real sector tags.
        const tags = normalizeTags(combinedRaw, 20).filter(
          (t) => !facetScaffold.has(t)
        );

        if (!macro_portfolio || !core_sector) {
          const derived = deriveSelectionFromTags(tags, tree);
          macro_portfolio = macro_portfolio || derived.macro_portfolio;
          core_sector = core_sector || derived.core_sector;
          if (!sub_sectors || sub_sectors.length === 0) {
            sub_sectors = derived.sub_sectors;
          }
        }

        // 6. Update database row
        const { error: updateErr } = await supabaseAdmin
          .from("common_dam_assets")
          .update({
            tags,
            macro_portfolio,
            core_sector,
            sub_sectors,
          })
          .eq("id", asset.id);

        if (updateErr) throw new Error(updateErr.message);

        taggedCount++;
        results.push({
          id: asset.id,
          name: asset.name,
          status: "success",
          tags,
          macro: macro_portfolio,
          core: core_sector,
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
          status: "failed",
          error: msg,
        });
      }
    }

    // results.length, not batch.length — the time budget may have cut the
    // batch short, and unprocessed assets must count as remaining.
    const remaining = Math.max(0, totalMatching - results.length);

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
