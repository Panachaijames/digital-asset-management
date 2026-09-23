import { classifyImage } from "@/lib/gemini";
import { getTaxonomyTree } from "@/lib/taxonomyStore";
import {
  deriveSelectionFromTags,
  isPrimaryMacro,
  normalizeTags,
  type MacroPortfolio,
} from "@/lib/taxonomy";
import type { ImageAssessment } from "@/lib/types";

/**
 * Builds a canonical case-insensitive vocabulary map of all macro, core,
 * and sub-sector names in the taxonomy tree.
 */
export function buildVocab(tree: MacroPortfolio[]): Map<string, string> {
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

/**
 * Builds a set of pure structural names of facet macros and core sectors
 * (e.g. "location matrix", "global region", "studio hub (jurisdiction)").
 * These are organizational scaffolding rather than descriptive visual tags,
 * so they are excluded from the normalized tag list.
 */
export function buildFacetScaffold(tree: MacroPortfolio[]): Set<string> {
  const subVocab = new Set<string>();
  for (const m of tree) {
    for (const c of m.coreSectors) {
      for (const s of c.subSectors) subVocab.add(s.toLowerCase());
    }
  }

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
  return facetScaffold;
}

export interface ClassificationApplicationInput {
  existingTags?: string[];
  folderPath?: string;
  assessment?: ImageAssessment | null;
  tree: MacroPortfolio[];
  vocab?: Map<string, string>;
  facetScaffold?: Set<string>;
}

export interface AutoTagOutput {
  tags: string[];
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
  space_type?: string;
}

/**
 * Merges existing/caller tags, folder-path terms, and AI classification results
 * into a rich, deduplicated tag array (up to 30 tags) and sets primary sector taxonomy.
 */
export function applyClassificationToTags({
  existingTags = [],
  folderPath = "",
  assessment,
  tree,
  vocab = buildVocab(tree),
  facetScaffold = buildFacetScaffold(tree),
}: ClassificationApplicationInput): AutoTagOutput {
  // 1. Extract folder path taxonomy terms
  const pathSegments = folderPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const folderTags = pathSegments
    .map((s) => vocab.get(s.toLowerCase()))
    .filter((s): s is string => Boolean(s));

  // 2. Clean incoming tags (strip leading '#' from hashtags like '#request')
  const cleanExisting = existingTags
    .map((t) => t.trim().replace(/^#+/, ""))
    .filter(Boolean);

  if (assessment) {
    let macro_portfolio = assessment.macro_portfolio;
    let core_sector = assessment.core_sector;
    let sub_sectors = assessment.sub_sectors || [];

    // Combine sub-sectors (sub-tags), macro, core, preset tags, visual & architectural tags,
    // space type, style keywords, folder tags, and existing tags
    const combinedRaw = [
      ...cleanExisting,
      ...folderTags,
      ...(macro_portfolio ? [macro_portfolio] : []),
      ...(core_sector ? [core_sector] : []),
      ...sub_sectors,
      ...(assessment.presetTags || []),
      ...(assessment.visualTags || []),
      ...(assessment.spaceType ? [assessment.spaceType] : []),
      ...(assessment.styleKeywords || []),
    ];

    // normalizeTags lower-cases + dedupes (up to 30 rich tags); drop facet scaffolding names
    const tags = normalizeTags(combinedRaw, 30).filter(
      (t) => !facetScaffold.has(t)
    );

    // Fallback if AI didn't provide primary macro or core sector
    if (!macro_portfolio || !core_sector) {
      const derived = deriveSelectionFromTags(tags, tree);
      macro_portfolio = macro_portfolio || derived.macro_portfolio;
      core_sector = core_sector || derived.core_sector;
      if (!sub_sectors || sub_sectors.length === 0) {
        sub_sectors = derived.sub_sectors;
      }
    }

    return {
      tags,
      macro_portfolio,
      core_sector,
      sub_sectors,
      space_type: assessment.spaceType,
    };
  }

  // Fallback when no AI assessment is available: derive from clean existing tags + folder tags
  const initialTags = normalizeTags([...cleanExisting, ...folderTags], 30);
  const derived = deriveSelectionFromTags(initialTags, tree);
  const tags = normalizeTags(
    [
      ...initialTags,
      ...(derived.macro_portfolio ? [derived.macro_portfolio] : []),
      ...(derived.core_sector ? [derived.core_sector] : []),
      ...(derived.sub_sectors || []),
    ],
    30
  ).filter((t) => !facetScaffold.has(t));

  return {
    tags,
    macro_portfolio: derived.macro_portfolio,
    core_sector: derived.core_sector,
    sub_sectors: derived.sub_sectors,
  };
}

export interface AutoTagImageInput {
  image: Buffer | string;
  mimeType: string;
  folderPath?: string;
  existingTags?: string[];
  tree?: MacroPortfolio[];
  vocab?: Map<string, string>;
  facetScaffold?: Set<string>;
  fallbackOnError?: boolean;
}

export interface AutoTagImageResult extends AutoTagOutput {
  assessment?: ImageAssessment | null;
  aiClassified: boolean;
  error?: string;
}

/**
 * High-level auto-tagging helper:
 * 1. Analyzes image using Gemini Vision AI (classifyImage)
 * 2. Combines AI insights with caller tags, folder path terms, and sector taxonomy
 * 3. Returns rich tags (~14+ tags), macro_portfolio, core_sector, and sub_sectors
 *
 * If AI classification fails and fallbackOnError is true (default), falls back
 * gracefully to folder/caller tags so the operation does not crash.
 */
export async function autoTagImage({
  image,
  mimeType,
  folderPath = "",
  existingTags = [],
  tree,
  vocab,
  facetScaffold,
  fallbackOnError = true,
}: AutoTagImageInput): Promise<AutoTagImageResult> {
  const activeTree = tree || (await getTaxonomyTree());
  const activeVocab = vocab || buildVocab(activeTree);
  const activeScaffold = facetScaffold || buildFacetScaffold(activeTree);

  const base64 = Buffer.isBuffer(image) ? image.toString("base64") : image;

  try {
    const assessment = await classifyImage(base64, mimeType);
    const tagged = applyClassificationToTags({
      existingTags,
      folderPath,
      assessment,
      tree: activeTree,
      vocab: activeVocab,
      facetScaffold: activeScaffold,
    });

    return {
      ...tagged,
      assessment,
      aiClassified: true,
    };
  } catch (err) {
    if (!fallbackOnError) {
      throw err;
    }

    const msg = err instanceof Error ? err.message : "Classification failed";
    console.warn("[autoTagImage] AI classification failed, falling back to basic tags:", msg);

    const fallback = applyClassificationToTags({
      existingTags,
      folderPath,
      assessment: null,
      tree: activeTree,
      vocab: activeVocab,
      facetScaffold: activeScaffold,
    });

    return {
      ...fallback,
      assessment: null,
      aiClassified: false,
      error: msg,
    };
  }
}
