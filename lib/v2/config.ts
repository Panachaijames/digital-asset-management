// Configuration for the v2 (project-based) library — the separate Supabase
// project that SCHEMA.sql and supabase/migrations describe.
//
// Everything here is read LAZILY, inside functions, never at module scope, for
// the same reason as sessionKey() in lib/auth.ts: `next build` in Cloud Build
// has no env vars at all, and a module-scope read (or a module-scope
// createClient) would either fail the image build or bake "not configured"
// into it. A local `npm run build` loads .env.local and would not notice.
//
// Nothing in lib/v2 may be imported by middleware.ts or lib/auth.ts: those run
// on the Edge runtime, and supabase-js must not enter that bundle.
//
// v2 is invisible unless all three connection vars are set. A half-configured
// server reports "off" rather than answering every /api/v2 call with a 500.
//
//   DAM_V2_SUPABASE_URL          the v2 project URL
//   DAM_V2_SUPABASE_ANON_KEY     the anon (publishable) key — the PostgREST
//                                bootstrap; the minted JWT carries identity
//   DAM_V2_SUPABASE_JWT_SECRET   the v2 project's legacy HS256 JWT secret;
//                                a real secret: it mints tokens RLS accepts
//   DAM_V2_BROWSE                off (default) | optin | on
//
// DAM_V2_SUPABASE_SERVICE_ROLE_KEY is deliberately NOT read here. The web tier
// never holds it (SPEC D-375); only the scripts in scripts/v2-*.mjs use it.

export type V2BrowseMode = "off" | "optin" | "on";

export interface V2Config {
  url: string;
  anonKey: string;
  jwtSecret: string;
}

// Thrown when a v2 code path runs on a server that is not configured for it.
// Distinct from V2Error because it is a deployment fault, not a request fault;
// lib/v2/errors.ts turns it into a 503, never a 401.
export class V2NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2NotConfiguredError";
  }
}

function readEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

// Why a server is not configured, or null when it is. One place decides, so
// v2Configured() and v2Config() can never disagree.
function configProblem(): string | null {
  const missing = [
    "DAM_V2_SUPABASE_URL",
    "DAM_V2_SUPABASE_ANON_KEY",
    "DAM_V2_SUPABASE_JWT_SECRET",
  ].filter((n) => !readEnv(n));
  if (missing.length) return `${missing.join(", ")} not set`;
  // HS256 with a short key is weak, and a truncated paste is the likeliest way
  // to get one. Both deploy scripts refuse the same thing.
  if (readEnv("DAM_V2_SUPABASE_JWT_SECRET").length < 32) {
    return "DAM_V2_SUPABASE_JWT_SECRET is shorter than 32 characters";
  }
  if (!/^https?:\/\/[^\s/]+/.test(readEnv("DAM_V2_SUPABASE_URL"))) {
    return "DAM_V2_SUPABASE_URL is not an http(s) URL";
  }
  return null;
}

export function v2Configured(): boolean {
  return configProblem() === null;
}

export function v2Config(): V2Config {
  const problem = configProblem();
  if (problem) {
    throw new V2NotConfiguredError(
      `The v2 library is not configured (${problem}). Add the DAM_V2_* vars to ` +
        ".env.local AND to the pass-through lists in BOTH deploy.ps1 and set-env.ps1."
    );
  }
  return {
    url: readEnv("DAM_V2_SUPABASE_URL").replace(/\/+$/, ""),
    anonKey: readEnv("DAM_V2_SUPABASE_ANON_KEY"),
    jwtSecret: readEnv("DAM_V2_SUPABASE_JWT_SECRET"),
  };
}

// "off" whenever the connection vars are incomplete, whatever DAM_V2_BROWSE
// says, and for any value it does not recognise — the safe direction.
export function v2BrowseMode(): V2BrowseMode {
  if (!v2Configured()) return "off";
  const raw = readEnv("DAM_V2_BROWSE").toLowerCase();
  return raw === "on" || raw === "optin" ? raw : "off";
}
