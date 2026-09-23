import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { getPublicBaseUrl, toPublicAsset } from "@/lib/api/serialize";
import { csv, searchAssets } from "@/lib/api/search";

export { handleOptions as OPTIONS } from "@/lib/api/cors";

// List params arrive as arrays in the JSON body, but accept "a,b" strings
// too so a consumer can reuse their query-string building code.
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return csv(value);
  return [];
}

// POST /api/v1/assets/search — the JSON-body twin of GET /api/v1/assets,
// for long filter lists. Identical filters and response shape.
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError("bad_request", "Expected a JSON body.", 400);
  }

  const outcome = await searchAssets({
    q: typeof body.q === "string" ? body.q : null,
    tags: asList(body.tags),
    macro: typeof body.macro === "string" ? body.macro : null,
    core: typeof body.core === "string" ? body.core : null,
    sub: asList(body.sub),
    path: typeof body.path === "string" ? body.path : null,
    pathPrefix: typeof body.pathPrefix === "string" ? body.pathPrefix : null,
    studio: typeof body.studio === "string" ? body.studio : null,
    sort: typeof body.sort === "string" ? body.sort : null,
    limit: body.limit === undefined ? undefined : Number(body.limit),
    offset: body.offset === undefined ? undefined : Number(body.offset),
  });
  if (!outcome.ok) {
    return apiError(
      outcome.status === 400 ? "bad_request" : "server_error",
      outcome.message,
      outcome.status
    );
  }

  const base = getPublicBaseUrl(request);
  return jsonWithCors({
    data: outcome.rows.map((r) => toPublicAsset(r, base)),
    meta: { limit: outcome.limit, offset: outcome.offset, count: outcome.rows.length },
  });
}
