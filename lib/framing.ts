// Framing policy, and the rules for the cross-site session cookie.
//
// The whole app is embeddable: any site may put any page of it in an <iframe>,
// and a signed-in viewer sees the real app inside that frame. That is a
// deliberate decision (user, 2026-09-17), taken with the trade-off stated:
// framing decides who may put the page in an iframe, not who may see it — a
// parent page cannot read across origins into a frame it does not own — but
// /browse carries Delete, Auto-tag and permission controls, so an open rule
// does leave room for clickjacking, where a hostile page overlays its own
// button on one of ours. DAM_EMBED_ORIGINS closes that whenever wanted,
// without a code change.
//
// Imported by middleware.ts, so this module must stay Edge-safe — no node:*
// imports, no filesystem — and it must read env vars LAZILY, never at module
// scope: `next build` evaluates middleware's module scope at compile time and
// the Docker builder stage has no env vars at all (see lib/auth.ts).

// The chrome-free gallery. It is the one page that renders its own signed-out
// state instead of sending the frame to /login.
export const EMBED_PAGE = "/embed";

export function isEmbedPage(pathname: string): boolean {
  return pathname === EMBED_PAGE || pathname.startsWith(EMBED_PAGE + "/");
}

let cachedRaw: string | undefined;
let cachedOrigins: string[] = [];

// Parent origins allowed to frame this app, from DAM_EMBED_ORIGINS —
// comma- or space-separated, e.g.
//   DAM_EMBED_ORIGINS=https://www.dwp.com,https://hub.dwp.com
//
// UNSET MEANS ANY SITE MAY FRAME IT. Setting it narrows framing to exactly
// those origins; a bare * is the explicit spelling of the default. Junk entries
// are dropped with a log rather than failing the request — a typo here must not
// take the app down.
export function allowedParentOrigins(): string[] {
  const raw = process.env.DAM_EMBED_ORIGINS;
  if (raw === cachedRaw) return cachedOrigins;

  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    const value = entry.trim();
    if (!value) continue;
    if (value === "*") {
      // The explicit spelling of the default. Nothing else in the list can
      // matter once it is there, so stop reading.
      cachedRaw = raw;
      cachedOrigins = ["*"];
      return cachedOrigins;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      console.error(`[framing] DAM_EMBED_ORIGINS entry is not a URL — ignored: ${value}`);
      continue;
    }
    const isLocal =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !isLocal) {
      console.error(
        `[framing] DAM_EMBED_ORIGINS entry must be https (or http://localhost) — ignored: ${value}`
      );
      continue;
    }
    seen.add(url.origin);
  }

  cachedRaw = raw;
  cachedOrigins = [...seen];
  return cachedOrigins;
}

// The frame-ancestors source list. One value for the whole app — there is no
// per-path distinction any more.
export function frameAncestors(): string {
  const origins = allowedParentOrigins();
  if (origins.length === 0 || origins.includes("*")) return "*";
  return ["'self'", ...origins].join(" ");
}

// Stamp the framing header on a response. Call it on EVERY response middleware
// returns, including the 401s and the redirect to /login, so the policy is the
// same whatever the outcome.
export function applyFramingHeaders(res: { headers: Headers }): void {
  res.headers.set("Content-Security-Policy", `frame-ancestors ${frameAncestors()}`);

  // X-Frame-Options is deliberately NOT set, and actively removed if something
  // upstream added one. It has no working allowlist form (ALLOW-FROM is dead in
  // every current browser), so DENY or SAMEORIGIN would veto frame-ancestors
  // above in exactly the browsers that read XFO first.
  res.headers.delete("X-Frame-Options");
}

// May this request authenticate with the SameSite=None cookie?
//
// That cookie exists because a browser sends NOTHING SameSite=Lax from inside a
// cross-site iframe — not the frame's document, not its fetches, not its <img>.
// Without it a framed app would bounce a signed-in person to /login forever.
//
// Being SameSite=None means it rides along on requests this app did not
// initiate, so these three rules are what stands in for the protection Lax was
// giving:
//
//   1. A write (anything but GET/HEAD) is accepted only when the Origin header
//      is this host. Browsers send Origin on every non-GET request and cannot
//      be made to forge it, so a POST from evil.com carries evil.com and is
//      refused. This is the standard CSRF defence for a None cookie, and it is
//      what keeps Delete and Auto-tag out of a hostile page's reach.
//   2. A document or iframe load is always allowed — that is the framed page
//      itself, the whole point of the feature.
//   3. Any other read (fetch, XHR, <img>, <script>) must come from this origin,
//      so the cookie cannot be used to pull DAM images or JSON into some other
//      site's page. Inside our own frame these are same-origin and pass.
//
// Fetch Metadata headers are absent on clients old enough not to send them.
// Such a browser has no third-party cookie to send here either, so treating
// absence as "allowed" costs nothing and avoids a dead frame on an old WebView.
export function crossSiteCookieAllowed(req: {
  method: string;
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
  secFetchDest: string | null;
}): boolean {
  const isRead = req.method === "GET" || req.method === "HEAD";

  if (!isRead) {
    if (!req.origin || !req.host) return false;
    try {
      return new URL(req.origin).host === req.host;
    } catch {
      return false;
    }
  }

  const dest = req.secFetchDest;
  if (dest === null || dest === "document" || dest === "iframe" || dest === "frame") {
    return true;
  }

  return req.secFetchSite === null || req.secFetchSite === "same-origin";
}
