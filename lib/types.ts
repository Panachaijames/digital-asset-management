export type UploadStatus = "queued" | "uploading" | "done" | "error";

// A Macro Portfolio → Core Sector → Sub-Sectors selection from the taxonomy.
export interface TaxonomySelection {
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
}

// What the AI assessment returns for one image: the taxonomy selection plus
// any applicable tags picked from the preset library (never invented).
export interface ImageAssessment extends TaxonomySelection {
  presetTags: string[];
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
  mime_type: string;
  size_bytes: number;
  web_view_link: string;
  thumbnail_link: string | null;
  uploaded_by: string | null;
  created_at: string;
}
