// Browser-side cache of the signed-in user's display name and photo.
//
// Why this exists: Google Workspace tenants routinely strip the `picture` claim
// from ID tokens, and the broker's exchange payload is {id_token, app_id} — it
// carries no OAuth access token, so the broker cannot call Google's UserInfo
// endpoint to fill the gap either. The avatar therefore has to be treated as
// best-effort: capture it whenever a sign-in happens to expose one, and reuse it
// afterwards.
//
// The cache deliberately SURVIVES logout so One Tap sign-ins reuse the picture
// across sessions. That means it outlives the session by design — see the note
// on shared machines in DEPLOY.md.
//
// Every access is wrapped: localStorage throws outright in Safari private mode
// and under enterprise "block site data" policies.

const PREFIX = "dwp_pic_";
const MAX_ENTRIES = 5;

export interface CachedProfile {
  v: 1;
  url: string | null;
  name: string | null;
  updatedAt: number;
}

// Lower-cased: the broker's permission table holds mixed-case addresses, so an
// un-normalised key misses on the next sign-in and the cache silently never hits.
function keyFor(email: string): string {
  return PREFIX + email.trim().toLowerCase();
}

export function readProfile(email: string): CachedProfile | null {
  if (typeof window === "undefined" || !email) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(email));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return null;
    return parsed as CachedProfile;
  } catch {
    return null;
  }
}

export function writeProfile(
  email: string,
  data: { url?: string | null; name?: string | null }
): void {
  if (typeof window === "undefined" || !email) return;
  // Never overwrite a good entry with nothing — otherwise the first
  // picture-less sign-in wipes a working avatar for good.
  if (!data.url && !data.name) return;

  try {
    const existing = readProfile(email);
    const next: CachedProfile = {
      v: 1,
      url: data.url || existing?.url || null,
      name: data.name || existing?.name || null,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(keyFor(email), JSON.stringify(next));
    evictOldest();
  } catch {
    // Storage unavailable or full — the avatar is decorative, so drop it.
  }
}

// Keep the cache bounded: it survives logout, so a shared machine would
// otherwise accumulate every user who ever signed in.
function evictOldest(): void {
  try {
    const entries: Array<{ key: string; updatedAt: number }> = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      let updatedAt = 0;
      try {
        updatedAt = JSON.parse(window.localStorage.getItem(key) || "{}").updatedAt || 0;
      } catch {
        // Unparseable entry — treat as oldest so it gets evicted first.
      }
      entries.push({ key, updatedAt });
    }
    if (entries.length <= MAX_ENTRIES) return;
    entries
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, entries.length - MAX_ENTRIES)
      .forEach((e) => window.localStorage.removeItem(e.key));
  } catch {
    // Best effort.
  }
}

// Pull email/name/picture straight out of a Google ID token.
//
// No signature check, on purpose: the token is about to be sent to the broker,
// which does verify it. These values are only used to decorate an avatar, so
// verifying here would mean shipping a verifier to the browser for nothing.
export function profileFromIdToken(idToken: string): {
  email: string;
  name: string | null;
  picture: string | null;
} | null {
  try {
    const part = idToken.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    // decodeURIComponent/escape round-trip: atob yields Latin-1, and names
    // routinely contain non-ASCII characters.
    const payload = JSON.parse(decodeURIComponent(escape(json)));
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) return null;
    return {
      email,
      name: typeof payload.name === "string" ? payload.name : null,
      picture: typeof payload.picture === "string" ? payload.picture : null,
    };
  } catch {
    return null;
  }
}

// "Panachai Thongvinit" -> "PT";  "panachai.t@dwp.com" -> "PT"
export function initialsFor(email: string, name?: string | null): string {
  const source = (name || "").trim() || (email || "").split("@")[0].replace(/[._-]+/g, " ");
  const parts = source.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const letters = parts.length === 1
    ? parts[0].slice(0, 2)
    : parts[0][0] + parts[parts.length - 1][0];
  return letters.toUpperCase();
}
