"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { GOOGLE_CLIENT_ID } from "@/lib/authConfig";
import { profileFromIdToken, writeProfile } from "@/lib/profileCache";
import {
  continueInFrame,
  reportCredentialToOpener,
  signInViaPopup,
  type SignInOutcome,
} from "@/components/framedSignIn";

// Google renders the sign-in button into a cross-origin iframe, so it can't be
// styled with Tailwind. "outline" is the only theme that reads correctly on both
// of this app's grounds (Light and Dark); filled_blue is the saturated blue the
// dwp.intelligence standard has no token for. Google ignores CSS width, so the
// width is numeric: 360px card - 64px of p-8 padding.
const GSI_BUTTON = {
  theme: "outline",
  size: "large",
  shape: "rectangular",
  text: "signin_with",
  logo_alignment: "left",
  width: 296,
} as const;

interface CredentialResponse {
  credential?: string;
}

// Let the URL parser decide, then keep only the path parts. Anything that
// resolves to a different origin — however it was spelled — becomes "/".
// Called at navigation time, so `window` is always defined here.
function resolveSameOrigin(raw: string): string {
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

export default function LoginForm() {
  const searchParams = useSearchParams();

  // Unvalidated, "next" makes /login an open redirect on our own domain — a
  // convincing phishing chain, because the domain and the Google prompt are
  // both genuine.
  //
  // Resolved with the URL parser rather than prefix-matched. A startsWith("/")
  // && !startsWith("//") check is NOT enough: browsers treat "\" as "/" in a
  // special scheme and strip leading TAB/LF/CR before parsing, so "/\evil.com"
  // and "/<TAB>/evil.com" both pass such a check and then navigate off-site.
  const rawNext = searchParams.get("next") ?? "/";

  // Rendered as the sign-in popup an embedded page opened
  // (components/framedSignIn.ts). A popup is a top-level window on our origin,
  // so Google Sign-In renders and works here exactly as on a normal visit —
  // the only difference is what happens afterwards: the credential goes back to
  // the frame that opened us, and this window closes.
  const popupMode = searchParams.get("popup") === "1";

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [buttonEl, setButtonEl] = useState<HTMLDivElement | null>(null);

  // Are we inside someone else's iframe? The app is embeddable, so /login is
  // reachable in a frame — and Google Sign-In cannot run there. GSI needs a
  // top-level context; rendered in a nested cross-site frame it either refuses
  // outright or completes into a session the frame cannot see. So a framed
  // /login must offer a different route out, never the button.
  //
  // null until the effect runs, so the GSI script is not even fetched until we
  // know. Reading window.top across origins throws, which is itself the answer.
  const [framed, setFramed] = useState<boolean | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [outcome, setOutcome] = useState<SignInOutcome | null>(null);

  useEffect(() => {
    try {
      setFramed(window.self !== window.top);
    } catch {
      setFramed(true);
    }
  }, []);

  // React 18 StrictMode double-invokes effects in dev; GSI must initialise once.
  const initialised = useRef(false);
  const nextRef = useRef(rawNext);
  useEffect(() => {
    nextRef.current = rawNext;
  }, [rawNext]);

  const handleCredential = useCallback(async (response: CredentialResponse) => {
    const idToken = response?.credential;
    if (!idToken) {
      setError("Google did not return a credential. Try again.");
      return;
    }

    setBusy(true);
    setError(null);

    // Harvest name/photo from the ID token before handing it over — this is the
    // only place they are reliably available (see lib/profileCache.ts).
    const profile = profileFromIdToken(idToken);
    if (profile) {
      writeProfile(profile.email, { url: profile.picture, name: profile.name });
    }

    try {
      // Our own origin only. The route handler does the broker exchange
      // server-side and sets the httpOnly cookie in the same response.
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: idToken }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Sign-in failed (HTTP ${res.status}).`);
      }

      // As a popup, this window's job is done: the frame that opened us needs
      // the Google credential so it can do its OWN exchange and get a cookie
      // its context can actually read. Navigating here would just leave a stray
      // window open on /browse.
      if (popupMode && reportCredentialToOpener(idToken)) {
        // A tick, so the message is on its way before the window goes.
        window.setTimeout(() => window.close(), 100);
        return; // deliberately stays busy — this window is on its way out
      }

      // A full navigation, not router.push: it guarantees middleware re-reads
      // the freshly-set cookie rather than serving a cached client route.
      window.location.assign(resolveSameOrigin(nextRef.current));
      // Deliberately stays busy — the page is on its way out.
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected sign-in error occurred."
      );
      setBusy(false);
    }
  }, [popupMode]);

  // Runs when BOTH the GSI script is ready and the target div is mounted,
  // whichever lands second. next/script caches the load promise by src, so
  // onReady still fires for a component that mounts after the script loaded.
  useEffect(() => {
    if (framed !== false) return;
    if (!scriptReady || !buttonEl || initialised.current) return;

    const google = (window as any).google;
    if (!google?.accounts?.id) return;

    initialised.current = true;
    try {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      google.accounts.id.renderButton(buttonEl, GSI_BUTTON);
      // One Tap is an enhancement layered on top of the always-visible button,
      // never the primary path: it silently no-ops on unauthorised origins,
      // when third-party cookies are blocked, and after a prior dismissal.
      google.accounts.id.prompt();
    } catch (err) {
      initialised.current = false;
      setError("Could not start Google sign-in. Reload the page to try again.");
    }
  }, [framed, scriptReady, buttonEl, handleCredential]);

  // Sign in without leaving the host page. window.open has to happen straight
  // from the click — everything asynchronous is inside signInViaPopup.
  async function popupSignIn() {
    setAccessBusy(true);
    setOutcome(null);
    const result = await signInViaPopup();

    if (result === "signed-in") {
      window.location.assign(resolveSameOrigin(nextRef.current));
      return; // stays busy — the frame is on its way out
    }

    setOutcome(result);
    setAccessBusy(false);
  }

  // The follow-up click, for a browser that would not keep a cookie written
  // from inside a frame (Safari, most of all). Storage Access needs a gesture
  // of its own, which is why this cannot be chained onto popupSignIn.
  async function continueHere() {
    setAccessBusy(true);
    setOutcome(null);
    if (await continueInFrame()) {
      window.location.assign(resolveSameOrigin(nextRef.current));
      return;
    }
    setOutcome("needs-continue");
    setAccessBusy(false);
  }

  return (
    <>
      {/* afterInteractive + onReady, not a raw <script onLoad>. React 18 binds
          `load` directly to the element, and this page is prerendered — the
          browser executes the script during parse, before hydration, so a JSX
          onLoad handler would never fire and the page would sit blank. */}
      {framed === false && (
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() =>
          setError(
            "Could not load Google sign-in. Check your connection and reload."
          )
        }
      />
      )}

      <div className="w-full max-w-[360px]">
        <div className="rounded border border-border bg-surface p-8">
          {/* Wordmark, then the app name — set exactly as the shell sidebar, so
              the first screen reads as the same system as the app behind it. */}
          <div className="text-base font-medium text-text">dwp.</div>
          <div className="mt-2 text-base font-medium text-text">Digital Assets</div>

          <div className="my-6 border-t border-border" />

          <h1 className="text-lg font-medium text-text">Sign in</h1>
          <p className="mt-1 text-sm text-muted">
            {framed
              ? "This page is embedded in another site, so your browser has not passed your Digital Assets session into it."
              : "Use your dwp Google account. Access is granted per person in the dwp auth console."}
          </p>

          {error && (
            <div
              role="alert"
              className="mt-4 rounded border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger"
            >
              {error}
            </div>
          )}

          {framed ? (
            <>
              {/* Google Sign-In cannot render in a nested cross-site frame, so
                  this opens a popup — a top-level window on our own origin,
                  where it works normally. The viewer never leaves the host
                  page. */}
              <button
                type="button"
                onClick={popupSignIn}
                disabled={accessBusy}
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {accessBusy ? "Waiting for sign-in" : "Sign in with Google"}
              </button>
              <p className="mt-2 text-center text-xs text-muted">
                Opens a small Google window. This page stays where it is.
              </p>

              {outcome === "needs-continue" && (
                <>
                  <div className="my-4 border-t border-border" />
                  <p className="text-sm text-muted">
                    Signed in. This browser needs one more permission before an
                    embedded page can use the session.
                  </p>
                  <button
                    type="button"
                    onClick={continueHere}
                    disabled={accessBusy}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
                  >
                    {accessBusy ? "Checking" : "Continue in this frame"}
                  </button>
                </>
              )}

              {outcome === "blocked" && (
                <>
                  <p className="mt-4 text-sm text-muted">
                    Your browser blocked the sign-in window. Allow popups for
                    this page, or use a new tab.
                  </p>
                  <a
                    href={`/login?next=${encodeURIComponent(rawNext)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                  >
                    Sign in in a new tab
                  </a>
                </>
              )}

              {outcome === "failed" && (
                <p className="mt-4 text-sm text-muted">
                  Sign-in did not complete. Try again, or open Digital Assets in
                  its own tab.
                </p>
              )}
            </>
          ) : (
            <>
              {/* Google renders its iframe into this div. min-h stops the card
                  jumping while it mounts. */}
              <div className="mt-6 flex min-h-[40px] items-center justify-center">
                <div ref={setButtonEl} />
              </div>

              {!scriptReady && !error && (
                <p className="mt-4 text-center text-sm text-muted">
                  Loading Google sign-in
                </p>
              )}
              {busy && (
                <p className="mt-4 text-center text-sm text-muted">
                  Starting your session
                </p>
              )}
            </>
          )}

          <div className="mt-6 border-t border-border pt-4 text-center text-xs text-muted">
            Need access? Ask an administrator to grant your address for
            <span className="text-text"> dwp-dam</span>.
          </div>
        </div>

        {/* The only writer of the dam-theme preference — without it a first-time
            visitor can't change theme before signing in. */}
        <div className="mt-4 flex justify-center">
          <ThemeToggle />
        </div>
      </div>
    </>
  );
}
