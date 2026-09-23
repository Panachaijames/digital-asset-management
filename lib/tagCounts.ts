import { countAllTags } from "@/lib/api/search";

// Cached loader for the tag facet counts, same shape as lib/drivePaths.ts.
//
// countAllTags() reads the `tags` column of every asset (~34k rows, 35 pages)
// — even parallelised that's ~1s, and it used to run on EVERY browse-page
// mount for chips that live inside the collapsed Filters panel. Results are
// cached for five minutes and served stale while a refresh runs in the
// background, so a user opening Filters never waits on Supabase.

export interface TagCount {
  tag: string;
  count: number;
}

let cache: { tags: TagCount[]; at: number } | null = null;
let inflight: Promise<TagCount[]> | null = null;
const TTL_MS = 5 * 60 * 1000;

function refresh(): Promise<TagCount[]> {
  if (!inflight) {
    inflight = countAllTags()
      .then((tags) => {
        cache = { tags, at: Date.now() };
        inflight = null;
        return tags;
      })
      .catch((err) => {
        inflight = null;
        // Serve the last-good counts on a transient failure; only propagate
        // if we've never loaded them.
        if (cache) return cache.tags;
        throw err;
      });
  }
  return inflight;
}

export async function getTagCounts(): Promise<TagCount[]> {
  if (cache) {
    if (Date.now() - cache.at < TTL_MS) return cache.tags;
    void refresh().catch(() => undefined); // stale-while-revalidate
    return cache.tags;
  }
  return refresh();
}

// Called after anything that changes tags on assets so the next reader sees
// the new counts instead of waiting out the TTL.
export function clearTagCountCache() {
  cache = null;
}
