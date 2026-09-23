import { NextRequest, NextResponse } from "next/server";
import { crossSiteCookieAllowed } from "@/lib/framing";
import {
  SESSION_COOKIE,
  EMBED_COOKIE,
  FRAME_COOKIE,
  APP_ID,
  verifySessionToken,
  MissingSecretError,
} from "@/lib/auth";
import { v2Configured } from "@/lib/v2/config";
import { provisionV2User } from "@/lib/v2/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cookie attributes. Every write — including the logout clear — must use the
// SAME name/path/sameSite/secure, or the browser keeps the old cookie alongside
// the new one and logout silently does nothing.
//
// `secure` is conditional, not hardcoded true: on http://localhost:3000 a
// Secure cookie is simply dropped, so `npm run dev` could never sign in.
const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

// The same token again, for the embeddable gallery at /embed (components/
// EmbedGallery.tsx). A browser sends NOTHING SameSite=Lax with a request made
// from inside a cross-site <iframe> — not the frame document, not its fetches,
// not its <img> — so without this second cookie the embed renders signed-out
// for a viewer who signed in a minute ago.
//
// SameSite=None requires Secure, unconditionally: a None cookie without it is
// dropped outright. Unlike COOKIE_BASE this cannot be conditional on NODE_ENV,
// and it does not need to be — browsers treat http://localhost as a trustworthy
// origin and accept Secure cookies there, so `npm run dev` still works.
//
// middleware.ts accepts this cookie ONLY for GET/HEAD on /embed and the three
// read-only APIs the gallery calls, so it can never authorise a write.
const EMBED_COOKIE_BASE = {
  httpOnly: true,
  sameSite: "none" as const,
  path: "/",
  secure: true,
};

// The same again, Partitioned. Set on every sign-in, but only USEFUL when this
// POST was made from inside a frame — which is exactly what happens when
// somebody signs in through the popup the embedded gallery opens
// (components/framedSignIn.ts): the popup hands the Google credential back to
// the frame, the frame posts it here, and this Set-Cookie lands in the frame's
// own partitioned jar. That is the only cookie a Chrome with third-party
// cookies switched off, or a Firefox with Total Cookie Protection, will keep.
//
// Signed in at the top level instead? Then this one lands in the first-party
// jar and is never read, and EMBED_COOKIE above does the work. Setting both
// costs one header and removes a whole class of "works for me" bug.
const FRAME_COOKIE_BASE = {
  httpOnly: true,
  sameSite: "none" as const,
  path: "/",
  secure: true,
  partitioned: true,
};

function configError() {
  return NextResponse.json(
    { error: "Authentication is not configured on this server." },
    { status: 500 }
  );
}

