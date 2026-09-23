import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Schema,
  type ThinkingConfig,
} from "@google/genai";
import sharp from "sharp";
import {
  isPrimaryMacro,
  normalizeSelection,
  type MacroPortfolio,
} from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";
import type { ImageAssessment, VisualSearchSummary } from "@/lib/types";

// Server-side only. Classifies an architecture / interior image into the dwp
// taxonomy using Google Gemini vision. Defaults to gemini-3.6-flash; override
// with GEMINI_MODEL. Requires GEMINI_API_KEY.

// AI is switched off entirely (no API key). A GLOBAL condition — a whole batch
// should stop, and the upload flow should silently fall back to the manual picker.
export class ClassifierUnavailableError extends Error {}

// A single image could not be decoded for classification (corrupt file, or a
// format sharp can't rasterise). A PER-IMAGE condition — batch callers skip
// THIS asset and carry on; they must NOT treat it as "AI is off". Kept as a
// separate class (not a subclass) so `instanceof ClassifierUnavailableError`
// stays false for it.
export class UnsupportedMediaError extends Error {}

const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";

let _client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ClassifierUnavailableError(
      "GEMINI_API_KEY is not set — AI classification is disabled."
    );
  }
  if (!_client) _client = new GoogleGenAI({ apiKey });
  return _client;
}

// The taxonomy is user-editable (Settings → Tag Settings, DB-backed), so the
// prompt, response-schema enums, and validation vocabulary are all built per
// call from the current tree. taxonomyStore caches reads, so this adds no DB
// round-trip per image in practice.
//
// IMPORTANT: Gemini rejects response schemas whose constraint graph branches
// too much — the error is an explicit "too much branching for serving" on
// some models but just a bare 400 INVALID_ARGUMENT on others. Embedding the
// full tag vocabulary as enums (120+ values, twice: sub_sectors AND
// preset_tags) is exactly that failure, and it broke every classification
// request at once. So enums are only attached to the two single-value fields,
// and only while they stay small; the tag arrays are plain strings. The
// vocabulary still reaches the model through the prompt, and classifyImage()
// validates every returned name against the taxonomy afterwards anyway.
const ENUM_LIMIT = 60;

function buildSchema(tree: MacroPortfolio[]): Schema {
  const primary = tree.filter((m) => isPrimaryMacro(m.name));
  const macroNames = Array.from(new Set(primary.map((m) => m.name))).filter(
    Boolean
  );
  const coreNames = Array.from(
    new Set(primary.flatMap((m) => m.coreSectors.map((c) => c.name)))
  ).filter(Boolean);

  const singleSelect = (names: string[]): Schema =>
    names.length > 0 && names.length <= ENUM_LIMIT
      ? { type: Type.STRING, enum: names }
      : { type: Type.STRING };

  return {
    type: Type.OBJECT,
    properties: {
      macro_portfolio: singleSelect(macroNames),
      core_sector: singleSelect(coreNames),
      sub_sectors: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      preset_tags: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      visual_tags: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      space_type: { type: Type.STRING },
      style_keywords: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
    },
    required: ["macro_portfolio", "core_sector", "sub_sectors", "preset_tags", "visual_tags"],
    propertyOrdering: [
      "macro_portfolio",
      "core_sector",
      "sub_sectors",
      "preset_tags",
      "visual_tags",
      "space_type",
      "style_keywords",
    ],
  };
}

