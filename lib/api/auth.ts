import { NextRequest, NextResponse } from "next/server";
import { apiError } from "./cors";

export type ApiScope = "read" | "write";

interface ApiKeyEntry {
  site: string;
  key: string;
  scopes: Set<string>;
}

// DAM_API_KEYS holds every key the server accepts, as comma-separated
// name:key:scopes entries with scopes joined by "+", e.g.
//   site-a:dam_live_abc:read+write,site-b:dam_live_def:read
// The name is what shows up in uploaded_by and the write logs.
function parseKeys(): ApiKeyEntry[] {
  const raw = process.env.DAM_API_KEYS || "";
  const entries: ApiKeyEntry[] = [];
  for (const part of raw.split(",")) {
    const [site, key, scopes] = part.trim().split(":");
    if (!site || !key) continue;
    entries.push({
      site,
      key,
      scopes: new Set(
        (scopes || "read")
          .split("+")
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    });
  }
  return entries;
}

export type AuthResult =
  | { ok: true; site: string }
  | { ok: false; response: NextResponse };

// The key arrives in the x-api-key header, or as ?key= for the image/
// thumbnail URLs (an <img> tag can't send headers).
export function requireApiKey(
  request: NextRequest,
  scope: ApiScope
): AuthResult {
  const supplied =
    request.headers.get("x-api-key") ||
    request.nextUrl.searchParams.get("key") ||
    "";

  if (!supplied) {
    return {
      ok: false,
      response: apiError(
        "unauthorized",
        "Missing API key — send it in the x-api-key header (or ?key= on image URLs).",
        401
      ),
    };
  }

  const entry = parseKeys().find((e) => e.key === supplied);
  if (!entry) {
    return {
      ok: false,
      response: apiError("unauthorized", "Unknown API key.", 401),
    };
  }

  // A "write" key can also read; a "read" key can never write.
  const allowed =
    entry.scopes.has(scope) || (scope === "read" && entry.scopes.has("write"));
  if (!allowed) {
    return {
      ok: false,
      response: apiError(
        "forbidden",
        `Your API key does not have "${scope}" permission.`,
        403
      ),
    };
  }

  return { ok: true, site: entry.site };
}
