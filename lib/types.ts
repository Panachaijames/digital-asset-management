export type UploadStatus = "queued" | "uploading" | "done" | "error";

// Whether dwp has permission to publish/distribute the asset externally.
export type PublishPermission = "granted" | "pending" | "restricted";

// A Macro Portfolio → Core Sector → Sub-Sectors selection from the taxonomy.
export interface TaxonomySelection {
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
}

// What the AI assessment returns for one image: the taxonomy selection plus
// preset tags and granular visual & architectural descriptors.
export interface ImageAssessment extends TaxonomySelection {
  presetTags: string[];
  visualTags?: string[];
  spaceType?: string;
  styleKeywords?: string[];
}

export type ClassifyStatus = "idle" | "classifying" | "done" | "error";

export interface QueuedFile {
  id: string;
  file: File;
  // Folder path relative to the drop (e.g. "ProjectX/Interiors"), "" for a
  // loose file. Recreated inside the destination Drive folder on upload.
  relativePath: string;
  previewUrl: string;
  // This image's OWN tags — the AI's per-image suggestions land here and the
  // user can edit them on the card. Batch tags are added on top at upload.
  tags: string[];
  publishPermission: PublishPermission;
  status: UploadStatus;
  progress: number;
  error?: string;
  result?: DamAsset;
  classifyStatus: ClassifyStatus;
}

// A folder (or Shared Drive root) as returned from the Google Drive API.
export interface DriveFolder {
  id: string;
  name: string;
  path: string; // human-readable path built from parent traversal, e.g. "Projects/2026/Site Photos"
  driveId: string; // the Shared Drive this belongs to (for a drive entry, id === driveId)
}

// How one asset is laid out on its slide by the Slides export (see
// lib/googleSlides.ts): "contain" shows the whole image inside a margin,
// "cover" fills the slide and lets the overflow fall off it.
export type SlideLayout = "contain" | "cover";

// What POST /api/slides/export reports back about the deck it built.
export interface SlidesExport {
  presentationId: string;
  url: string;
  name: string;
  folderPath: string;
  slides: number;
  // Assets that couldn't be placed (unfetchable image, unsupported file) —
  // the rest of the deck is still built and usable.
  failures: { name: string; error: string }[];
  sharedWith: string[];
}

// A row in the Supabase `common_dam_assets` table, joined with what we need from Drive.
export interface DamAsset {
  id: string;
  drive_file_id: string;
  name: string;
  folder_id: string;
  folder_path: string;
  tags: string[];
  // Taxonomy classification (see lib/taxonomy.ts).
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
  publish_permission: PublishPermission;
  mime_type: string;
  size_bytes: number;
  web_view_link: string;
  thumbnail_link: string | null;
  uploaded_by: string | null;
  created_at: string;
}

// Visual intelligence summary extracted from an uploaded query image or asset
export interface VisualSearchSummary {
  visualDescription: string;
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
  tags: string[];
  styleKeywords: string[];
  dominantColors: string[];
  spaceType?: string;
}

// An asset returned as a match for visual search, with similarity scoring
export interface VisualSearchResult extends DamAsset {
  similarityScore: number; // 0 - 100 percentage
  matchReasons: string[];
}

// Response from the POST /api/visual-search endpoint
export interface VisualSearchResponse {
  querySummary: VisualSearchSummary;
  queryImageUrl?: string;
  results: VisualSearchResult[];
  totalMatches: number;
}