function buildPrompt(tree: MacroPortfolio[]): string {
  const asText = (macros: MacroPortfolio[]): string =>
    macros
      .map(
        (m) =>
          `${m.name}:\n` +
          m.coreSectors
            .map((c) => `  - ${c.name}: ${c.subSectors.join(", ")}`)
            .join("\n")
      )
      .join("\n");

  const primaryText = asText(tree.filter((m) => isPrimaryMacro(m.name)));
  const facetText = asText(tree.filter((m) => !isPrimaryMacro(m.name)));

  return (
    "You are an expert architecture & interior design asset manager classifying assets (photographs, presentation decks, architectural drawings, project PDFs) for dwp's " +
    "Digital Asset Manager. Analyze the image or PDF document thoroughly to provide precise taxonomy classification AND rich, detailed architectural & interior tags.\n\n" +
    "Classification Instructions:\n" +
    "1. MACRO PORTFOLIO & CORE SECTOR: Pick exactly one Macro Portfolio and one Core Sector belonging to it, " +
    "chosen ONLY from the PRIMARY SECTORS list below, that best describes WHAT THE PHOTOGRAPH OR DOCUMENT DEPICTS " +
    "(e.g. a hotel lobby → Lifestyle → Hospitality; luxury apartment → Lifestyle → Residential; office → Workplace → Commercial Office). " +
    "NEVER pick a Macro Portfolio or Core Sector from the FACET TAGS section for these two fields.\n" +
    "2. SUB-SECTOR TAGS (TYPOLOGIES): From the chosen Core Sector, select 1 to 5 specific sub-sector typologies " +
    "that describe the space, function, or design features visible (e.g. Luxury Resort, Fine Dining, High-Rise Residential, Executive Workplace).\n" +
    "3. PRESET TAGS: Select 0 to 6 additional tags that are clearly supported by the image, drawn from ANY row below — " +
    "this INCLUDES the FACET TAGS (location, climate/setting, sustainability, etc.). Do not guess a location you cannot see.\n" +
    "4. VISUAL & ARCHITECTURAL TAGS (CRITICAL): Provide 4 to 12 specific, high-precision visual and architectural tags " +
    "describing visible materials (e.g. marble floor, timber slats, fluted glass, terrazzo, brass accents, exposed concrete), " +
    "architectural elements (e.g. floor-to-ceiling windows, double-height ceiling, curved partition, spiral staircase, skylight, infinity pool), " +
    "furniture & layout (e.g. sculptural armchair, modular sofa, boardroom table, open plan layout, bar counter, island bench), " +
    "and lighting features (e.g. pendant lighting, linear LED, recessed spotlights, cove lighting, natural daylight).\n" +
    "5. SPACE TYPE: 1 concise name for the specific room/zone (e.g. Living Room, Hotel Lobby, Executive Boardroom, Master Bedroom, Rooftop Bar, Reception Lounge, Restroom, Exterior Facade).\n" +
    "6. STYLE KEYWORDS: 2 to 5 design style descriptors (e.g. contemporary luxury, biophilic modernism, minimalist, industrial chic, warm neutral).\n\n" +
    "PRIMARY SECTORS (choose the Macro Portfolio + Core Sector from these ONLY):\n" +
    primaryText +
    "\n\nFACET TAGS (may be used ONLY as preset_tags, never as the primary sector):\n" +
    facetText +
    "\n\nRespond with a single JSON object of exactly this shape:\n" +
    '{"macro_portfolio": string, "core_sector": string, "sub_sectors": string[], "preset_tags": string[], "visual_tags": string[], "space_type": string, "style_keywords": string[]}\n' +
    "macro_portfolio and core_sector MUST be copied verbatim from PRIMARY SECTORS. " +
    "sub_sectors and preset_tags MUST be copied verbatim from the taxonomy lists above. " +
    "visual_tags, space_type, and style_keywords should be detailed, natural architectural/interior design terms."
  );
}

// Longest edge (px) of the JPEG we hand to Gemini. This is ONLY the model's
// input — the original file in Drive is never modified. Two reasons to re-encode
// every image here rather than forward the raw bytes:
//   1. Format — Gemini reads jpeg/png/webp/heic but NOT tiff/gif/bmp, which the
//      DAM's Drive originals include; sharp rasterises them to jpeg.
//   2. Size — originals are often huge (uncompressed TIFFs run 40–60 MB), well
//      over Gemini's ~20 MB inline-request limit. A ~1568px jpeg is a few
//      hundred KB and loses no detail the vision model can use.
// The in-memory jpeg is discarded as soon as the request returns; nothing is
// written back to Drive.
const MAX_EDGE = 1568;

