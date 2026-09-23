// Mints the short-lived JWT the web tier presents to the v2 project's
// PostgREST on a principal's behalf (SPEC 3.2.3, D-354).
//
// Signed HS256 with the v2 project's legacy JWT secret, which is what
// PostgREST verifies against. Lifetime 5 minutes; cached in process per `sub`
// and reused until 60 s before it expires. A token is never logged, never
// returned to the browser and never put in a cookie — it exists only between
// this process and Supabase.
//
// Claims. PostgREST switches to the `authenticated` database role from `role`.
// The applied helpers read exactly two claims: `sub` (dam_current_user_id())
// and `principal` (dam_current_principal_type(), which treats a MISSING
// `principal` as 'system'). SPEC 3.2.3 names that claim `principal_type`, so
// both are sent with the same value until the schema settles on one name.
// Role, studios and cross-studio visibility are deliberately NOT claims: the
// helpers read them from dam_users / dam_user_studios on every call, so an
// admin's change takes effect immediately instead of after the token expires.

import { SignJWT } from "jose";
import { v2Config } from "./config";

// The web tier's own system principal (seeded by the p1 grants migration,
// dam_users.is_system). Only dam_provision_user accepts it.
export const WEB_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000005";

const LIFETIME_SECONDS = 300;
const REUSE_MARGIN_SECONDS = 60;
const MAX_CACHED = 1000;

interface CachedToken {
  token: string;
  exp: number;
  // The claims that must match for a cached token to be reused.
  email: string | undefined;
  principal: "user" | "system";
  // The secret it was signed with, so a changed secret (tests, a rotated env)
  // never serves a token signed with the old one.
  secret: string;
}

const cache = new Map<string, CachedToken>();

let cachedKey: { secret: string; key: Uint8Array } | null = null;

// Lazy, like sessionKey() in lib/auth.ts — and v2Config() refuses a missing or
// short secret, so an empty key (which TextEncoder happily produces) can never
// reach SignJWT.
function signingKey(): { secret: string; key: Uint8Array } {
  const { jwtSecret } = v2Config();
  if (!cachedKey || cachedKey.secret !== jwtSecret) {
    cachedKey = { secret: jwtSecret, key: new TextEncoder().encode(jwtSecret) };
  }
  return cachedKey;
}

function prune(now: number) {
  if (cache.size < MAX_CACHED) return;
  for (const [sub, entry] of cache) {
    if (entry.exp - REUSE_MARGIN_SECONDS <= now) cache.delete(sub);
  }
  // Still full of live tokens: drop the oldest insertions. Map iterates in
  // insertion order, so this is a crude but bounded LRU.
  for (const sub of cache.keys()) {
    if (cache.size < MAX_CACHED) break;
    cache.delete(sub);
  }
}

async function mint(
  sub: string,
  principal: "user" | "system",
  email?: string
): Promise<string> {
  const { secret, key } = signingKey();
  const now = Math.floor(Date.now() / 1000);

  const hit = cache.get(sub);
  if (
    hit &&
    hit.secret === secret &&
    hit.principal === principal &&
    hit.email === email &&
    hit.exp - REUSE_MARGIN_SECONDS > now
  ) {
    return hit.token;
  }

  const exp = now + LIFETIME_SECONDS;
  const claims: Record<string, unknown> = {
    iss: "dam",
    aud: "authenticated",
    role: "authenticated",
    sub,
    principal,
    principal_type: principal,
    iat: now,
    exp,
  };
  // Informational only (SPEC: "logging only"); never used for identity.
  if (email) claims.email = email;

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(key);

  prune(now);
  cache.set(sub, { token, exp, email, principal, secret });
  return token;
}

// A token for a signed-in person. `userId` is dam_users.id — never the email,
// never the broker's subject.
export function mintUserToken(userId: string, email: string): Promise<string> {
  return mint(userId, "user", email.trim().toLowerCase() || undefined);
}

// A token for the web tier itself, used only to provision dam_users.
export function mintSystemToken(): Promise<string> {
  return mint(WEB_SYSTEM_USER_ID, "system");
}
