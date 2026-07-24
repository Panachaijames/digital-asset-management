import { NextRequest } from "next/server";
import { DamAsset } from "@/lib/types";

// Absolute base for the URLs embedded in responses. DAM_PUBLIC_BASE_URL wins
// when set (stable public URL); otherwise fall back to the request's own
// origin, which is right for both localhost and Cloud Run (Cloud Run sets
// x-forwarded-proto / host on the way in).
export function getPublicBaseUrl(request: NextRequest): string {
  const env = process.env.DAM_PUBLIC_BASE_URL;
  if (env) return env.replace(/\/+$/, "");
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "localhost:3000";
  return `${proto}://${host}`;
}

// The externally visible asset shape. Deliberately excludes drive_file_id,
// folder_id, web_view_link, thumbnail_link (goes stale) and uploaded_by —
// consumers get working proxy URLs instead of raw Drive internals.
export function toPublicAsset(row: DamAsset, baseUrl: string) {
  return {
    id: row.id,
    name: row.name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    tags: row.tags ?? [],
    macro_portfolio: row.macro_portfolio,
    core_sector: row.core_sector,
    sub_sectors: row.sub_sectors ?? [],
    folder_path: row.folder_path,
    created_at: row.created_at,
    thumbnail_url: `${baseUrl}/api/v1/assets/${row.id}/thumbnail`,
    image_url: `${baseUrl}/api/v1/assets/${row.id}/image`,
  };
}