async function toGeminiJpegBase64(
  base64: string,
  mediaType: string
): Promise<string> {
  try {
    const jpeg = await sharp(Buffer.from(base64, "base64"), { failOn: "none" })
      .rotate() // apply EXIF orientation before the metadata is dropped
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return jpeg.toString("base64");
  } catch (err) {
    // Genuinely undecodable (corrupt, or a vector format sharp can't rasterise).
    // Per-image problem — see UnsupportedMediaError.
    throw new UnsupportedMediaError(
      `Could not decode ${mediaType || "image"} for classification: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// Retry transient Gemini failures (rate limit / temporary unavailability) with
// exponential backoff + jitter. Everything else throws immediately.
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { status?: number; code?: number };
      const status = e?.status ?? e?.code;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        status === 429 ||
        status === 500 ||
        status === 503 ||
        /\b(429|500|503|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL)\b/.test(msg);
      if (!retryable || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
      delay *= 2;
    }
  }
}

// Two knobs of this request are model-dependent, and BOTH report their refusal
// as the same opaque 400 — "Request contains an invalid argument." — with no
// hint of which field is at fault:
//
//   1. responseSchema — refused when a taxonomy edit balloons its constraint
//      graph past the serving limit (see the ENUM_LIMIT note above).
//   2. thinkingConfig — how you switch reasoning off keeps changing per model:
//        gemini-2.5-flash / 3.5-flash  →  thinkingBudget: 0
//        gemini-3.6-flash              →  REJECTS thinkingBudget outright;
//                                         wants thinkingLevel: MINIMAL
//        gemini-3.7-flash, *-latest    →  reject MINIMAL, take the budget again
//      (Verified against the live API 2026-08-19. `thinkingBudget: 0` on
//      gemini-3.6-flash is what broke every classification at once: the 400
//      came back before the model ever looked at the image.)
//
// GEMINI_MODEL is env-configurable, so neither dialect can be hardcoded. The
// request config is therefore a LADDER, most-preferred rung first: an
// INVALID_ARGUMENT steps down one rung and retries, and the rung that answers
// is remembered for the rest of the process so later images pay no doomed
// round-trips. Reasoning is worthless for classification, so the rungs that
// silence it come first; the rungs that let the model think raise
// maxOutputTokens, because thought tokens are charged against that same budget
// and would otherwise truncate the JSON.
interface ConfigRung {
  schema: boolean;
  thinking: ThinkingConfig | null;
  maxOutputTokens: number;
}

const CONFIG_LADDER: ConfigRung[] = [
  {
    schema: true,
    thinking: { thinkingLevel: ThinkingLevel.MINIMAL },
    maxOutputTokens: 2048,
  },
  { schema: true, thinking: { thinkingBudget: 0 }, maxOutputTokens: 2048 },
  { schema: true, thinking: null, maxOutputTokens: 8192 },
  { schema: false, thinking: null, maxOutputTokens: 8192 },
];

// Lowest rung known to work with the configured model. Only ever moves down,
// and only once a request has actually succeeded there.
let workingRung = 0;

// A 400 that plausibly means "this model won't accept that config field", i.e.
// worth retrying one rung down. A bad or blocked key is a 400 too but is NOT a
// config problem — walking the ladder for it would burn four requests per image
// and bury the real cause, so those keep surfacing immediately.
function isConfigRejection(err: unknown): boolean {
  const e = err as { status?: number; code?: number };
  const status = e?.status ?? e?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|NOT_FOUND/i.test(msg)
  ) {
    return false;
  }
  return status === 400 || /INVALID_ARGUMENT|too much branching/i.test(msg);
}

export async function classifyImage(
  base64: string,
  mediaType: string
): Promise<ImageAssessment> {
  // Fail fast if AI is switched off entirely (no key). This is a GLOBAL
  // condition (ClassifierUnavailableError), checked before we touch the image
  // so it can't be confused with a single image we can't decode below.
  const client = getClient();

  // If the file is a PDF, send it directly to Gemini using native PDF document understanding.
  // For images, re-encode to a right-sized JPEG in memory to fit inline-size limits
  // and convert tiff/gif/bmp/heic into a supported format.
  const isPdf = mediaType.toLowerCase() === "application/pdf";
  const inlinePart = isPdf
    ? { inlineData: { mimeType: "application/pdf", data: base64 } }
    : {
        inlineData: {
          mimeType: "image/jpeg",
          data: await toGeminiJpegBase64(base64, mediaType),
        },
      };

  // Current user-editable taxonomy (cached in taxonomyStore; falls back to
  // built-in defaults on any DB problem).
  const tree = await getTaxonomyTree();
  const prompt = buildPrompt(tree);

  const contents = [
    {
      role: "user",
      parts: [
        inlinePart,
        { text: prompt },
      ],
    },
  ];

  // `rung` selects the config dialect (see CONFIG_LADDER); `withSchema: false`
  // additionally drops the response schema for that one call.
  const request = (rung: number, withSchema = true) => {
    const cfg = CONFIG_LADDER[rung];
    return withRetry(() =>
      client.models.generateContent({
        model: MODEL,
        contents,
        config: {
          responseMimeType: "application/json",
          ...(withSchema && cfg.schema
            ? { responseSchema: buildSchema(tree) }
            : {}),
          maxOutputTokens: cfg.maxOutputTokens,
          // Deterministic output for classification — non-zero temperature
          // occasionally produced malformed JSON on degenerate images.
          temperature: 0,
          ...(cfg.thinking ? { thinkingConfig: cfg.thinking } : {}),
        },
      })
    );
  };

  // Walk down the ladder from the last rung known to work: each rung either
  // answers (and is remembered) or is refused as an invalid argument, in which
  // case the next rung drops one more thing this model dislikes. The bottom
  // rung carries no schema at all — the prompt pins the JSON shape and
  // vocabulary and every field is validated below, so an image is never failed
  // merely because the structured-output config was rejected.
  let response;
  let usedRung = workingRung;
  let lastError: unknown;
  for (let rung = workingRung; rung < CONFIG_LADDER.length; rung++) {
    try {
      response = await request(rung);
      usedRung = rung;
      workingRung = rung;
      break;
    } catch (err) {
      if (!isConfigRejection(err)) throw err;
      lastError = err;
    }
  }
  if (!response) {
    // Every rung was refused, so the 400 is about something other than the
    // config (bad key, blocked model, oversized image) — surface it.
    throw lastError;
  }

  interface RawAssessment {
    macro_portfolio?: string;
    core_sector?: string;
    sub_sectors?: string[];
    preset_tags?: string[];
    visual_tags?: string[];
    space_type?: string;
    style_keywords?: string[];
  }

  // Parse with salvage: even in JSON mode the model very occasionally wraps
  // the object in stray text — grab the outermost {...} block before giving up.
  const parseAssessment = (text: string): RawAssessment | null => {
    try {
      return JSON.parse(text) as RawAssessment;
    } catch {}
    const block = text.match(/\{[\s\S]*\}/)?.[0];
    if (block) {
      try {
        return JSON.parse(block) as RawAssessment;
      } catch {}
    }
    return null;
  };

  let text = response.text;
  let raw = text ? parseAssessment(text) : null;
  if (!raw) {
    // Rare intermittent malformed/empty output — one schema-less resample
    // (the prompt pins the JSON shape) rescues it instead of failing the image.
    response = await request(usedRung, false);
    text = response.text;
    raw = text ? parseAssessment(text) : null;
  }
  if (!text) {
    throw new Error("Classifier returned no text content.");
  }
  if (!raw) {
    throw new Error("Classifier returned unparseable JSON.");
  }

  // Validate preset tags strictly against the taxonomy's tag vocabulary
  // (canonical casing, deduped, capped)
  const vocab = new Map(
    tree.flatMap((m) =>
      m.coreSectors.flatMap((c) =>
        c.subSectors.map((t) => [t.toLowerCase(), t] as const)
      )
    )
  );
  const seen = new Set<string>();
  const presetTags: string[] = [];
  for (const t of Array.isArray(raw.preset_tags) ? raw.preset_tags : []) {
    if (typeof t !== "string") continue;
    const canonical = vocab.get(t.trim().toLowerCase());
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    presetTags.push(canonical);
    if (presetTags.length >= 8) break;
  }

  // Extract and clean detailed visual/architectural tags
  const visualTags: string[] = [];
  const seenVisual = new Set<string>();
  for (const t of Array.isArray(raw.visual_tags) ? raw.visual_tags : []) {
    if (typeof t !== "string") continue;
    const clean = t.trim().replace(/^#+/, "").toLowerCase();
    if (clean.length >= 2 && clean.length <= 40 && !seenVisual.has(clean)) {
      seenVisual.add(clean);
      visualTags.push(clean);
      if (visualTags.length >= 12) break;
    }
  }

  // Extract space type and style keywords
  const spaceType =
    typeof raw.space_type === "string" && raw.space_type.trim().length > 1
      ? raw.space_type.trim()
      : undefined;

  const styleKeywords: string[] = [];
  for (const s of Array.isArray(raw.style_keywords) ? raw.style_keywords : []) {
    if (typeof s !== "string") continue;
    const clean = s.trim().toLowerCase();
    if (clean.length >= 2 && !styleKeywords.includes(clean)) {
      styleKeywords.push(clean);
      if (styleKeywords.length >= 5) break;
    }
  }

  // Enforce taxonomy consistency (repairs macro from core, drops stray tags).
  return {
    ...normalizeSelection(raw, tree),
    presetTags,
    visualTags,
    spaceType,
    styleKeywords,
  };
}

// Analyzes an image deeply to extract rich visual search features for reverse image similarity search
export async function analyzeVisualFeatures(
  base64: string,
  mediaType: string
): Promise<VisualSearchSummary> {
  const client = getClient();
  const isPdf = mediaType.toLowerCase() === "application/pdf";
  const inlinePart = isPdf
    ? { inlineData: { mimeType: "application/pdf", data: base64 } }
    : {
        inlineData: {
          mimeType: "image/jpeg",
          data: await toGeminiJpegBase64(base64, mediaType),
        },
      };
  const tree = await getTaxonomyTree();

  const primaryMacros = tree.filter((m) => isPrimaryMacro(m.name));
  const primaryMacroNames = primaryMacros.map((m) => m.name).join(", ");
  const coreSectorNames = Array.from(
    new Set(primaryMacros.flatMap((m) => m.coreSectors.map((c) => c.name)))
  ).join(", ");

  const prompt =
    "You are an expert architecture, interior design, and visual search AI for dwp's Digital Asset Management library.\n" +
    "Analyze this image or document thoroughly to extract rich visual search features for reverse image similarity matching against a library of 34,000+ architectural & interior design photos.\n\n" +
    `VALID PRIMARY MACRO PORTFOLIOS: ${primaryMacroNames}\n` +
    `VALID CORE SECTORS: ${coreSectorNames}\n\n` +
    "Instructions:\n" +
    "1. MACRO PORTFOLIO & CORE SECTOR: Best matching primary sector depicting what the image is of.\n" +
    "2. SUB-SECTOR TYPOLOGIES: 1 to 5 typologies describing the space function (e.g. Luxury Resort, Fine Dining, Flexible Workspace, Super-Luxury Villas, Creative Studio, High-Rise Residential, Wellness Spa).\n" +
    "3. VISUAL TAGS: 5 to 15 specific visual descriptors of architectural elements, materials, furniture, lighting, and layout (e.g. timber slats, curved glass, infinity pool, biophilic green wall, double-height atrium, marble floor, terrazzo, pendant lighting, open plan, outdoor terrace).\n" +
    "4. STYLE KEYWORDS: 3 to 8 style terms (e.g. contemporary luxury, biophilic modernism, minimalist, industrial chic, warm neutral, brutalist, hospitality luxury).\n" +
    "5. DOMINANT COLORS: 2 to 5 primary color tones (e.g. warm teak, charcoal black, terracotta, off-white, bronze, sage green).\n" +
    "6. VISUAL DESCRIPTION: 1 concise sentence describing the visual scene.\n" +
    "7. SPACE TYPE: The specific space/room zone (e.g. Hotel Lobby, Executive Boardroom, Guest Suite, Rooftop Lounge, Infinity Pool Deck, Facade, Restaurant Dining).\n\n" +
    "Return a JSON object with this exact shape:\n" +
    '{"macro_portfolio": string, "core_sector": string, "sub_sectors": string[], "tags": string[], "style_keywords": string[], "dominant_colors": string[], "visual_description": string, "space_type": string}';

  const contents = [
    {
      role: "user",
      parts: [
        inlinePart,
        { text: prompt },
      ],
    },
  ];

  const res = await withRetry(() =>
    client.models.generateContent({
      model: MODEL,
      contents,
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
        temperature: 0.1,
      },
    })
  );

  const text = res.text || "";
  let raw: {
    macro_portfolio?: string;
    core_sector?: string;
    sub_sectors?: string[];
    tags?: string[];
    style_keywords?: string[];
    dominant_colors?: string[];
    visual_description?: string;
    space_type?: string;
  } | null = null;

  try {
    raw = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        raw = JSON.parse(match[0]);
      } catch {}
    }
  }

  if (!raw) {
    throw new Error("Visual search analysis returned unparseable output.");
  }

  const cleanArr = (arr: unknown): string[] =>
    Array.isArray(arr)
      ? arr
          .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
          .map((x) => x.trim())
      : [];

  const norm = normalizeSelection(
    {
      macro_portfolio: raw.macro_portfolio,
      core_sector: raw.core_sector,
      sub_sectors: cleanArr(raw.sub_sectors),
    },
    tree
  );

  return {
    macro_portfolio: norm.macro_portfolio,
    core_sector: norm.core_sector,
    sub_sectors: norm.sub_sectors,
    tags: cleanArr(raw.tags),
    styleKeywords: cleanArr(raw.style_keywords),
    dominantColors: cleanArr(raw.dominant_colors),
    visualDescription:
      typeof raw.visual_description === "string"
        ? raw.visual_description.trim()
        : "",
    spaceType:
      typeof raw.space_type === "string" ? raw.space_type.trim() : undefined,
  };
}

