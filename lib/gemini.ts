import { GoogleGenAI, Type, type Schema } from "@google/genai";
import sharp from "sharp";
import {
  isPrimaryMacro,
  normalizeSelection,
  type MacroPortfolio,
} from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";
import type { ImageAssessment } from "@/lib/types";

// Server-side only. Classifies an architecture / interior image into the dwp
// taxonomy using Google Gemini vision. Defaults to gemini-3.5-flash; override
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

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

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
  // macro_portfolio / core_sector may only be PRIMARY sectors (what the image
  // depicts). Facets — Location Matrix, Climate, etc. — are tag-only and are
  // deliberately excluded from these two enums; they reach the model as
  // preset-tag vocabulary through the prompt instead. This also keeps the enum
  // small, well under Gemini's schema-branching limit (see ENUM_LIMIT note).
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
    },
    required: ["macro_portfolio", "core_sector", "sub_sectors", "preset_tags"],
    propertyOrdering: [
      "macro_portfolio",
      "core_sector",
      "sub_sectors",
      "preset_tags",
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

  // Two distinct sections. PRIMARY sectors are the only valid choices for
  // macro_portfolio / core_sector (what the image is *of*). FACETS describe
  // metadata about the shot (location, setting, sustainability, ...) and may
  // ONLY be applied as preset_tags — never as the primary classification.
  const primaryText = asText(tree.filter((m) => isPrimaryMacro(m.name)));
  const facetText = asText(tree.filter((m) => !isPrimaryMacro(m.name)));

  return (
    "You are an expert architecture & interior design asset manager classifying photographs for dwp's " +
    "Digital Asset Manager. Analyze the image thoroughly.\n\n" +
    "Classification Instructions:\n" +
    "1. MACRO PORTFOLIO & CORE SECTOR: Pick exactly one Macro Portfolio and one Core Sector belonging to it, " +
    "chosen ONLY from the PRIMARY SECTORS list below, that best describes WHAT THE PHOTOGRAPH DEPICTS " +
    "(e.g. a hotel lobby → Lifestyle → Hospitality; a staff portrait → Staff & Culture → Role Seniority). " +
    "NEVER pick a Macro Portfolio or Core Sector from the FACET TAGS section for these two fields — " +
    "location, region and setting are NOT the subject of the photo.\n" +
    "2. SUB-SECTOR TAGS (TYPOLOGIES): From the chosen Core Sector, select 1 to 5 specific sub-sector typologies " +
    "that describe the space, function, or design features visible (e.g. Luxury Resort, Fine Dining, High-Rise Residential).\n" +
    "3. PRESET TAGS: Select 0 to 8 additional tags that are clearly supported by the image, drawn from ANY row below — " +
    "this INCLUDES the FACET TAGS (location, climate/setting, sustainability, etc.). Descriptive facets such as the " +
    "location or setting belong HERE, as preset tags — never as the primary Macro Portfolio / Core Sector. " +
    "Do not guess a location you cannot see. Never invent new tags.\n\n" +
    "PRIMARY SECTORS (choose the Macro Portfolio + Core Sector from these ONLY):\n" +
    primaryText +
    "\n\nFACET TAGS (may be used ONLY as preset_tags, never as the primary sector):\n" +
    facetText +
    "\n\nRespond with a single JSON object of exactly this shape:\n" +
    '{"macro_portfolio": string, "core_sector": string, "sub_sectors": string[], "preset_tags": string[]}\n' +
    "macro_portfolio and core_sector MUST be copied verbatim from PRIMARY SECTORS. " +
    "Every tag must be copied verbatim from the lists above."
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

// Once Gemini refuses the structured-output schema (e.g. a taxonomy edit in
// Settings balloons it past the constraint-branching limit), it will refuse it
// on every call — remember and go straight to the schema-less request instead
// of paying a doomed round-trip per image.
let schemaRejectedByModel = false;

function isInvalidArgument(err: unknown): boolean {
  const e = err as { status?: number; code?: number };
  const status = e?.status ?? e?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    status === 400 || /INVALID_ARGUMENT|too much branching/i.test(msg)
  );
}

export async function classifyImage(
  base64: string,
  mediaType: string
): Promise<ImageAssessment> {
  // Fail fast if AI is switched off entirely (no key). This is a GLOBAL
  // condition (ClassifierUnavailableError), checked before we touch the image
  // so it can't be confused with a single image we can't decode below.
  const client = getClient();

  // Re-encode to a right-sized JPEG in memory: fits Gemini's inline-size limit
  // and converts tiff/gif/bmp/heic originals into a format Gemini accepts. The
  // original file in Drive is untouched. Throws UnsupportedMediaError (per-image,
  // NOT global) if the bytes can't be decoded at all.
  const jpegBase64 = await toGeminiJpegBase64(base64, mediaType);

  // Current user-editable taxonomy (cached in taxonomyStore; falls back to
  // built-in defaults on any DB problem).
  const tree = await getTaxonomyTree();
  const prompt = buildPrompt(tree);

  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: jpegBase64 } },
        { text: prompt },
      ],
    },
  ];

  const request = (withSchema: boolean) =>
    withRetry(() =>
      client.models.generateContent({
        model: MODEL,
        contents,
        config: {
          responseMimeType: "application/json",
          ...(withSchema ? { responseSchema: buildSchema(tree) } : {}),
          maxOutputTokens: 2048,
          // Deterministic output for classification — non-zero temperature
          // occasionally produced malformed JSON on degenerate images.
          temperature: 0,
          // Classification doesn't need reasoning — disable thinking for
          // speed/cost (supported on gemini-2.5/3.5-flash).
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
    );

  let response;
  if (schemaRejectedByModel) {
    response = await request(false);
  } else {
    try {
      response = await request(true);
    } catch (err) {
      if (!isInvalidArgument(err)) throw err;
      // The schema itself was refused — the prompt already pins the JSON
      // shape and vocabulary, and everything is validated below, so retry
      // without it rather than failing the image. Only remember the
      // rejection if the schema-less request actually works (otherwise the
      // 400 had some other cause, e.g. a bad key, and must keep surfacing).
      response = await request(false);
      schemaRejectedByModel = true;
    }
  }

  interface RawAssessment {
    macro_portfolio?: string;
    core_sector?: string;
    sub_sectors?: string[];
    preset_tags?: string[];
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
    response = await request(false);
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
  // (canonical casing, deduped, capped) — the model can never introduce tags
  // of its own.
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

  // Enforce taxonomy consistency (repairs macro from core, drops stray tags).
  return { ...normalizeSelection(raw, tree), presetTags };
}
