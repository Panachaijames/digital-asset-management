// Session-token verification, shared by middleware.ts (Edge runtime) and the
// /api/session route handler (Node runtime).
//
// Imports ONLY from "jose", which is WebCrypto-based and has no node:* imports,
// so this module stays valid inside the Edge middleware bundle.

import { jwtVerify } from "jose";
import {
  DEFAULT_APP_ID,
  EMBED_COOKIE,
  FRAME_COOKIE,
  SESSION_COOKIE,
} from "./authConfig";

export { SESSION_COOKIE, EMBED_COOKIE, FRAME_COOKIE };

export const APP_ID = process.env.APP_ID || DEFAULT_APP_ID;

// Thrown when the shared signing secret is absent or too short. Kept distinct
// from "the token is bad" because the two need opposite handling: a bad token
// means "go and sign in", a missing secret means "this server is misconfigured".
// Conflating them is what turns a forgotten env var into an infinite redirect
// loop that logs nothing (see the note in sessionKey below).
export class MissingSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSecretError";
  }
}

let cachedKey: Uint8Array | null = null;

// Read LAZILY, never at module scope.
//
// Two reasons this must be a function:
//  1. `next build` (Dockerfile) evaluates middleware's module scope at compile
//     time, and Cloud Build has no DWP_AUTH_SECRET — a top-level throw would
//     fail the image build before anything ships.
//  2. `new TextEncoder().encode(undefined)` does NOT throw; it returns a
//     ZERO-LENGTH key. jwtVerify then throws DOMException "Zero-length key is
//     not supported", which a naive catch reads as "bad token" and redirects.
//     Every user — including ones holding perfectly valid tokens — would bounce
//     to /login forever, with every individual step reporting success.
function sessionKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = process.env.DWP_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new MissingSecretError(
      "DWP_AUTH_SECRET is missing or shorter than 32 characters. Add it to " +
        ".env.local AND to the pass-through lists in BOTH deploy.ps1 and set-env.ps1 " +
        "— a var in .env.local alone never reaches Cloud Run."
    );
  }
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

export interface SessionClaims {
  email: string;
  role: string;
  name?: string;
  picture?: string;
  exp?: number;
}

// Returns the claims for a valid token, or null for an invalid/expired one.
// Throws MissingSecretError (and only that) when the server is misconfigured.
export async function verifySessionToken(
  token: string
): Promise<SessionClaims | null> {
  // Deliberately outside the try: a config fault must not be swallowed as a
  // token failure.
  const key = sessionKey();

  try {
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      // Pin the algorithm. Without this, jose verifies with whatever `alg` the
      // token's own header asks for.
      algorithms: ["HS256"],
      // A token with no exp must never be accepted.
      requiredClaims: ["exp", "app_id", "email"],
      // Cloud Run vs. the issuing clock.
      clockTolerance: 60,
      // issuer/audience/maxTokenAge are deliberately NOT set. The broker
      // documents neither iss nor aud, and enabling either against an absent
      // claim throws JWTClaimValidationFailed for every user — the exact
      // lockout this module exists to avoid. Add them only after decoding a
      // real token and confirming the claims are actually there.
    });

    if (protectedHeader.alg !== "HS256") return null;

    // The broker signs for many apps with one secret, so a token minted for
    // another app is cryptographically valid here. Bind it to this app.
    if (typeof payload.app_id !== "string" || payload.app_id !== APP_ID) {
      return null;
    }

    const email =
      typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) return null;

    return {
      email,
      // Never default to a privileged role.
      role: typeof payload.role === "string" && payload.role ? payload.role : "viewer",
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
    };
  } catch {
    // Signature mismatch, expiry, malformed token — all "sign in again".
    return null;
  }
}
