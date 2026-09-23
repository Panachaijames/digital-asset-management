// Errors for the /api/v2 routes, and the one place they become a response.
//
// NEVER 401. components/SessionExpiryGuard.tsx sends the browser to /login on
// any same-origin /api/* 401 outside /api/v1, and /login then succeeds — the
// dwp session is fine — so a v2-side refusal answered with 401 is an endless
// sign-in loop. A 401 means exactly one thing in this app: "no dwp session",
// and only middleware.ts says it. Everything v2 can refuse is 403, 404, 422,
// or a 5xx that names the v2 side as the problem.

import { NextResponse } from "next/server";
import { V2NotConfiguredError } from "./config";

export type V2ErrorStatus = 403 | 404 | 422 | 500 | 502 | 503;

export class V2Error extends Error {
  status: V2ErrorStatus;
  code: string;
  constructor(status: V2ErrorStatus, code: string, message: string) {
    super(message);
    this.name = "V2Error";
    this.status = status;
    this.code = code;
  }
}

// The shape supabase-js hands back on failure. `status` is the HTTP status of
// the PostgREST response — 0 when the request never got one (DNS, refused
// connection, abort/timeout).
export interface PostgrestFailure {
  error: { message?: string; code?: string; details?: string | null; hint?: string | null };
  status: number;
}

// Translate a PostgREST failure into a V2Error. `what` names the call for the
// server log ("dam_search_assets"); the client only ever sees our own message,
// never the database's text.
export function fromPostgrest(what: string, failure: PostgrestFailure): V2Error {
  const { error, status } = failure;
  const code = error?.code ?? "";
  // Logged without the request: the Authorization header is a minted JWT and
  // must never reach a log line.
  console.error(`[v2] ${what} failed: HTTP ${status} ${code} ${error?.message ?? ""}`.trim());

  if (status === 0 || status >= 500) {
    return new V2Error(502, "v2_unavailable", "The project library is not responding. Try again in a moment.");
  }
  // PGRST202: the function is not in PostgREST's schema cache — the
  // migrations that define it have not been applied (or the cache is stale).
  // P0002: dam_setting() found no row — the settings seed has not been applied.
  if (code === "PGRST202" || code === "PGRST205" || code === "P0002") {
    return new V2Error(503, "v2_not_ready", "The project library has not been set up on this server yet.");
  }
  // PostgREST rejected the minted token itself (bad signature, expired,
  // wrong audience). That is this server's fault — almost always a
  // DAM_V2_SUPABASE_JWT_SECRET that does not match the project — so it is a
  // gateway error, NOT a 401 (see the note at the top of this file).
  if (status === 401 || code.startsWith("PGRST3")) {
    return new V2Error(502, "v2_auth_failed", "The project library refused this server's credentials.");
  }
  if (code === "42501" || status === 403) {
    return new V2Error(403, "forbidden", "You do not have access to this in the project library.");
  }
  // 22023 invalid_parameter_value (the RPCs raise it naming the bad key),
  // 22P02 invalid text representation (a malformed uuid or enum label).
  if (code === "22023" || code === "22P02" || code === "22007" || code === "22008") {
    return new V2Error(422, "invalid_parameter", "One of the search parameters is not valid.");
  }
  return new V2Error(500, "v2_error", "The project library could not complete this request.");
}

function body(code: string, message: string) {
  return { error: { code, message } };
}

// Every /api/v2 error response goes through here: same envelope as
// middleware's own errors ({ error: { code, message } }), never cached.
export function v2ErrorResponse(e: unknown): NextResponse {
  const headers = { "Cache-Control": "no-store" };
  if (e instanceof V2Error) {
    return NextResponse.json(body(e.code, e.message), { status: e.status, headers });
  }
  if (e instanceof V2NotConfiguredError) {
    console.error("[v2] " + e.message);
    return NextResponse.json(
      body("v2_not_configured", "The project library is not configured on this server."),
      { status: 503, headers }
    );
  }
  console.error("[v2] unexpected error:", e instanceof Error ? e.message : e);
  return NextResponse.json(
    body("internal_error", "Something went wrong reading the project library."),
    { status: 500, headers }
  );
}
