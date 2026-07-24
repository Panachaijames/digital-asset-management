import { supabaseAdmin } from "@/lib/supabase";
import { TAG_PRESETS, type TagPresetGroup } from "@/lib/tagPresets";

// Server-side preset library loader + editor. Reads common_dam_presets from
// Supabase (editable without redeploying) and falls back to the built-in
// defaults in lib/tagPresets.ts when the table is empty. Cached briefly so
// the classify route doesn't hit the DB for every image.
//
// Writes (settings UI + external API) all funnel through the helpers below.
// The FIRST write seeds the table with the built-in defaults — otherwise
// adding one tag would make the table non-empty and hide every default group.

let cache: { groups: TagPresetGroup[]; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

export function clearPresetCache() {
  cache = null;
}

export async function getPresetGroups(): Promise<TagPresetGroup[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.groups;

  try {
    const { data, error } = await supabaseAdmin
      .from("common_dam_presets")
      .select("group_name, tag, sort_order")
      .order("sort_order", { ascending: true });
    if (error) throw error;

    // Reserved "__" groups carry app-internal documents (the editable
    // taxonomy from lib/taxonomyStore.ts) — never part of the preset library.
    const visible = (data ?? []).filter(
      (row) => !row.group_name.startsWith("__")
    );
    if (visible.length) {
      // Map preserves insertion order, so groups come out in sort_order.
      const byGroup = new Map<string, string[]>();
      for (const row of visible) {
        const list = byGroup.get(row.group_name) ?? [];
        list.push(row.tag);
        byGroup.set(row.group_name, list);
      }
      const groups = Array.from(byGroup.entries()).map(([group, tags]) => ({
        group,
        tags,
      }));
      cache = { groups, at: Date.now() };
      return groups;
    }
  } catch (e) {
    console.error("Preset fetch failed; using built-in defaults:", e);
  }

  cache = { groups: TAG_PRESETS, at: Date.now() };
  return TAG_PRESETS;
}

interface PresetRow {
  group_name: string;
  tag: string;
  sort_order: number;
}

// Groups get 1000-wide sort_order blocks so tags append inside their block.
// (Grouping survives interleaving anyway — getPresetGroups groups by name —
// this just keeps the rows readable in the Supabase dashboard.)
const GROUP_STRIDE = 1000;

async function fetchAllRows(): Promise<PresetRow[]> {
  const { data, error } = await supabaseAdmin
    .from("common_dam_presets")
    .select("group_name, tag, sort_order")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  // Reserved "__" rows (the taxonomy document) are invisible to preset
  // editing — they must never be renamed, deleted, or counted here.
  return ((data ?? []) as PresetRow[]).filter(
    (r) => !r.group_name.startsWith("__")
  );
}

// Seed the table with the built-in defaults if it's empty, so the first edit
// builds ON TOP of what users already see instead of replacing it.
async function ensureSeeded(): Promise<void> {
  // Counted via fetchAllRows so reserved "__" rows don't make an otherwise
  // empty preset library look seeded.
  const existing = await fetchAllRows();
  if (existing.length > 0) return;

  const rows: PresetRow[] = TAG_PRESETS.flatMap((g, gi) =>
    g.tags.map((tag, ti) => ({
      group_name: g.group,
      tag,
      sort_order: gi * GROUP_STRIDE + ti,
    }))
  );
  const { error: insErr } = await supabaseAdmin
    .from("common_dam_presets")
    .insert(rows);
  if (insErr) throw new Error(insErr.message);
  console.log(`[presets] seeded common_dam_presets with ${rows.length} default rows`);
}

function cleanName(value: unknown, what: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new Error(`${what} can't be empty.`);
  if (v.length > 80) throw new Error(`${what} is too long (max 80 characters).`);
  if (v.startsWith("__")) {
    throw new Error(`${what} can't start with "__" (reserved).`);
  }
  return v;
}

const lower = (s: string) => s.toLowerCase();

// Add tags to a group, creating the group if it's new. Duplicate tags
// (case-insensitive, within the group) are skipped, not errors. Returns the
// fresh library.
export async function addPresetTags(
  groupInput: unknown,
  tagsInput: unknown
): Promise<TagPresetGroup[]> {
  const group = cleanName(groupInput, "Group name");
  const rawTags = Array.isArray(tagsInput) ? tagsInput : [];
  const tags: string[] = [];
  for (const t of rawTags) {
    const v = cleanName(t, "Tag");
    if (!tags.some((x) => lower(x) === lower(v))) tags.push(v);
  }
  if (!tags.length) throw new Error("Send at least one tag.");

  await ensureSeeded();
  const rows = await fetchAllRows();

  const groupRows = rows.filter((r) => lower(r.group_name) === lower(group));
  // Reuse the exact stored casing so one group doesn't split into two.
  const groupName = groupRows[0]?.group_name ?? group;
  const existingTags = new Set(groupRows.map((r) => lower(r.tag)));
  const fresh = tags.filter((t) => !existingTags.has(lower(t)));

  if (fresh.length) {
    const base = groupRows.length
      ? Math.max(...groupRows.map((r) => r.sort_order)) + 1
      : (rows.length ? Math.max(...rows.map((r) => r.sort_order)) : 0) + GROUP_STRIDE;
    const { error } = await supabaseAdmin.from("common_dam_presets").insert(
      fresh.map((tag, i) => ({
        group_name: groupName,
        tag,
        sort_order: base + i,
      }))
    );
    if (error) throw new Error(error.message);
  }

  clearPresetCache();
  return getPresetGroups();
}

// Rename one tag within a group. Exact (case-insensitive) match required.
export async function renamePresetTag(
  groupInput: unknown,
  tagInput: unknown,
  newTagInput: unknown
): Promise<TagPresetGroup[]> {
  const group = cleanName(groupInput, "Group name");
  const tag = cleanName(tagInput, "Tag");
  const newTag = cleanName(newTagInput, "New tag");

  await ensureSeeded();
  const rows = await fetchAllRows();
  const groupRows = rows.filter((r) => lower(r.group_name) === lower(group));
  if (!groupRows.length) throw new Error(`Group "${group}" not found.`);
  const row = groupRows.find((r) => lower(r.tag) === lower(tag));
  if (!row) throw new Error(`Tag "${tag}" not found in group "${groupRows[0].group_name}".`);
  if (
    lower(newTag) !== lower(tag) &&
    groupRows.some((r) => lower(r.tag) === lower(newTag))
  ) {
    throw new Error(`Tag "${newTag}" already exists in that group.`);
  }

  const { error } = await supabaseAdmin
    .from("common_dam_presets")
    .update({ tag: newTag })
    .eq("group_name", row.group_name)
    .eq("tag", row.tag);
  if (error) throw new Error(error.message);

  clearPresetCache();
  return getPresetGroups();
}

// Rename a whole group.
export async function renamePresetGroup(
  groupInput: unknown,
  newGroupInput: unknown
): Promise<TagPresetGroup[]> {
  const group = cleanName(groupInput, "Group name");
  const newGroup = cleanName(newGroupInput, "New group name");

  await ensureSeeded();
  const rows = await fetchAllRows();
  const groupRows = rows.filter((r) => lower(r.group_name) === lower(group));
  if (!groupRows.length) throw new Error(`Group "${group}" not found.`);
  if (
    lower(newGroup) !== lower(group) &&
    rows.some((r) => lower(r.group_name) === lower(newGroup))
  ) {
    throw new Error(`Group "${newGroup}" already exists.`);
  }

  const { error } = await supabaseAdmin
    .from("common_dam_presets")
    .update({ group_name: newGroup })
    .eq("group_name", groupRows[0].group_name);
  if (error) throw new Error(error.message);

  clearPresetCache();
  return getPresetGroups();
}

// Delete one tag, or the entire group when tag is omitted.
export async function deletePreset(
  groupInput: unknown,
  tagInput?: unknown
): Promise<TagPresetGroup[]> {
  const group = cleanName(groupInput, "Group name");

  await ensureSeeded();
  const rows = await fetchAllRows();
  const groupRows = rows.filter((r) => lower(r.group_name) === lower(group));
  if (!groupRows.length) throw new Error(`Group "${group}" not found.`);

  let query = supabaseAdmin
    .from("common_dam_presets")
    .delete()
    .eq("group_name", groupRows[0].group_name);

  if (tagInput !== undefined && tagInput !== null && tagInput !== "") {
    const tag = cleanName(tagInput, "Tag");
    const row = groupRows.find((r) => lower(r.tag) === lower(tag));
    if (!row) throw new Error(`Tag "${tag}" not found in group "${groupRows[0].group_name}".`);
    query = query.eq("tag", row.tag);
  }

  const { error } = await query;
  if (error) throw new Error(error.message);

  clearPresetCache();
  return getPresetGroups();
}
