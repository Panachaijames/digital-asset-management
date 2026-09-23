import crypto from "crypto";

// Short-lived signed URLs for /api/slides/image.
//
// The Google Slides API renders a slide image by fetching the URL we hand it
// from Google's own servers — it never sees our cookies or headers, so the
// image endpoint has to be reachable anonymously. Rather than leaving an open
// "give me any Drive file" proxy, every URL carries an expiry and an HMAC over
// (fileId, expiry). Slides downloads the bytes once, during batchUpdate, and
// stores its own copy inside the presentation, so a few minutes of validity is
// plenty — the deck keeps working long after the URL dies.
//
// The secret defaults to the service-account private key so no new env var is
// required (and so a URL signed by a local dev server verifies against the
// deployed one, which is the only way to test Slides export locally). Set
// DAM_SIGNING_SECRET to decouple them.

const DEFAULT_TTL_SECONDS = 30 * 60;
const SIG_LENGTH = 32; // base64url chars kept from the HMAC

function getSecret(): string {
  const secret =
    process.env.DAM_SIGNING_SECRET ||
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    "";
  if (!secret) {
    throw new Error(
      "No signing secret available — set DAM_SIGNING_SECRET (or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)."
    );
  }
  // The same private key reaches the two environments differently: dotenv
  // expands the \n escapes in .env.local into real newlines, while deploy.ps1
  // hands Cloud Run the escaped form verbatim. Unescaping (exactly as
  // lib/googleDrive.ts does before signing JWTs) makes both sides derive the
  // same key — without it, a URL signed by a dev server would 403 against the
  // deployed one, which is the only way to test Slides export locally.
  return secret.replace(/\\n/g, "\n").trim();
}

function sign(fileId: string, exp: number): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`${fileId}:${exp}`)
    .digest("base64url")
    .slice(0, SIG_LENGTH);
}

// Builds an absolute, anonymously-fetchable URL for one Drive file's image
// bytes. `baseUrl` must be a public origin (see lib/publicUrl.ts).
export function buildSignedImageUrl(
  baseUrl: string,
  fileId: string,
  opts: { ttlSeconds?: number; size?: number } = {}
): string {
  const exp =
    Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const params = new URLSearchParams({
    f: fileId,
    e: String(exp),
    s: sign(fileId, exp),
  });
  if (opts.size) params.set("z", String(opts.size));
  return `${baseUrl.replace(/\/+$/, "")}/api/slides/image?${params.toString()}`;
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; status: number; message: string };

export function verifyImageSignature(
  fileId: string | null,
  expRaw: string | null,
  sig: string | null
): SignatureCheck {
  if (!fileId || !/^[\w-]+$/.test(fileId)) {
    return { ok: false, status: 400, message: "Missing or invalid file id." };
  }
  const exp = Number(expRaw);
  if (!expRaw || !Number.isFinite(exp)) {
    return { ok: false, status: 400, message: "Missing or invalid expiry." };
  }
  if (!sig) {
    return { ok: false, status: 400, message: "Missing signature." };
  }
  if (exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, status: 410, message: "This link has expired." };
  }

  const expected = sign(fileId, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 403, message: "Bad signature." };
  }
  return { ok: true };
}
