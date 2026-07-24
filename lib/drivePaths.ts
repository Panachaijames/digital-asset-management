import { listAllFolderPaths } from "@/lib/googleDrive";

// Cached loader for the media-library folder tree. Walking every Shared Drive
// on every /api/paths hit (mount, refresh, each folder create) is wasteful and
// exposes the tree to transient Drive failures, so results are cached briefly
// and stale results are served if a refresh fails. Invalidated by folder
// creation so new folders appear immediately.

let cache: { paths: string[]; at: number } | null = null;
const TTL_MS = 60 * 1000;

export async function getFolderPaths(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.paths;
  try {
    const paths = await listAllFolderPaths();
    cache = { paths, at: Date.now() };
    return paths;
  } catch (e) {
    // Serve the last-good result on a transient Drive failure so the folder
    // tree doesn't collapse; only propagate if we've never loaded it.
    if (cache) return cache.paths;
    throw e;
  }
}

export function clearFolderPathCache() {
  cache = null;
}
