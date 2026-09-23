// Opaque keyset cursors for /api/v2 paging (SPEC D-407).
//
// A cursor is the last row's (created_at, asset_id), tagged with an HMAC over
// the position AND the query it belongs to:
//
//   base64url(JSON [created_at, asset_id]) "." base64url(HMAC[0..8))
//   HMAC = HMAC-SHA256(key, payload + "|" + fingerprint)
//   key  = HMAC-SHA256(DAM_V2_SUPABASE_JWT_SECRET, "dam-cursor-v1")
//
// The tag is not there for secrecy — the position is not secret — but so a
// cursor can only ever be replayed against the query that produced it: a page-2
// cursor from "Bangkok, newest first" pasted onto "Dubai, oldest first" would
// otherwise silently return a meaningless slice. The fingerprint is the stable
// JSON of the sort and the filters (not limit, cursor or offset).
//
// The key is derived from the JWT secret rather than being a fifth env var;
// "dam-cursor-v1" separates the two uses, so a cursor tag can never double as
// anything the database accepts.

import { createHmac, timingSafeEqual } from "node:crypto";
import { v2Config } from "./config";
import { V2Error } from "./errors";

export interface CursorPosition {
  created_at: string;
  asset_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedKey: { secret: string; key: Buffer } | null = null;

function cursorKey(): Buffer {
  const { jwtSecret } = v2Config();
  if (!cachedKey || cachedKey.secret !== jwtSecret) {
    cachedKey = {
      secret: jwtSecret,
      key: createHmac("sha256", jwtSecret).update("dam-cursor-v1").digest(),
    };
  }
  return cachedKey.key;
}

function tagFor(payload: string, fingerprint: string): Buffer {
  return createHmac("sha256", cursorKey())
    .update(payload + "|" + fingerprint)
    .digest()
    .subarray(0, 8);
}

// JSON with object keys sorted at every level, so two equal queries always
// produce the same fingerprint however their objects were built. Undefined
// values are dropped (as JSON.stringify does for object members).
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function encodeCursor(position: CursorPosition, fingerprint: string): string {
  const payload = Buffer.from(
    JSON.stringify([position.created_at, position.asset_id]),
    "utf8"
  ).toString("base64url");
  return payload + "." + tagFor(payload, fingerprint).toString("base64url");
}

function invalid(): V2Error {
  return new V2Error(
    422,
    "invalid_cursor",
    "This page link has expired or belongs to a different search. Start again from the first page."
  );
}

export function decodeCursor(token: string, fingerprint: string): CursorPosition {
  if (typeof token !== "string" || token.length > 512) throw invalid();
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) throw invalid();
  const payload = token.slice(0, dot);
  const tagText = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(tagText)) throw invalid();

  const given = Buffer.from(tagText, "base64url");
  const expected = tagFor(payload, fingerprint);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !UUID.test(parsed[1]) ||
    Number.isNaN(Date.parse(parsed[0]))
  ) {
    throw invalid();
  }
  return { created_at: parsed[0], asset_id: parsed[1].toLowerCase() };
}
