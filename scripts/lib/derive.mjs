// The v1 -> v2 derivation rules, in ONE place.
//
// Both the analysis script (which produces the CSV a human reviews) and the
// importer (which writes the rows) call this module. If they used separate
// copies, the review artefact would stop describing what the import actually
// did the first time either drifted.

// Project-code shapes observed in the real corpus. ORDER MATTERS: the dashed
// forms must be tried before the bare numeric one, or `0306-04` parses as
// `0306` and a different project is created.
// The terminator is (?!\d), NOT \b. `_` is a word character, so \b does not
// fire between `0806` and `_` — which silently cost us every project named like
// `17-0806_ Kerzner Office`, and those then collapsed into their sector folder.
export const CODE_SHAPES = [
  { name: "studio-prefixed", re: /^([A-Z]{2,6}-\d{2}-\d{3,5})(?!\d)/ }, // VNHCM-15-0036
  { name: "yy-nnnnn",        re: /^(\d{2}-\d{4,5})(?!\d)/ },            // 23-0126, 12-65100
  { name: "nnnn-nn",         re: /^(\d{4}-\d{2})(?!\d)/ },              // 0306-04
  { name: "letter-prefixed", re: /^([A-Z]\d{4,6})(?!\d)/ },             // S6879, S21810, M21935
  { name: "numeric",         re: /^(\d{4,7})(?!\d)/ },                  // 007639, 202336, 5002779
];

// Segments directly below a country that classify the work rather than name it.
// Measured from the corpus: Workplace 1,889 assets, Hospitality 1,113,
// Architecture 968, Residential 773. A sector is never a project — and since
// sector now lives on the project in v2, it is captured rather than discarded.
export const SECTOR = new Set([
  "workplace", "hospitality", "architecture", "residential", "civic", "civic & cultural",
  "retail", "retail & leisure", "education", "healthcare", "interior design",
  "master planning", "masterplanning", "f&b", "food & beverage", "leisure",
  "mixed use", "mixed-use", "industrial", "branding", "corporate", "co-working",
]);

// Legacy dumps that contain no client work at all.
export const JUNK = new Set(["archived", "filecamp library", "company – sample folder", "company - sample folder"]);

// Google Takeout / Drive-download wrappers: "…-20260409T084946Z-3-001".
export const TAKEOUT = /-\d{8}T\d{6}Z-\d+-\d+$/;

// Folders that describe a rendition or a purpose, never a project.
export const LEAF = /^(photos?|images?|renders?|renderings?|drawings?|logos?|brand assets.*|final|finals|selects?|hi-?res|low-?res|medium|small|large|original|reduced file size.*|for (award|press|web).*|archive[d]?|from client)$/i;

// Every country segment observed in the corpus, in every casing it appears in.
// These are matched case-insensitively against dam_studios.legacy_folder_names.
export const COUNTRY = new Set([
  "australia", "aus_archived", "bahrain", "thailand", "china", "uae", "vietnam",
  "hong kong", "united kingdom", "uk", "malaysia", "myanmar", "new zealand",
  "philippines", "manila", "saudi arabia", "ksa", "singapore", "usa",
  "united states", "indonesia", "india", "qatar", "oman", "japan", "korea",
  "taiwan", "cambodia", "laos",
]);

// Collections that hold no client projects at all.
export const NON_PROJECT_COLLECTIONS = new Set(["Marketing Hub", "Portfolio", "Proposal"]);

export function parseCode(segment) {
  if (!segment) return null;
  for (const shape of CODE_SHAPES) {
    const m = segment.match(shape.re);
    if (!m) continue;
    return {
      code: m[1],
      shape: shape.name,
      name: segment.slice(m[1].length).replace(/^[\s\-–—_]+/, "").trim(),
    };
  }
  return null;
}

/**
 * Turn one v1 folder_path into the facts v2 needs.
 * Returns { collection, studioFolder, code, codeShape, project, outcome }.
 * studioFolder is the RAW folder name; the caller resolves it to a studio id
 * against dam_studios.legacy_folder_names, case-insensitively.
 */
export function derivePath(folderPath) {
  const seg = String(folderPath ?? "").split("/");
  const collection = seg[1] ?? "";
  const rest = seg.slice(2);
  const base = { collection, studioFolder: null, code: null, codeShape: null, project: null };

  if (!collection) return { ...base, collection: "(root)", outcome: "orphan" };
  if (NON_PROJECT_COLLECTIONS.has(collection)) return { ...base, outcome: "no-project (by design)" };

  // A segment starting with "_" directly under a project collection is a
  // content bucket — `_dwp Videos` holds events and showreels, not client work.
  if (rest[0]?.startsWith("_")) return { ...base, outcome: "no-project (content bucket)" };

  // The first segment that names a country is the studio; the project is below.
  const ci = rest.findIndex((s) => COUNTRY.has(s.trim().toLowerCase()));
  const studioFolder = ci >= 0 ? rest[ci] : null;
  const below = ci >= 0 ? rest.slice(ci + 1) : rest;

  // Drop rendition/purpose folders and unwrap Takeout suffixes.
  const cleaned = below.filter((s) => !LEAF.test(s.trim())).map((s) => s.replace(TAKEOUT, ""));
  if (cleaned.some((s) => JUNK.has(s.trim().toLowerCase()))) {
    return { ...base, studioFolder, outcome: "no-project (legacy dump)" };
  }
  // Capture the sector for Stage 3 — in v2 it belongs to the project — and
  // remove it from project candidacy.
  const sector = cleaned.find((s) => SECTOR.has(s.trim().toLowerCase())) ?? null;
  const candidates = cleaned.filter((s) => !SECTOR.has(s.trim().toLowerCase()));

  // Take the DEEPEST code-bearing segment, else the deepest remaining segment.
  // Deepest, not shallowest: where a sector or a supplier sits above the
  // project, the shallowest choice swallows every project beneath it into one.
  let picked = null, parsed = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const p = parseCode(candidates[i]);
    if (p) { picked = candidates[i]; parsed = p; break; }
  }
  if (!picked && candidates.length) picked = candidates[candidates.length - 1];

  if (parsed) {
    return { collection, studioFolder, sector, code: parsed.code, codeShape: parsed.shape,
             project: parsed.name || picked, outcome: "code + name" };
  }
  if (picked) {
    return { ...base, studioFolder, sector, project: picked, outcome: "name only (unverified, no code)" };
  }
  return { ...base, studioFolder, sector, outcome: "NO PROJECT" };
}

// v1 mime_type -> dam_file_kind. Every value observed in the corpus is covered;
// anything unexpected falls to 'other' rather than guessing.
export function fileKindFor(mime) {
  const m = String(mime ?? "").toLowerCase();
  if (m === "image/x-photoshop" || m === "image/vnd.adobe.photoshop") return "design";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  return "other";
}

// Which seeded category an asset lands in. Collection decides it; the leaf
// folder refines it where it names a kind of work. Everything else is
// Project Photography, which is what 97% of this corpus is.
export function categorySlugFor(folderPath, collection) {
  if (collection === "3D Projects") return "renderings";
  if (collection === "Marketing Hub" || collection === "Portfolio") return "marketing-collateral";
  const leaf = String(folderPath ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (/^(logos?|brand assets)/.test(leaf)) return "logos-and-brand";
  if (/^(drawings?|plans?|sections?|elevations?)/.test(leaf)) return "drawings";
  if (/^renders?|^renderings?/.test(leaf)) return "renderings";
  return "project-photography";
}
