// The v1 shape over v2 rows, so /browse can render the project library with
// its existing grid, tiles and details panel unchanged.
//
// `id` is the v2 asset id on purpose. Every v1 write route (update, delete,
// autotag, slides, visual search) looks its id up in common_dam_assets, where a
// v2 uuid can never match — so nothing reached from a v2 tile can mutate v1 by
// accident. The v1 id rides along as `v1_id` for parity checks only.
//
// The v1 classification fields (publish permission, macro portfolio, core
// sector, sub-sectors, uploader) have no v2 column; they come from the
// `legacy` copy the import kept on each asset.

import type { DamAsset, PublishPermission } from "../types";
import { studioById } from "../studios";
import type { V2AssetRow, V2SearchInput } from "./search";

export type V2DamAsset = DamAsset & { v2_id: string; v1_id: string | null };

const PERMISSIONS: readonly PublishPermission[] = ["granted", "pending", "restricted"];

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

// PostgREST renders timestamptz as "2026-01-01T00:00:00.123456+00:00"; the page
// only ever does new Date(created_at), so normalise to plain ISO.
function iso(v: string): string {
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
}

export function toDamAsset(row: V2AssetRow): V2DamAsset {
  const legacy = row.legacy && typeof row.legacy === "object" ? row.legacy : {};
  const permission = str(legacy.publish_permission);
  return {
    id: row.asset_id,
    v2_id: row.asset_id,
    v1_id: row.v1_id ?? null,
    // Only a Drive object key is a Drive file id; /api/thumbnail and
    // /api/assets/download would pass anything else straight to Drive.
    drive_file_id:
      row.storage_provider === "google_drive" && row.object_key ? row.object_key : "",
    // The grid calls name.toLowerCase() and mime_type.startsWith(): both must
    // be strings, never null.
    name: row.filename ?? "",
    folder_id: str(legacy.folder_id) ?? "",
    folder_path: row.ingest_relative_path ?? "",
    tags: strings(row.keyword_names),
    macro_portfolio: str(legacy.macro_portfolio),
    core_sector: str(legacy.core_sector),
    sub_sectors: strings(legacy.sub_sectors),
    publish_permission: PERMISSIONS.includes(permission as PublishPermission)
      ? (permission as PublishPermission)
      : "pending",
    mime_type: row.mime_type || "application/octet-stream",
    size_bytes: Number(row.size_bytes) || 0,
    web_view_link: row.provider_url ?? "",
    thumbnail_link: null,
    uploaded_by: str(legacy.uploaded_by),
    created_at: iso(row.created_at),
  };
}

function csv(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function int(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

// The /api/assets query string (see app/api/assets/route.ts) as a v2 search.
//
//   q                 -> filenameLike   v1 is ILIKE '%q%' on the name, and the
//                                       shim keeps that rather than widening to
//                                       full-text (SPEC 4.27.1)
//   tags              -> keywordNames   all must match, as v1's `contains`
//   macro, core, sub  -> projectKeywordNames  all must match, as v1's eq/eq/contains
//   studio            -> studioCodes    v1 ids equal dam_studios.code; an unknown
//                                       id is ignored, as v1 ignores it
//   path, pathPrefix  -> path, pathPrefix (path wins when both are sent, as in v1)
//   sort              -> newest | oldest -> -created_at | created_at
//   limit             -> 1..200, default 60 (v1 allows 1000; v2 pages at 200)
//   offset            -> 0..10000 (SPEC D-010)
//   permission        -> ignored: v2 has no such column
export function fromV1Query(params: URLSearchParams): V2SearchInput {
  const input: V2SearchInput = {};

  const q = params.get("q")?.trim();
  if (q) input.filenameLike = q;

  const tags = csv(params, "tags");
  if (tags.length) input.keywordNames = tags;

  const sector = [
    params.get("macro")?.trim() ?? "",
    params.get("core")?.trim() ?? "",
    ...csv(params, "sub"),
  ].filter(Boolean);
  if (sector.length) input.projectKeywordNames = sector;

  const studio = studioById(params.get("studio"));
  if (studio) input.studioCodes = [studio.id];

  const path = params.get("path");
  const pathPrefix = params.get("pathPrefix");
  if (path) input.path = path;
  else if (pathPrefix) input.pathPrefix = pathPrefix;

  input.sort = params.get("sort") === "oldest" ? "created_at" : "-created_at";

  const limit = int(params.get("limit"));
  input.limit = limit === undefined ? 60 : Math.min(200, Math.max(1, limit));

  const offset = int(params.get("offset"));
  if (offset !== undefined && offset > 0) input.offset = Math.min(10_000, offset);

  return input;
}