// POST { id_token } — exchange a Google credential for a session cookie.
//
// The broker exchange happens HERE, server-side, rather than in the browser.
// That is deliberate: the browser would need the broker origin, and a
// NEXT_PUBLIC_* var cannot reach the client in this repo's build (see
// lib/authConfig.ts). Doing it server-side also keeps the raw broker JWT out of
// client JS, needs no CORS from the broker, and turns two round trips into one.
export async function POST(request: NextRequest) {
  const brokerUrl = (process.env.DWP_AUTH_URL || "").trim();
  if (!brokerUrl) {
    console.error("[auth] DWP_AUTH_URL is not set.");
    return configError();
  }

  let idToken = "";
  try {
    const body = await request.json();
    idToken = typeof body?.id_token === "string" ? body.id_token : "";
  } catch {
    // fall through to the 400
  }
  if (!idToken) {
    return NextResponse.json({ error: "Missing id_token." }, { status: 400 });
  }

  let brokerRes: Response;
  try {
    brokerRes = await fetch(
      `${brokerUrl.replace(/\/+$/, "")}/api/auth/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: idToken, app_id: APP_ID }),
        cache: "no-store",
      }
    );
  } catch (err) {
    console.error("[auth] broker unreachable:", err);
    return NextResponse.json(
      { error: "Could not reach the sign-in service. Try again in a moment." },
      { status: 502 }
    );
  }

  const payload = await brokerRes.json().catch(() => null as any);

  if (!brokerRes.ok) {
    // The broker's own message is the useful one here — it says things like
    // "you have not been granted access to this app".
    const detail =
      typeof payload?.error === "string" ? payload.error : `HTTP ${brokerRes.status}`;
    return NextResponse.json(
      { error: `Sign-in was rejected: ${detail}` },
      { status: brokerRes.status === 403 ? 403 : 401 }
    );
  }

  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!token) {
    return NextResponse.json(
      { error: "The sign-in service returned no token." },
      { status: 502 }
    );
  }

  // Verify BEFORE setting it. A token we can't verify would only produce a
  // redirect loop on the very next request, with nothing explaining why.
  let claims;
  try {
    claims = await verifySessionToken(token);
  } catch (err) {
    if (err instanceof MissingSecretError) {
      console.error("[auth] " + err.message);
      return configError();
    }
    throw err;
  }
  if (!claims) {
    console.error(
      "[auth] broker token failed verification — DWP_AUTH_SECRET mismatch, or " +
        `the token's app_id is not "${APP_ID}".`
    );
    return NextResponse.json(
      { error: "This app could not verify the sign-in token." },
      { status: 502 }
    );
  }

  // Expire the browser cookie exactly when the token does. A hardcoded maxAge
  // that outlives `exp` yields a cookie that is sent but always rejected.
  const maxAge = Math.floor((claims.exp ?? 0) - Date.now() / 1000);
  if (maxAge <= 0) {
    return NextResponse.json(
      { error: "The sign-in token is already expired — check this device's clock." },
      { status: 400 }
    );
  }

  // Best-effort: give this person a row in the v2 project library now, while
  // the broker's name and picture are to hand (middleware forwards neither, so
  // the lazy provisioning in /api/v2 only has the email). It never blocks or
  // changes the sign-in: v2 is a read-only preview behind a switch, and its
  // outage must not lock anyone out of the current library. Capped at 1.5 s;
  // a slower or failed attempt is simply retried by the first /api/v2 call.
  if (v2Configured()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // The catch is on the attempt itself, so a rejection that lands after
        // the timeout has won is still handled rather than left unhandled.
        provisionV2User({
          email: claims.email,
          name: claims.name,
          picture: claims.picture,
        }).catch((err) => {
          console.warn(
            "[v2] provisioning at sign-in failed:",
            err instanceof Error ? err.message : err
          );
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
    } catch {
      // Unreachable in practice; sign-in proceeds whatever happens above.
    } finally {
      clearTimeout(timer);
    }
  }

  const res = NextResponse.json({
    ok: true,
    email: claims.email,
    role: claims.role,
    name: claims.name ?? null,
    picture: claims.picture ?? null,
  });
  res.cookies.set(SESSION_COOKIE, token, { ...COOKIE_BASE, maxAge });
  res.cookies.set(EMBED_COOKIE, token, { ...EMBED_COOKIE_BASE, maxAge });
  res.cookies.set(FRAME_COOKIE, token, { ...FRAME_COOKIE_BASE, maxAge });
  return res;
}

// GET — who is signed in. The cookie is httpOnly, so client JS can't read the
// claims itself; this is how the app shell learns the real user.
// It self-verifies because middleware never runs on this path.
export async function GET(request: NextRequest) {
  // Falls back to the cross-site cookie for the same reason middleware does: a
  // page inside a cross-site frame is sent nothing SameSite=Lax, so without
  // this a framed page could never answer "am I signed in?" — and that question
  // is exactly what the framed sign-in card asks before it decides whether to
  // send someone to Google (app/login/LoginForm.tsx).
  //
  // This route is in PUBLIC_PATHS, so middleware returns before checking
  // anything; the same rules have to be applied here by hand. In practice that
  // means the read must come from our own frame — a fetch from another site is
  // Sec-Fetch-Site: cross-site and gets nothing. (It could not read the reply
  // in any case: internal routes send no CORS headers.)
  let token = request.cookies.get(SESSION_COOKIE)?.value;
  if (
    !token &&
    crossSiteCookieAllowed({
      method: request.method,
      origin: request.headers.get("origin"),
      host: request.headers.get("host") ?? request.nextUrl.host,
      secFetchSite: request.headers.get("sec-fetch-site"),
      secFetchDest: request.headers.get("sec-fetch-dest"),
    })
  ) {
    token =
      request.cookies.get(EMBED_COOKIE)?.value ??
      request.cookies.get(FRAME_COOKIE)?.value;
  }

  if (!token) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  let claims;
  try {
    claims = await verifySessionToken(token);
  } catch (err) {
    if (err instanceof MissingSecretError) {
      console.error("[auth] " + err.message);
      return configError();
    }
    throw err;
  }
  if (!claims) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    email: claims.email,
    role: claims.role,
    name: claims.name ?? null,
    picture: claims.picture ?? null,
  });
}

// DELETE — sign out. Unconditional and always 200: it is called precisely when
// the token is already expired or invalid.
//
// Does not touch localStorage; the dwp_pic_* avatar cache deliberately survives
// logout so One Tap sign-ins reuse it across sessions.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 });
  // Same name/path/sameSite/secure as the write, or the browser keeps the old
  // cookie alongside the empty one and the embed stays signed in after logout.
  res.cookies.set(EMBED_COOKIE, "", { ...EMBED_COOKIE_BASE, maxAge: 0 });
  res.cookies.set(FRAME_COOKIE, "", { ...FRAME_COOKIE_BASE, maxAge: 0 });
  return res;
}
