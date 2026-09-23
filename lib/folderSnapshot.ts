// Compact wire format for a Shared Drive's folder index, as stored in the
// `snapshot` column of common_dam_drive_sync (see lib/folderIndex.ts). One
// tuple per folder: [id, name, parentId | null, trashed ? 1 : 0]. Kept in its
// own dependency-free module so it can be unit-tested without Drive/Supabase.

export interface SnapshotFolder {
  id: string;
  name: string;
  parent: string | null;
  trashed: boolean;
}

export type SnapshotTuple = [string, string, string | null, 0 | 1];

export function serializeSnapshot(
  folders: Iterable<SnapshotFolder>
): SnapshotTuple[] {
  const out: SnapshotTuple[] = [];
  for (const f of folders) {
    out.push([f.id, f.name, f.parent, f.trashed ? 1 : 0]);
  }
  return out;
}

// Returns null when the value isn't a snapshot this code understands, so a
// corrupt or future-format row falls back to a fresh listing instead of an
// empty tree.
export function parseSnapshot(value: unknown): SnapshotFolder[] | null {
  if (!Array.isArray(value)) return null;
  const out: SnapshotFolder[] = [];
  for (const t of value) {
    if (!Array.isArray(t) || t.length < 3) return null;
    const [id, name, parent, trashed] = t as unknown[];
    if (typeof id !== "string" || !id || typeof name !== "string") return null;
    if (parent !== null && typeof parent !== "string") return null;
    out.push({
      id,
      name,
      parent: parent ?? null,
      trashed: trashed === 1 || trashed === true,
    });
  }
  return out;
}
