import { NextRequest, NextResponse } from "next/server";
import { v2BrowseMode } from "@/lib/v2/config";
import { V2Error, v2ErrorResponse } from "@/lib/v2/errors";
import { requireV2User } from "@/lib/v2/identity";
import {
  MAX_LIMIT,
  MAX_OFFSET,
  searchAssets,
  type V2MatchMode,
  type V2SearchInput,
  type V2Sort,
} from "@/lib/v2/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v2/assets — search the project library as the signed-in person.
//
// Query parameters (all optional; lists are comma-separated or repeated):
//   q                     full-text search (title, filename, keywords, projects)
//   filename              case-insensitive substring of the filename
//   project_id            project uuids; project_mode any (default) | all
//   category_id           category uuids
//   studio_id             studio uuids (a region group covers its children)
//   studio                studio codes, e.g. bangkok,ho-chi-minh-city
//   file_kind             image, video, pdf, …
//   keyword_id            asset keyword uuids; keyword_mode any (default) | all
//                         (a parent keyword matches its whole subtree)
//   keyword               asset keyword names; ALL must match
//   project_keyword_id    project keyword uuids; project_keyword_mode any | all
//   project_keyword       project keyword names (sectors); ALL must match
//   path                  exact ingest folder path
//   path_prefix           that folder or anything below it
//   status                narrows the statuses you can already see; never widens
//   sort                  -created_at (default) | created_at
//   limit                 1-200, default 50
//   cursor                meta.next_cursor from the previous page
//   offset                0-10000 (ignored with a cursor; page deeper with it)
//
// -> { data: [...], meta: { total, total_is_estimate, next_cursor, limit } }
//
// What a person may see is decided by dam_search_assets from their own token;
// nothing here filters for visibility. 404 while the library is switched off.
// Never 401: see lib/v2/errors.ts.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUDIO_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// dam_file_kind and dam_asset_status, SCHEMA.sql:115-116.
const FILE_KINDS = new Set([
  "image", "raw_image", "vector", "design", "video", "audio", "pdf", "document",
  "spreadsheet", "presentation", "cad", "bim", "model_3d", "archive", "other",
]);
const STATUSES = new Set(["pending", "approved", "published", "rejected", "superseded", "archived"]);
const MAX_TEXT = 500;
const MAX_LIST = 100;

function bad(param: string, why: string): V2Error {
  return new V2Error(422, "invalid_parameter", `"${param}" ${why}.`);
}

function text(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  if (v === null || v === "") return undefined;
  if (v.length > MAX_TEXT) throw bad(name, `is longer than ${MAX_TEXT} characters`);
  return v;
}

function list(params: URLSearchParams, name: string, check?: (v: string) => boolean, what?: string): string[] | undefined {
  const values = params
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.length) return undefined;
  if (values.length > MAX_LIST) throw bad(name, `lists more than ${MAX_LIST} values`);
  if (check) {
    const wrong = values.find((v) => !check(v));
    if (wrong !== undefined) throw bad(name, `must be ${what}`);
  }
  return values;
}

function matchMode(params: URLSearchParams, name: string): V2MatchMode | undefined {
  const v = params.get(name);
  if (v === null || v === "") return undefined;
  if (v !== "any" && v !== "all") throw bad(name, 'must be "any" or "all"');
  return v;
}

function int(params: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad(name, `must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function parse(params: URLSearchParams): V2SearchInput {
  const sortRaw = params.get("sort");
  let sort: V2Sort | undefined;
  if (sortRaw !== null && sortRaw !== "") {
    if (sortRaw !== "-created_at" && sortRaw !== "created_at") {
      throw bad("sort", 'must be "-created_at" or "created_at"');
    }
    sort = sortRaw;
  }
  const isUuid = (v: string) => UUID.test(v);
  return {
    q: text(params, "q"),
    filenameLike: text(params, "filename"),
    projectIds: list(params, "project_id", isUuid, "uuids"),
    projectMode: matchMode(params, "project_mode"),
    categoryIds: list(params, "category_id", isUuid, "uuids"),
    studioIds: list(params, "studio_id", isUuid, "uuids"),
    studioCodes: list(params, "studio", (v) => STUDIO_CODE.test(v.toLowerCase()), "studio codes such as bangkok"),
    fileKinds: list(params, "file_kind", (v) => FILE_KINDS.has(v), "file kinds such as image or pdf"),
    keywordIds: list(params, "keyword_id", isUuid, "uuids"),
    keywordMode: matchMode(params, "keyword_mode"),
    keywordNames: list(params, "keyword"),
    projectKeywordIds: list(params, "project_keyword_id", isUuid, "uuids"),
    projectKeywordMode: matchMode(params, "project_keyword_mode"),
    projectKeywordNames: list(params, "project_keyword"),
    path: text(params, "path"),
    pathPrefix: text(params, "path_prefix"),
    statuses: list(params, "status", (v) => STATUSES.has(v), "asset statuses such as approved"),
    sort,
    limit: int(params, "limit", 1, MAX_LIMIT),
    cursor: text(params, "cursor"),
    offset: int(params, "offset", 0, MAX_OFFSET),
  };
}

export async function GET(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (v2BrowseMode() === "off") {
      throw new V2Error(404, "not_found", "The project library is not available on this server.");
    }
    // Parameters first: a malformed request should cost no database call.
    const input = parse(request.nextUrl.searchParams);
    const user = await requireV2User(request);
    const result = await searchAssets(user, input);
    // `legacy` is the import's copy of the v1 fields; it is the compat route's
    // business, not part of this API.
    const data = result.rows.map(({ legacy: _legacy, ...row }) => row);
    return NextResponse.json(
      {
        data,
        meta: {
          total: result.total,
          total_is_estimate: result.totalIsEstimate,
          next_cursor: result.nextCursor,
          limit: result.limit,
        },
      },
      { headers }
    );
  } catch (e) {
    return v2ErrorResponse(e);
  }
}
