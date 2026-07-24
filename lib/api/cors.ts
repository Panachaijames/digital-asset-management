import { NextResponse } from "next/server";

// Every consumer is internal and the API key is the gate, so CORS is a
// blanket allow — pinning origins would add a redeploy per new site without
// stopping non-browser callers (see docs/API-PLAN.md). Browsers still REQUIRE
// these headers for a cross-origin fetch(), even on an internal network.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Max-Age": "86400",
};

export function jsonWithCors(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
) {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { ...CORS_HEADERS, ...init?.headers },
  });
}

// The one error shape every /api/v1 endpoint returns:
// { error: { code, message } }
export function apiError(code: string, message: string, status: number) {
  return jsonWithCors({ error: { code, message } }, { status });
}

// Shared preflight handler — routes re-export this as OPTIONS.
export function handleOptions() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
