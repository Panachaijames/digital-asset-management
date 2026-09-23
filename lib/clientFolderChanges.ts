// Browser-side memory of folders this tab just created or deleted.
//
// The folder tree comes from /api/paths, which the server builds from Google
// Drive's whole-drive folder listing. That listing is eventually consistent —
// measured at hours, not seconds — so the server keeps its own index fresh
// with the Drive Changes API (lib/folderIndex.ts). This module is the client's
// half of the same idea: the moment a create/delete succeeds, the tree is
// patched here, and every later /api/paths response is patched the same way
// for a few minutes. That covers (a) the round trip to the server, (b) a
// browser-cached /api/paths response (Cache-Control max-age=60), and (c) a
// Cloud Run instance that hasn't polled Drive's change feed yet.
//
// Module scope on purpose: /browse and the upload FolderPicker are different
// components, and a folder made in one should show up in the other.

// An entry normally retires as soon as a server response agrees with it (see
// applyRecentFolderChanges); this is the backstop so a wrong entry — a folder
// someone else deleted meanwhile, or a server-side problem — can't be papered
// over for long.
const TTL_MS = 90 * 1000;
// /api/paths responses may be browser-cached for this long (Cache-Control on
// the route), so agreement from a response younger than this could be stale
// agreement — only retire an entry once it is older than the cache window.
const RESPONSE_CACHE_MS = 10 * 1000;

const created = new Map<string, number>();
const deleted = new Map<string, number>();

function prune(now: number) {
  for (const [p, at] of created) if (now - at > TTL_MS) created.delete(p);
  for (const [p, at] of deleted) if (now - at > TTL_MS) deleted.delete(p);
}

function normalise(path: string): string {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

// Remember a folder that now exists. Un-remembers any earlier delete of the
// same path (or of a subtree containing it): if it was deleted and re-created,
// the create wins.
export function noteCreatedPath(path: string) {
  const p = normalise(path);
  if (!p) return;
  const now = Date.now();
  prune(now);
  for (const d of Array.from(deleted.keys())) {
    if (isSelfOrDescendant(p, d)) deleted.delete(d);
  }
  created.set(p, now);
}

// Remember a folder (and so its whole subtree) that is now gone. Un-remembers
// any earlier create at or below it.
export function noteDeletedPath(path: string) {
  const p = normalise(path);
  if (!p) return;
  const now = Date.now();
  prune(now);
  for (const c of Array.from(created.keys())) {
    if (isSelfOrDescendant(c, p)) created.delete(c);
  }
  deleted.set(p, now);
}

// Patch a server-provided path list with what this tab knows: add recently
// created folders (plus every ancestor, so the tree can always be walked),
// drop recently deleted subtrees. Returns a new sorted, de-duplicated array;
// the input is not mutated. With nothing remembered, it returns the input
// as-is (same reference), so callers can skip a re-render.
//
// Entries retire when the server catches up: a created path that a (not
// possibly-cached) response already contains, or a deleted path it already
// omits, no longer needs remembering.
export function applyRecentFolderChanges(paths: string[]): string[] {
  const now = Date.now();
  prune(now);
  if (created.size === 0 && deleted.size === 0) return paths;

  const present = new Set(paths);
  for (const [p, at] of created) {
    if (now - at > RESPONSE_CACHE_MS && present.has(p)) created.delete(p);
  }
  for (const [p, at] of deleted) {
    if (now - at > RESPONSE_CACHE_MS && !present.has(p)) deleted.delete(p);
  }
  if (created.size === 0 && deleted.size === 0) return paths;

  const out = new Set<string>();
  for (const raw of paths) {
    const p = normalise(raw);
    if (!p) continue;
    let gone = false;
    for (const d of deleted.keys()) {
      if (isSelfOrDescendant(p, d)) {
        gone = true;
        break;
      }
    }
    if (!gone) out.add(p);
  }
  for (const c of created.keys()) {
    const segs = c.split("/");
    let acc = "";
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      out.add(acc);
    }
  }
  return Array.from(out).sort();
}
