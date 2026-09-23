// Per-site folder roots for the external API.
//
// DAM_SITE_ROOTS pins a consumer site to one folder in Drive, as
// comma-separated  site:path  entries (path starts with the Shared Drive name):
//
//   DAM_SITE_ROOTS=marketing-hub:dwp_Digital_Asset/Marketing Hub,proposal-maker:dwp_Digital_Asset/Proposals
//
// The site name is the same one used in DAM_API_KEYS, so a key maps to a root.
// A site WITH a root:
//   - can omit `location` entirely — new folders land directly in its root;
//   - can use short, relative locations ("Campaigns/Q3") — the root is implied;
//   - cannot create or list anything outside its root (the root is a fence,
//     not just a default).
// A site WITHOUT a root keeps the original behaviour: `location` is required
// and absolute (first segment = Shared Drive name), with no fence.

export function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRoots(): Map<string, string[]> {
  const roots = new Map<string, string[]>();
  for (const part of (process.env.DAM_SITE_ROOTS || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Split on the FIRST colon only — the path can't contain one, but being
    // explicit keeps a stray colon from silently truncating the root.
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const site = trimmed.slice(0, idx).trim();
    const segments = splitPath(trimmed.slice(idx + 1));
    if (!site || !segments.length) continue;
    roots.set(site, segments);
  }
  return roots;
}

// The site's root as path segments, or null when the site isn't fenced.
export function getSiteRoot(site: string): string[] | null {
  return parseRoots().get(site) ?? null;
}

function isInside(root: string[], candidate: string[]): boolean {
  if (candidate.length < root.length) return false;
  return root.every((seg, i) => candidate[i] === seg);
}

export type LocationResult =
  | { ok: true; segments: string[]; root: string[] | null }
  // `code` maps straight onto the HTTP status the route returns: a missing
  // location is the caller's input (400), a location outside the fence is a
  // permission problem (403).
  | { ok: false; code: "bad_request" | "forbidden"; message: string };

// Turns a caller-supplied `location` into an absolute path (segments), honouring
// the site's root. Accepts either form from a fenced site: absolute
// ("dwp_Digital_Asset/Marketing Hub/Campaigns") or relative to the root
// ("Campaigns"). A location is treated as absolute when its first segment is
// the root's Shared Drive name — so a *relative* first segment must not be
// named after the drive (documented; nobody names a folder
// "dwp_Digital_Asset").
export function resolveSiteLocation(
  site: string,
  location: string
): LocationResult {
  const root = getSiteRoot(site);
  const segments = splitPath(location);

  if (!root) {
    if (!segments.length) {
      return {
        ok: false,
        code: "bad_request",
        message:
          'Missing "location" — send the full folder path starting with the Shared Drive name, e.g. "dwp_Digital_Asset/ProjectX". (Ask the DAM team to set a default root for your key if you would rather send short paths.)',
      };
    }
    return { ok: true, segments, root: null };
  }

  if (!segments.length) return { ok: true, segments: root, root };

  const absolute = segments[0] === root[0] ? segments : [...root, ...segments];
  if (!isInside(root, absolute)) {
    return {
      ok: false,
      code: "forbidden",
      message: `Your API key can only work inside "${root.join(
        "/"
      )}" — "${absolute.join("/")}" is outside it.`,
    };
  }
  return { ok: true, segments: absolute, root };
}
