"use client";

// Signing in from inside someone else's iframe.
//
// The problem: Google Sign-In cannot run in a nested cross-site frame. It needs
// a top-level context, so an embedded page has no way to render the button —
// which is why the first version of this could only say "go and sign in
// somewhere else, then come back", and looked broken.
//
// The way round it is a popup. A popup opened from the frame is a TOP-LEVEL
// window on our own origin, so Google works there exactly as it does on
// /login. The popup signs in, hands the Google credential back to the frame
// over postMessage, and closes; the frame then exchanges that credential
// itself, so the Set-Cookie lands in the FRAME's cookie jar rather than the
// popup's. That last part is the whole trick — a cookie set in the popup is a
// first-party cookie, and a browser with third-party cookies switched off will
// not hand it to the frame.
//
// After that a third-party cookie either works or it does not, per browser:
//   * Chrome/Edge, third-party cookies on  — the plain cookie is enough.
//   * Chrome with them off, Firefox        — the Partitioned cookie the frame's
//                                            own exchange sets does the work.
//   * Safari                               — refuses every third-party cookie
//                                            write, so the frame's exchange
//                                            cannot stick. The popup's own
//                                            first-party sign-in DID stick
//                                            though, and having just used our
//                                            origin top-level is precisely the
//                                            condition Safari wants before
//                                            granting Storage Access. That
//                                            needs a fresh click, hence the
//                                            "needs-continue" outcome and the
//                                            second button.

// Both halves of the conversation check for this, and postMessage is addressed
// to our own origin, so a hostile host page can neither read the credential nor
// forge one: its origin is not ours.
const AUTH_MESSAGE = "dwp-dam-auth";

const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 680;

// Long enough to pick an account, add a second factor and read a consent
// screen; short enough that a forgotten popup does not leave a listener for
// the life of the page.
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

export type SignInOutcome =
  // Done — the caller can load its data.
  | "signed-in"
  // Signed in at the top level, but this frame still cannot see the session.
  // One more click, on continueInFrame(), is needed.
  | "needs-continue"
  // The browser blocked the popup. Offer the new-tab link instead.
  | "blocked"
  // They closed the popup without finishing. Say nothing.
  | "cancelled"
  // Signed in, but the exchange failed. Worth a message.
  | "failed";

// Is there a session THIS browsing context can actually use? Answered by the
// server, because only the server can read the httpOnly cookies, and only this
// request proves which of them the browser was willing to send.
export async function hasUsableSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/session", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

// MUST be called straight from a click handler: window.open outside a user
// gesture is what popup blockers exist for.
export async function signInViaPopup(): Promise<SignInOutcome> {
  const left =
    window.screenX + Math.max(0, (window.outerWidth - POPUP_WIDTH) / 2);
  const top =
    window.screenY + Math.max(0, (window.outerHeight - POPUP_HEIGHT) / 2);

  const popup = window.open(
    "/login?popup=1",
    "dwp-dam-signin",
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${Math.round(
      left
    )},top=${Math.round(top)}`
  );
  if (!popup) return "blocked";

  const idToken = await new Promise<string | null>((resolve) => {
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(closedPoll);
      window.clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      // Our own origin only. The host page's origin is not ours, so it can
      // neither send this nor receive the popup's copy of it.
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== AUTH_MESSAGE) return;
      if (typeof event.data.idToken !== "string") return;
      finish(event.data.idToken);
    };

    // There is no event for "the user closed the popup", so it is polled.
    const closedPoll = window.setInterval(() => {
      if (popup.closed) finish(null);
    }, 500);

    const timer = window.setTimeout(() => finish(null), POPUP_TIMEOUT_MS);

    window.addEventListener("message", onMessage);
  });

  try {
    popup.close();
  } catch {
    // Already gone, or closed itself. Either is fine.
  }

  if (!idToken) return "cancelled";

  // Ask first. The popup has already signed in at the top level, and where
  // third-party cookies are allowed that cookie reaches this frame on its own —
  // so most of the time there is nothing left to do and the broker is spared a
  // second exchange of the same credential.
  if (await hasUsableSession()) return "signed-in";

  // It did not reach us, so exchange the credential HERE, in the frame. Same
  // endpoint, but the Set-Cookie now lands in THIS context's jar, which is what
  // makes the Partitioned cookie usable (lib/authConfig.ts). This is a second
  // exchange of one Google credential; if the broker ever refuses a repeat, the
  // probe below simply reports needs-continue and Storage Access takes over.
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    if (!res.ok) return "failed";
  } catch {
    return "failed";
  }

  return (await hasUsableSession()) ? "signed-in" : "needs-continue";
}

// The second click, for a browser that will not keep a cookie written from a
// frame. requestStorageAccess needs its own user gesture, which is why this
// cannot simply be chained onto the end of signInViaPopup.
export async function continueInFrame(): Promise<boolean> {
  try {
    const doc = document as Document & {
      hasStorageAccess?: () => Promise<boolean>;
      requestStorageAccess?: () => Promise<void>;
    };
    if (typeof doc.requestStorageAccess === "function") {
      const already =
        typeof doc.hasStorageAccess === "function"
          ? await doc.hasStorageAccess()
          : false;
      if (!already) await doc.requestStorageAccess();
    }
  } catch {
    // Refused or unsupported; the probe still decides, because a browser that
    // never blocked the cookie does not need the grant at all.
  }

  return hasUsableSession();
}

// Called by /login when it is running as that popup.
export function reportCredentialToOpener(idToken: string): boolean {
  const opener = window.opener as Window | null;
  if (!opener || opener === window) return false;
  try {
    // Addressed to our own origin, so it is delivered only if the opener really
    // is this app — never to a host page that opened /login?popup=1 itself.
    opener.postMessage({ type: AUTH_MESSAGE, idToken }, window.location.origin);
    return true;
  } catch {
    return false;
  }
}
