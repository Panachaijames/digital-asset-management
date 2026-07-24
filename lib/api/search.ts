import { supabaseAdmin } from "@/lib/supabase";
import { DamAsset } from "@/lib/types";

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

  let query = supabaseAdmin
    .from("common_dam_assets")
    .select("*")
    .order("created_at", { ascending: sort === "oldest" })
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

  if (input.q) query = query.ilike("name", `%${input.q}%`);

  const { data, error } = await query;
  if (error) {
    console.error("v1 asset search error:", error);
    return { ok: false, status: 500, message: "Search failed." };
  }

  return { ok: true, rows: (data ?? []) as DamAsset[], limit, offset };
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
