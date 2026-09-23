import { NextResponse } from "next/server";
import { v2BrowseMode } from "@/lib/v2/config";

// Read per request, never prerendered or cached: the mode comes from the
// server's env, which `next build` does not have (see lib/v2/config.ts).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v2/status -> { enabled, mode }
//
// Whether /browse may offer the project library, and which library it opens on:
//   off    v2 invisible (also whenever the v2 connection vars are incomplete)
//   optin  current library by default, ?source=v2 switches
//   on     project library by default, ?source=v1 switches back
//
// Says nothing about the caller's own v2 account — that is decided per request
// by /api/v2/assets, so this stays one cheap env read with no database call.
export async function GET() {
  const mode = v2BrowseMode();
  return NextResponse.json(
    { enabled: mode !== "off", mode },
    { headers: { "Cache-Control": "no-store" } }
  );
}
