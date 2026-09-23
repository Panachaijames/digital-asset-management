import { getDriveClient } from "@/lib/googleDrive";

// Resolves Drive file IDs to fresh thumbnail links for /api/thumbnail.
//
// The naive version — one drive.files.get per tile — costs a full Drive API
// round trip (~0.5s measured) for EVERY image in the grid, so a 60-tile folder
// spent ~30s of Drive time and, throttled by the browser's per-host connection
// limit, took several seconds to fill in. Two things fix that:
//
//   1. A process-wide id -> link cache. Drive's thumbnail links are signed and
//      live a few hours, so a 45-minute TTL is safe and lets repeat views (and
//      other users on the same instance) redirect with no Drive call at all.
//   2. Folder batching. One drive.files.list on the asset's parent folder
//      returns thumbnailLink for up to 1000 siblings in a single call, so the
//      first tile of a folder warms the cache for the whole grid. Concurrent
//      misses for the same folder are coalesced (single-flight), otherwise 60
//      simultaneous tile requests would each fire their own list call.
//
// Cache misses still fall back to a single-file lookup, so correctness never
// depends on the batch having found the file.

const TTL_MS = 45 * 60 * 1000;
// Files Drive has no thumbnail for (yet) are remembered briefly so a broken
// tile doesn't re-hit the API on every render.
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
// Bounded so a long-lived instance browsing the whole library can't grow the
// map without limit; ~34k assets today, oldest entries evicted first.
const MAX_ENTRIES = 25_000;

interface Entry {
  link: string | null;
  at: number;
}

const cache = new Map<string, Entry>();
const folderInflight = new Map<string, Promise<void>>();
const fileInflight = new Map<string, Promise<string | null>>();

function read(id: string): Entry | null {
  const entry = cache.get(id);
  if (!entry) return null;
  const ttl = entry.link ? TTL_MS : NEGATIVE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    cache.delete(id);
    return null;
  }
  // Re-insert so Map iteration order approximates least-recently-used.
  cache.delete(id);
  cache.set(id, entry);
  return entry;
}

function write(id: string, link: string | null) {
  cache.set(id, { link, at: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// One files.list over the parent folder, caching every thumbnailLink it
// returns. Files the response has no link for are deliberately NOT cached as
// negative — list occasionally omits it for a file that files.get can still
// resolve, and the single-file path below is the authority on that.
function loadFolder(folderId: string): Promise<void> {
  const existing = folderInflight.get(folderId);
  if (existing) return existing;

  const run = (async () => {
    const drive = getDriveClient();
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, thumbnailLink)",
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      });
      for (const f of res.data.files ?? []) {
        if (f.id && f.thumbnailLink) write(f.id, f.thumbnailLink);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  })();

  const tracked = run.finally(() => {
    folderInflight.delete(folderId);
  });
  folderInflight.set(folderId, tracked);
  return tracked;
}

function loadFile(fileId: string): Promise<string | null> {
  const existing = fileInflight.get(fileId);
  if (existing) return existing;

  const run = (async () => {
    const drive = getDriveClient();
    const res = await drive.files.get({
      fileId,
      fields: "thumbnailLink",
      supportsAllDrives: true,
    });
    const link = res.data.thumbnailLink ?? null;
    write(fileId, link);
    return link;
  })();

  const tracked = run.finally(() => {
    fileInflight.delete(fileId);
  });
  fileInflight.set(fileId, tracked);
  return tracked;
}

// Fresh thumbnail link for `fileId`, or null if Drive has none.
// `folderId` (the asset's Drive folder) is optional but turns a grid's worth of
// lookups into a single Drive call — pass it whenever it's known.
export async function getThumbnailLink(
  fileId: string,
  folderId?: string | null
): Promise<string | null> {
  const hit = read(fileId);
  if (hit) return hit.link;

  if (folderId && /^[\w-]+$/.test(folderId)) {
    // A failed batch is not fatal — fall through to the single-file lookup.
    await loadFolder(folderId).catch(() => undefined);
    const batched = read(fileId);
    if (batched) return batched.link;
  }

  return loadFile(fileId);
}

// Used after a replace/delete so the next request re-resolves the file.
export function forgetThumbnail(fileId: string) {
  cache.delete(fileId);
}
