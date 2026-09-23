// Session gate for the app UI.
//
// Verifies the HS256 JWT the dwp auth broker issues (cookie "dwp_session") and
// redirects to /login when it's absent or invalid.
//
// It also sets the framing header on every response. The whole app is
// embeddable: any site may frame any page, unless DAM_EMBED_ORIGINS narrows it
// (lib/framing.ts). A framed page authenticates with the SameSite=None cookie,
// because nothing SameSite=Lax reaches a cross-site frame.
//
// Runtime: Edge (the default). Do NOT add `export const runtime = "nodejs"`
// here even though every route handler in this repo has it — Node middleware
// needs experimental.nodeMiddleware, which next.config.js does not enable.

import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  EMBED_COOKIE,
  FRAME_COOKIE,
  verifySessionToken,
  MissingSecretError,
} from "@/lib/auth";
import {
  applyFramingHeaders,
  crossSiteCookieAllowed,
  isEmbedPage,
} from "@/lib/framing";

// Defence in depth. `config.matcher` below already stops middleware running on
// these, but if anyone widens the matcher later these must still never be gated.
//
// Matched as exact path or subtree only — a bare startsWith("/api/v1") would
// also open a hypothetical "/api/v1foo". `pathname` never carries the query.
const PUBLIC_PATHS = [
  "/login",
  "/api/session",
  "/api/v1",
  "/api/slides/image",
  "/icon.svg",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Apply the framing header and hand the response back. Every `return` in this
// file goes through here, so there is no outcome — 401, redirect, 500 — that
// ships a response with no framing policy on it.
function framed<T extends { headers: Headers }>(res: T): T {
  applyFramingHeaders(res);
  return res;
}

// Adapter over the rules in lib/framing.ts — the decision itself is a pure
// function there, so it can be reasoned about (and got wrong) in one place.
function canUseCrossSiteCookie(req: NextRequest): boolean {
  return crossSiteCookieAllowed({
    method: req.method,
    origin: req.headers.get("origin"),
    host: req.headers.get("host") ?? req.nextUrl.host,
    secFetchSite: req.headers.get("sec-fetch-site"),
    secFetchDest: req.headers.get("sec-fetch-dest"),
  });
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return framed(NextResponse.next());

  const token = req.cookies.get(SESSION_COOKIE)?.value;

  let claims: Awaited<ReturnType<typeof verifySessionToken>> = null;
  try {
    claims = token ? await verifySessionToken(token) : null;

    // Cross-site frame fallback. Only reached when the Lax cookie was absent or
    // stale — which inside an iframe is the normal case, not the exception.
    if (!claims && canUseCrossSiteCookie(req)) {
      // Two of them, and which one exists depends entirely on the browser:
      // EMBED_COOKIE when third-party cookies are allowed or Storage Access was
      // granted, FRAME_COOKIE (Partitioned) when the person signed in inside
      // the frame itself. See lib/authConfig.ts.
      const frameToken =
        req.cookies.get(EMBED_COOKIE)?.value ??
        req.cookies.get(FRAME_COOKIE)?.value;
      claims = frameToken ? await verifySessionToken(frameToken) : null;
    }
  } catch (err) {
    // A missing secret is a CONFIG fault, not a bad token. Letting it fall
    // through to the redirect below would bounce every user — including ones
    // with valid tokens — to /login forever, while /login itself keeps
    // succeeding. Fail loudly instead.
    if (err instanceof MissingSecretError) {
      console.error("[auth] " + err.message);
      return framed(
        NextResponse.json(
          {
            error: {
              code: "server_misconfigured",
              message: "Authentication is not configured on this server.",
            },
          },
          { status: 500 }
        )
      );
    }
    claims = null;
  }

  if (!claims) {
    // The embed page renders its own signed-out state rather than sending the
    // frame to /login. Every other page does redirect, and /login detects that
    // it is framed and offers the same choices (app/login/LoginForm.tsx) —
    // Google Sign-In itself cannot run in a nested cross-site frame. The embed
    // keeps its own card because it is nicer in a small frame, and because it
    // holds no data of its own: every API call it makes is still gated below.
    if (isEmbedPage(pathname)) {
      const headers = new Headers(req.headers);
      headers.delete("x-dwp-email");
      headers.delete("x-dwp-role");
      return framed(NextResponse.next({ request: { headers } }));
    }

    // Internal /api/* is called by this app's own browser JS. A 307 would make
    // fetch() follow the redirect and return 200 + HTML, so every res.json()
    // dies on "Unexpected token '<'". Worse, a 307 preserves method and body,
    // so an in-flight 50 MB upload would be re-POSTed in full to /login.
    // Return a real 401 and let the client handle it.
    if (pathname.startsWith("/api/")) {
      return framed(
        NextResponse.json(
          {
            error: {
              code: "unauthenticated",
              message: "Session expired — sign in again.",
            },
          },
          { status: 401 }
        )
      );
    }

    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    // pathname + search so deep links into filtered /browse views survive.
    login.searchParams.set("next", pathname + search);
    return framed(NextResponse.redirect(login));
  }

  // Forwarding to the app REQUIRES NextResponse.next({ request: { headers } }).
  // Mutating `res.headers` on a plain NextResponse.next() only sets response
  // headers the browser sees — the app never receives them.
  //
  // And it must start from the real request headers: Next deletes every request
  // header not listed in its override set, so a fresh Headers() would wipe
  // cookie/host/accept.
  const headers = new Headers(req.headers);
  // Strip any client-supplied copy BEFORE setting the trusted value.
  headers.delete("x-dwp-email");
  headers.delete("x-dwp-role");
  headers.set("x-dwp-email", claims.email);
  headers.set("x-dwp-role", claims.role);

  return framed(NextResponse.next({ request: { headers } }));
}

export const config = {
  // Everything except:
  //   _next/static  next/font self-hosts Inter here; fonts are fetched as
  //                 anonymous subresources with no cookie, so gating them makes
  //                 every page fall back to the system stack (a quiet FOUT).
  //   _next/image   Next's image optimizer — same anonymous-subresource problem.
  //   favicon.ico   static metadata route, requested with no session.
  //   icon.svg      app/icon.svg exists and is served at /icon.svg.
  //   api/v1        the EXTERNAL API. Authenticated by x-api-key / ?key= for
  //                 four consumer sites that send no cookie. 11 of its routes
  //                 answer CORS preflights, and a preflight may never be a
  //                 redirect; its <img> URLs carry no cookie either.
  //   api/slides/image
  //                 Google's Slides servers fetch this themselves, anonymously.
  //                 It is HMAC-signed with a short TTL — that signature IS its
  //                 authentication. A redirect here kills every deck export.
  //
  // /login and /api/session used to be excluded here as well. They are now
  // inside the matcher so that they carry the same framing header as every
  // other response — a framed /login that browsers refuse to render is a dead
  // frame. They are NOT gated by being here: both are in PUBLIC_PATHS above,
  // which returns immediately without touching the session. That is exactly the
  // "defence in depth" the list was written for.
  //
  // /embed is in the matcher too; only the "no claims" branch above treats it
  // differently.
  matcher: [
    "/((?!_next/static|_next/image|favicon\.ico|icon\.svg|api/v1|api/slides/image).*)",
  ],
};
