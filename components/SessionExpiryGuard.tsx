"use client";

import { useEffect } from "react";

// Sends the user back to /login when their session expires mid-session.
//
// Middleware answers unauthenticated internal /api/* calls with 401 JSON rather
// than a 307 (a redirect would make fetch() return 200 + HTML and every
// res.json() would die on "Unexpected token '<'"). Nothing in the existing
// components knows what to do with that 401, so without this an expired session
// in an open tab shows up as buttons that quietly stop working.
//
// It is done here, in one place, rather than by editing the ~10 fetch call sites
// across ImageUploader / FolderPicker / TagSettings / PresetChips / browse —
// one reviewable file instead of scattered churn in components this change has
// no other reason to touch.
//
// The wrapper only ever OBSERVES: it forwards every argument through and
// returns the original Response untouched.
export default function SessionExpiryGuard() {
  useEffect(() => {
    const original = window.fetch;
    let redirecting = false;

    const isInternalApi = (input: RequestInfo | URL): boolean => {
      try {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url;
        const url = new URL(raw, window.location.origin);
        if (url.origin !== window.location.origin) return false;
        // /api/v1 is the external, API-key-authenticated surface — a 401 there
        // is a caller's key problem, not this session's.
        return url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/v1");
      } catch {
        return false;
      }
    };

    window.fetch = async function patchedFetch(input, init) {
      const res = await original.call(window, input as any, init);
      if (res.status === 401 && !redirecting && isInternalApi(input as any)) {
        redirecting = true;
        const here = window.location.pathname + window.location.search;
        window.location.assign(`/login?next=${encodeURIComponent(here)}`);
      }
      return res;
    } as typeof window.fetch;

    return () => {
      window.fetch = original;
    };
  }, []);

  return null;
}
