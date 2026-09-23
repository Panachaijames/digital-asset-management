import { supabaseAdmin } from "@/lib/supabase";
import { DamAsset } from "@/lib/types";
import { STUDIOS, studioById, studioPathFilter } from "@/lib/studios";

export const DEFAULT_LIMIT = 60;
export const MAX_LIMIT = 100;

export interface AssetSearchInput {
  q?: string | null;
  tags?: string[];
  macro?: string | null;
  core?: string | null;
  sub?: string[];
  path?: string | null;
  pathPrefix?: string | null;
  // A dwp studio / project location id from lib/studios.ts, e.g. "bangkok".
  // Resolved to a folder-segment match on folder_path, since there is no
  // studio column on the row.
  studio?: string | null;
  sort?: string | null;
  limit?: number;
  offset?: number;
}

export type SearchOutcome =
  | { ok: true; rows: DamAsset[]; limit: number; offset: number }
  | { ok: false; status: 400 | 500; message: string };

// "a, b ,c" → ["a", "b", "c"] — the query-string form of list params.
export function csv(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The one search implementation behind GET /api/v1/assets and
// POST /api/v1/assets/search. Same filter semantics as the internal
// /api/assets route, plus offset paging.
export async function searchAssets(
  input: AssetSearchInput
): Promise<SearchOutcome> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return {
      ok: false,
      status: 400,
      message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
    };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return {
      ok: false,
      status: 400,
      message: "offset must be a non-negative integer",
    };
  }
  const sort = input.sort ?? "newest";
  if (sort !== "newest" && sort !== "oldest") {
    return { ok: false, status: 400, message: 'sort must be "newest" or "oldest"' };
  }
  // An unrecognised studio is rejected rather than ignored: silently
  // returning the whole library for a typo would read as "this studio has
  // everything" instead of "that isn't a studio".
  if (input.studio && !studioById(input.studio)) {
    return {
      ok: false,
      status: 400,
      message: `Unknown studio "${input.studio}". Valid values: ${STUDIOS.map(
        (s) => s.id
      ).join(", ")}.`,
    };
  }

  // `id` breaks ties so that offset paging enumerates each row exactly once.
  // created_at is not unique and not even close to it: an import writes its
  // whole batch in one insert, so tie groups of exactly 100 — MAX_LIMIT, i.e.
  // a full page — are normal (measured: the newest 1,000 rows hold only 189
  // distinct created_at values). Postgres may order a tie group differently
  // for each OFFSET/LIMIT query, so without a unique tiebreaker a row can
  // land on two adjacent pages while another lands on none. Paging
  // studio=bangkok (13,028 rows, limit 100) returned 148 duplicates and
  // silently dropped 148 other assets; with this second key, 13,028 rows and
  // no duplicates. countAllTags below pages by `id` for the same reason.
  let query = supabaseAdmin
    .from("common_dam_assets")
    .select("*")
    .order("created_at", { ascending: sort === "oldest" })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (input.path) {
    query = query.eq("folder_path", input.path);
  } else if (input.pathPrefix) {
    query = query.like("folder_path", `${input.pathPrefix}%`);
  }

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length) query = query.contains("tags", tags);

  if (input.macro) query = query.eq("macro_portfolio", input.macro);
  if (input.core) query = query.eq("core_sector", input.core);

  const subs = (input.sub ?? []).map((s) => s.trim()).filter(Boolean);
  if (subs.length) query = query.contains("sub_sectors", subs);

  // ANDed with `path`/`pathPrefix` above, so "this folder, Bangkok only"
  // works — the two constrain folder_path from different directions.
  const studioFilter = studioPathFilter(input.studio);
  if (studioFilter) query = query.or(studioFilter);

  if (input.q) query = query.ilike("name", `%${input.q}%`);

  const { data, error } = await query;
  if (error) {
    console.error("v1 asset search error:", error);
    return { ok: false, status: 500, message: "Search failed." };
  }

  return { ok: true, rows: (data ?? []) as DamAsset[], limit, offset };
}

// Tag → usage count across the WHOLE library, most-used first. A single
// select is capped at 1000 rows by Supabase, which silently truncated the
// counts once the library grew past that — so page through every row.
//
// The pages are fetched CONCURRENTLY (bounded), not one after another: at
// ~34k assets the sequential version was 35 round trips back-to-back, ~5s of
// wall clock on every /api/tags hit. The first page also asks for the exact
// count so we know how many pages there are up front. Callers should go
// through lib/tagCounts.ts, which caches this.
export async function countAllTags(): Promise<
  { tag: string; count: number }[]
> {
  const PAGE = 1000;
  const CONCURRENCY = 8;
  const counts = new Map<string, number>();

  const tally = (rows: { tags: string[] | null }[] | null | undefined) => {
    for (const row of rows ?? []) {
      for (const tag of row.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  };

  const page = (start: number) =>
    supabaseAdmin
      .from("common_dam_assets")
      .select("tags")
      .order("id", { ascending: true })
      .range(start, start + PAGE - 1);

  const first = await supabaseAdmin
    .from("common_dam_assets")
    .select("tags", { count: "exact" })
    .order("id", { ascending: true })
    .range(0, PAGE - 1);
  if (first.error) throw new Error(first.error.message);
  tally(first.data);

  const total = first.count ?? first.data?.length ?? 0;
  const starts: number[] = [];
  for (let start = PAGE; start < total; start += PAGE) starts.push(start);

  for (let i = 0; i < starts.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      starts.slice(i, i + CONCURRENCY).map((start) => page(start))
    );
    for (const res of batch) {
      if (res.error) throw new Error(res.error.message);
      tally(res.data);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// Single-row lookup by Supabase id. Returns null for "no such asset",
// including when the id isn't even a valid UUID (Postgres 22P02).
export async function getAssetById(id: string): Promise<DamAsset | null> {
  const { data, error } = await supabaseAdmin
    .from("common_dam_assets")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(error.message);
  }
  return (data as DamAsset) ?? null;
}
