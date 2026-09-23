"use client";

import { useCallback, useEffect, useState } from "react";
import { initialsFor, readProfile, writeProfile } from "@/lib/profileCache";

export interface SessionUser {
  email: string;
  role: string;
  name: string | null;
  picture: string | null;
  initials: string;
}

// Reads the signed-in user from GET /api/session.
//
// It has to be a client fetch rather than a server render: the session cookie is
// httpOnly (so client JS can't decode it), and the pages that use AppShell are
// prerendered server components whose HTML is identical for every user.
export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/session", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!data?.authenticated || !data.email) {
          setUser(null);
          setLoading(false);
          return;
        }

        // The broker's token may or may not carry name/picture — Workspace
        // tenants often strip them. Fall back to whatever a previous sign-in
        // cached for this address.
        const cached = readProfile(data.email);
        const name: string | null = data.name || cached?.name || null;
        const picture: string | null = data.picture || cached?.url || null;

        if (data.name || data.picture) {
          writeProfile(data.email, { url: data.picture, name: data.name });
        }

        setUser({
          email: data.email,
          role: data.role || "viewer",
          name,
          picture,
          initials: initialsFor(data.email, name),
        });
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Clears the cookie, then reloads into the login page. Deliberately does not
  // touch the dwp_pic_* cache — it is meant to survive logout.
  const signOut = useCallback(async () => {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } catch {
      // Even if the call fails, sending them to /login is the right move.
    }
    window.location.assign("/login");
  }, []);

  return { user, loading, signOut };
}
