// Asset search against the v2 library — the only read path the app uses.
//
// Calls the SECURITY DEFINER RPCs dam_search_assets and dam_search_assets_count
// with the CALLER's minted token, so the visibility rules (SPEC 3.5.5) are
// decided in the database from the token's `sub`, never here. Both run in
// parallel over the same filters; the count is exact up to 50,000 matches and
// flagged as an estimate beyond that.
//
// Hydration (Drive file id, v1 id, keyword and project names, the v1 legacy
// fields) happens INSIDE dam_search_assets, after its LIMIT. A second
// authenticated select on dam_assets would run the base-table policies, which
// are not the same predicate, and could drop rows the RPC returned.

import { v2Client } from "./client";
import { decodeCursor, encodeCursor, stableStringify, type CursorPosition } from "./cursor";
import { V2Error, fromPostgrest } from "./errors";
import type { V2User } from "./identity";
import { mintUserToken } from "./jwt";

export type V2Sort = "-created_at" | "created_at";
export type V2MatchMode = "any" | "all";

// The dam_search_assets `p` keys, camelCased. All optional.
export interface V2SearchInput {
  q?: string;
  filenameLike?: string;
  projectIds?: string[];
  projectMode?: V2MatchMode;
  categoryIds?: string[];
  studioIds?: string[];
  studioCodes?: string[];
  fileKinds?: string[];
  keywordIds?: string[];
  keywordMode?: V2MatchMode;
  keywordNames?: string[];
  projectKeywordIds?: string[];
  projectKeywordMode?: V2MatchMode;
  projectKeywordNames?: string[];
  path?: string;
  pathPrefix?: string;
  statuses?: string[];
  sort?: V2Sort;
  limit?: number;
  // Opaque; produced by a previous call's nextCursor.
  cursor?: string;
  offset?: number;
}

// One row of dam_search_assets, exactly as PostgREST returns it.
export interface V2AssetRow {
  asset_id: string;
  created_at: string;
  updated_at: string;
  filename: string;
  title: string | null;
  category_id: string;
  status: string;
  access_level_id: string;
  file_kind: string;
  mime_type: string;
  size_bytes: number;
  project_ids: string[];
  studio_ids: string[];
  asset_keyword_ids: string[];
  project_keyword_ids: string[];
  rights_status: string;
  completeness_score: number;
  ingest_relative_path: string | null;
  v1_id: string | null;
  object_key: string | null;
  storage_provider: string | null;
  provider_url: string | null;
  keyword_names: string[] | null;
  project_names: string[] | null;
  project_codes: string[] | null;
  legacy: Record<string, unknown> | null;
}

export interface V2SearchResult {
  rows: V2AssetRow[];
  total: number;
  totalIsEstimate: boolean;
  nextCursor: string | null;
  // The page size actually asked for, after clamping.
  limit: number;
}

// SPEC D-001: default 50, at most 200 per page. dam_search_assets clamps to the
// same bounds from dam_settings; sending an explicit value keeps `limit` in the
// response honest and lets nextCursor tell a full page from the last one.
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
// SPEC D-010. Deeper than this, page with the cursor.
export const MAX_OFFSET = 10_000;

const RPC_TIMEOUT_MS = 10_000;

function clamp(n: number | undefined, fallback: number, min: number, max: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function text(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

// Trimmed, de-duplicated and sorted: every array filter is a set (any/all), so
// order carries no meaning — and sorting keeps the cursor fingerprint stable.
function list(v: string[] | undefined): string[] | undefined {
  if (!v) return undefined;
  const out = Array.from(new Set(v.map((x) => x.trim()).filter(Boolean))).sort();
  return out.length ? out : undefined;
}

// "any" is the RPC default, so it is sent only as "all", and only with the list
// it qualifies — two spellings of one query must share a fingerprint.
function mode(m: V2MatchMode | undefined, values: string[] | undefined): "all" | undefined {
  return values && m === "all" ? "all" : undefined;
}

// The filter part of `p`: everything except limit/cursor/offset. It is both
// what the count runs on and what the cursor fingerprint covers.
function filterParams(input: V2SearchInput): Record<string, unknown> {
  const projectIds = list(input.projectIds);
  const keywordIds = list(input.keywordIds);
  const projectKeywordIds = list(input.projectKeywordIds);
  const f: Record<string, unknown> = {
    q: text(input.q),
    filename_like: text(input.filenameLike),
    project_ids: projectIds,
    project_mode: mode(input.projectMode, projectIds),
    category_ids: list(input.categoryIds),
    studio_ids: list(input.studioIds),
    studio_codes: list(input.studioCodes?.map((c) => c.toLowerCase())),
    file_kinds: list(input.fileKinds),
    keyword_ids: keywordIds,
    keyword_mode: mode(input.keywordMode, keywordIds),
    keyword_names: list(input.keywordNames),
    project_keyword_ids: projectKeywordIds,
    project_keyword_mode: mode(input.projectKeywordMode, projectKeywordIds),
    project_keyword_names: list(input.projectKeywordNames),
    // Paths are matched exactly — not trimmed, since a folder name may
    // legitimately end in a space.
    path: input.path ? input.path : undefined,
    path_prefix: input.path ? undefined : input.pathPrefix ? input.pathPrefix : undefined,
    statuses: list(input.statuses),
    sort: input.sort === "created_at" ? "created_at" : "-created_at",
  };
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

export async function searchAssets(user: V2User, input: V2SearchInput): Promise<V2SearchResult> {
  const filters = filterParams(input);
  const fingerprint = stableStringify(filters);
  const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(input.offset, 0, 0, MAX_OFFSET);

  let position: CursorPosition | null = null;
  if (input.cursor) position = decodeCursor(input.cursor, fingerprint);

  // The RPC ignores offset when a cursor is given; not sending both keeps the
  // request unambiguous.
  const pageParams: Record<string, unknown> = { ...filters, limit };
  if (position) pageParams.cursor = position;
  else if (offset) pageParams.offset = offset;

  const client = v2Client(await mintUserToken(user.id, user.email));
  const [page, count] = await Promise.all([
    client.rpc("dam_search_assets", { p: pageParams }).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)),
    client.rpc("dam_search_assets_count", { p: filters }).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS)),
  ]);

  if (page.error) throw fromPostgrest("dam_search_assets", page);
  if (count.error) throw fromPostgrest("dam_search_assets_count", count);

  if (!Array.isArray(page.data)) {
    console.error("[v2] dam_search_assets returned a non-array body.");
    throw new V2Error(502, "v2_unavailable", "The project library returned an unexpected response.");
  }
  const rows = page.data as V2AssetRow[];
  const countRow = (Array.isArray(count.data) ? count.data[0] : count.data) as
    | { total: number | string; is_estimate: boolean }
    | null
    | undefined;
  const total = Number(countRow?.total ?? rows.length);
  const totalIsEstimate = countRow?.is_estimate === true;

  // Is there a page after this one? Without a cursor the exact count says so
  // directly — which also covers the database clamping `limit` below what was
  // asked, if search.max_limit is ever lowered. Past a cursor, or when the
  // count is only an estimate, a full page is the only signal. An empty page
  // never has a successor.
  const last = rows[rows.length - 1];
  const more =
    rows.length > 0 &&
    (position || totalIsEstimate ? rows.length >= limit : offset + rows.length < total);
  const nextCursor = more && last
    ? encodeCursor({ created_at: last.created_at, asset_id: last.asset_id }, fingerprint)
    : null;

  return { rows, total: Number.isFinite(total) ? total : rows.length, totalIsEstimate, nextCursor, limit };
}
