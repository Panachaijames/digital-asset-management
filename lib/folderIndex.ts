import type { drive_v3 } from "googleapis";
import {
  getDriveClient,
  listSharedDrives,
  withDriveRetry,
} from "./driveClient";
import { supabaseAdmin } from "./supabase";

// In-memory index of every folder in every Shared Drive, kept current with
// the Drive Changes API.
//
// WHY THIS EXISTS. The folder tree used to come straight from a whole-drive
// `files.list(q: mimeType = folder)`. That listing is served from Drive's
// search index, which is eventually consistent on a scale of HOURS for this
// drive (measured 2026-09-04: folders created 40+ minutes earlier were still
// absent; a probe folder never appeared in 6 minutes of polling). Reads that
// ARE consistent within a few seconds: `files.get`, `'<parent>' in parents`
// listings, name+parent queries, and `changes.list`. So the listing is used
// once, as a bulk bootstrap, and everything after that comes from the change
// feed — plus the app's own creates/deletes, applied the moment they happen.
//
// PERSISTED CHANGE TOKEN. Cloud Run scales to zero and runs several
// instances. A fresh instance's bootstrap listing lags by hours, so on its own
// it would "lose" every folder created (and resurrect every folder trashed) in
// that window. Replaying the change feed from a token stored in Supabase
// (common_dam_drive_sync) closes the gap — PROVIDED the token predates the lag
// window. So the replay-from token is only ever moved forward to a token that
// is at least CANDIDATE_SAFE_AGE_MS old: each row keeps the current
// `page_token` plus a younger `candidate_token`; once the candidate is old
// enough that the listing can be trusted for everything before it, it is
// promoted and a new candidate is taken. Replay therefore covers the last two
// to four days — a page of changes — never less than the listing lag.
// Without the table (schema not applied yet) everything still works within one
// process; only the cross-restart guarantee is lost, and a warning says so.
//
// LATENCY. Only the tree readers (getFolderPaths) wait for the bootstrap. The
// write paths (create / upload / resolve) ask the index with a short deadline
// and fall back to Drive's own name query, exactly as they did before this
// module existed, so a cold instance never makes an upload wait for a listing.

const FOLDER_MIME = "application/vnd.google-apps.folder";
// How stale a read may be before it costs a changes.list round trip.
const POLL_INTERVAL_MS = 3_000;
// After a failed poll / bootstrap, wait this long before trying again (don't
// hammer Drive during an outage; the index just serves what it has).
const BACKOFF_MS = 15_000;
// Re-list the Shared Drives this often, so a drive added/renamed later shows up
// without a restart.
const DRIVES_RECHECK_MS = 10 * 60 * 1000;
// Drive calls: per-attempt timeout and attempts (gaxios has NO default
// timeout; one hung socket would otherwise wedge every folder operation on the
// instance for its lifetime).
const DRIVE_TIMEOUT_MS = 20_000;
const DRIVE_ATTEMPTS = 3;
const SUPABASE_TIMEOUT_MS = 4_000;
// A candidate token becomes the replay-from token once it is this old. Must
// stay well above Drive's listing lag (hours, at worst a day).
const CANDIDATE_SAFE_AGE_MS = 48 * 60 * 60 * 1000;
// How often a long-lived instance re-checks the promotion rule.
const PROMOTION_CHECK_MS = 6 * 60 * 60 * 1000;
// Changes applied by THIS process (create/trash) beat what the feed says about
// the same folder for a few seconds — the feed can deliver the creation event
// after a fast local create→delete and briefly resurrect the folder.
const LOCAL_MUTATION_SHIELD_MS = 10_000;
// How long a folder lookup on a write path waits for the index before falling
// back to Drive's own query.
const LOOKUP_MAX_WAIT_MS = 600;
const SYNC_TABLE = "common_dam_drive_sync";

export interface FolderRecord {
  id: string;
  name: string;
  // Parent folder id; the Shared Drive's own id for top-level folders.
  parent: string | null;
  // Trashed folders stay in the map (flagged) rather than being dropped, so a
  // restore from the Drive trash — which may emit a change only for the folder
  // itself, not its descendants — brings the whole subtree back. Permanent
  // deletion (`removed`) drops the subtree for real.
  trashed: boolean;
  localMutatedAt: number;
}

interface DriveIndex {
  driveId: string;
  driveName: string;
  byId: Map<string, FolderRecord>;
  // Next changes.list token.
  pageToken: string;
  lastPollAt: number;
  backoffUntil: number;
  polling: Promise<boolean> | null;
  // Memoised, sorted, live (non-trashed, root-connected) paths.
  paths: string[] | null;
  // Whether the persisted row can be maintained from this process.
  persist: boolean;
  lastPromotionCheckAt: number;
}

// Module state lives on globalThis so that a re-evaluation of this module —
// Next's dev server does that when it compiles another route that imports it —
// reuses the built index instead of bootstrapping a second copy. In the
// production build the module is instantiated once anyway.
interface ModuleState {
  indexes: Map<string, DriveIndex> | null;
  building: Promise<Map<string, DriveIndex>> | null;
  bootstrapFailedAt: number;
  drivesCheckedAt: number;
  drivesDirty: boolean;
  recheckingDrives: boolean;
  warnedSchemaMissing: boolean;
}
const globalState = globalThis as typeof globalThis & {
  __dwpFolderIndex?: ModuleState;
};
const state: ModuleState = (globalState.__dwpFolderIndex ??= {
  indexes: null,
  building: null,
  bootstrapFailedAt: 0,
  drivesCheckedAt: 0,
  drivesDirty: false,
  recheckingDrives: false,
  warnedSchemaMissing: false,
});

// ---------------------------------------------------------------------------
// Persisted change token (Supabase)

interface SyncRow {
  page_token: string;
  candidate_token: string | null;
  candidate_at: string | null;
}

type LoadResult =
  | { kind: "row"; row: SyncRow }
  | { kind: "absent" }
  | { kind: "error" };

function reportSyncError(op: string, err: unknown) {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  const message = e?.message ?? String(err);
  // PGRST205 / 42P01: the table doesn't exist — the schema hasn't been applied.
  if (code === "PGRST205" || code === "42P01" || /schema cache|does not exist/i.test(message)) {
    if (state.warnedSchemaMissing) return;
    state.warnedSchemaMissing = true;
    console.warn(
      `[folder-index] The ${SYNC_TABLE} table is missing (${message}). ` +
        "Running with an in-memory change token: the folder tree is exact " +
        "while this instance runs, but after a restart folders created in " +
        "the last hours may be missing until Drive's listing catches up. " +
        "Create the table with the SQL in supabase/schema.sql."
    );
    return;
  }
  console.warn(`[folder-index] Supabase ${op} failed: ${message}`);
}

async function loadSyncRow(driveId: string): Promise<LoadResult> {
  try {
    const { data, error } = await supabaseAdmin
      .from(SYNC_TABLE)
      .select("page_token, candidate_token, candidate_at")
      .eq("drive_id", driveId)
      .abortSignal(AbortSignal.timeout(SUPABASE_TIMEOUT_MS))
      .maybeSingle();
    if (error) {
      reportSyncError("read", error);
      return { kind: "error" };
    }
    if (!data || typeof data.page_token !== "string" || !data.page_token) {
      return { kind: "absent" };
    }
    return {
      kind: "row",
      row: {
        page_token: data.page_token,
        candidate_token:
          typeof data.candidate_token === "string" ? data.candidate_token : null,
        candidate_at:
          typeof data.candidate_at === "string" ? data.candidate_at : null,
      },
    };
  } catch (err) {
    reportSyncError("read", err);
    return { kind: "error" };
  }
}

// First token for a drive. Insert-if-absent: two instances seeding at once, or
// an instance whose read failed, can never clobber a token already there.
async function seedSyncRow(driveId: string, token: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from(SYNC_TABLE)
      .upsert(
        {
          drive_id: driveId,
          page_token: token,
          candidate_token: token,
          candidate_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "drive_id", ignoreDuplicates: true }
      )
      .abortSignal(AbortSignal.timeout(SUPABASE_TIMEOUT_MS));
    if (error) {
      reportSyncError("seed", error);
      return false;
    }
    return true;
  } catch (err) {
    reportSyncError("seed", err);
    return false;
  }
}

async function updateSyncRow(
  driveId: string,
  patch: Partial<SyncRow>
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from(SYNC_TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("drive_id", driveId)
      .abortSignal(AbortSignal.timeout(SUPABASE_TIMEOUT_MS));
    if (error) reportSyncError("update", error);
  } catch (err) {
    reportSyncError("update", err);
  }
}

// The promotion rule (see the header). `current` is this process's latest
// token, i.e. "now" in change-feed terms.
async function maybePromoteToken(
  idx: DriveIndex,
  row: SyncRow,
  current: string
): Promise<void> {
  idx.lastPromotionCheckAt = Date.now();
  const now = Date.now();
  const candidateAt = row.candidate_at ? Date.parse(row.candidate_at) : NaN;
  if (!row.candidate_token || !Number.isFinite(candidateAt)) {
    await updateSyncRow(idx.driveId, {
      candidate_token: current,
      candidate_at: new Date(now).toISOString(),
    });
    return;
  }
  if (now - candidateAt > CANDIDATE_SAFE_AGE_MS) {
    // Old enough that the bootstrap listing is authoritative for everything
    // before it: replay from there next time, and start ageing a new one.
    await updateSyncRow(idx.driveId, {
      page_token: row.candidate_token,
      candidate_token: current,
      candidate_at: new Date(now).toISOString(),
    });
    console.log(
      `[folder-index] drive "${idx.driveName}": replay token advanced to a ${Math.round(
        (now - candidateAt) / 3_600_000
      )} h old change token`
    );
  }
}

// ---------------------------------------------------------------------------
// Drive reads (all with a per-attempt timeout and transient-error retry)

async function fetchStartToken(driveId: string): Promise<string> {
  const drive = getDriveClient();
  const res = await withDriveRetry(
    () =>
      drive.changes.getStartPageToken(
        { driveId, supportsAllDrives: true },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    DRIVE_ATTEMPTS
  );
  const token = res.data.startPageToken;
  if (!token) throw new Error("Drive returned no change start token.");
  return token;
}

// The bulk bootstrap: every non-trashed folder in the drive, one paginated
// files.list. Eventually consistent (see the header) — never used on its own
// for anything recent.
async function listDriveFolderRecords(
  driveId: string
): Promise<Map<string, FolderRecord>> {
  const drive = getDriveClient();
  const byId = new Map<string, FolderRecord>();
  let pageToken: string | undefined;
  do {
    const token = pageToken;
    const res = await withDriveRetry(
      () =>
        drive.files.list(
          {
            corpora: "drive",
            driveId,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            q: `mimeType = '${FOLDER_MIME}' and trashed = false`,
            fields: "nextPageToken, files(id, name, parents)",
            pageSize: 1000,
            pageToken: token,
          },
          { timeout: DRIVE_TIMEOUT_MS }
        ),
      DRIVE_ATTEMPTS
    );
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) {
        byId.set(f.id, {
          id: f.id,
          name: f.name,
          parent: f.parents?.[0] ?? null,
          trashed: false,
          localMutatedAt: 0,
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return byId;
}

function isInvalidTokenError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; message?: string };
  const status = Number(e?.status ?? e?.code);
  const msg = String(e?.message ?? "").toLowerCase();
  return (
    (status === 400 || status === 404) &&
    (msg.includes("token") || msg.includes("invalid") || msg.includes("not found"))
  );
}

// ---------------------------------------------------------------------------
// Applying changes

function removeSubtree(idx: DriveIndex, rootId: string): boolean {
  if (!idx.byId.has(rootId)) return false;
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    idx.byId.delete(cur);
    for (const r of idx.byId.values()) {
      if (r.parent === cur) stack.push(r.id);
    }
  }
  idx.paths = null;
  return true;
}

// Returns true when the index changed.
function applyChange(idx: DriveIndex, c: drive_v3.Schema$Change): boolean {
  if (c.changeType === "drive") {
    // A drive was renamed/added/removed — refresh the drive list soon.
    state.drivesDirty = true;
    return false;
  }
  const id = c.fileId ?? c.file?.id ?? null;
  if (!id) return false;

  const existing = idx.byId.get(id);
  if (
    existing &&
    existing.localMutatedAt &&
    Date.now() - existing.localMutatedAt < LOCAL_MUTATION_SHIELD_MS
  ) {
    return false;
  }

  const f = c.file;
  // Permanently deleted, or moved out of this drive: gone for good.
  if (c.removed || !f || (f.driveId && f.driveId !== idx.driveId)) {
    return removeSubtree(idx, id);
  }
  // Non-folder files (uploads etc.) never enter the index.
  if (f.mimeType !== FOLDER_MIME) return false;

  const name = f.name ?? "";
  const parent = f.parents?.[0] ?? null;
  const trashed = f.trashed === true;
  if (
    existing &&
    existing.name === name &&
    existing.parent === parent &&
    existing.trashed === trashed
  ) {
    return false;
  }
  idx.byId.set(id, { id, name, parent, trashed, localMutatedAt: 0 });
  idx.paths = null;
  return true;
}

// One changes.list round: drain every page since idx.pageToken, apply, and
// remember the new token. Single-flight per drive. Resolves true when the
// drain completed; on failure the index is left as it was (stale beats empty)
// and the drive backs off.
function pollChanges(idx: DriveIndex): Promise<boolean> {
  if (idx.polling) return idx.polling;
  idx.polling = (async () => {
    const drive = getDriveClient();
    let token = idx.pageToken;
    let changed = false;
    try {
      for (;;) {
        const pageToken = token;
        const res = await withDriveRetry(
          () =>
            drive.changes.list(
              {
                driveId: idx.driveId,
                pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                includeRemoved: true,
                pageSize: 1000,
                fields:
                  "nextPageToken, newStartPageToken, changes(changeType, removed, fileId, file(id, name, mimeType, parents, trashed, driveId))",
              },
              { timeout: DRIVE_TIMEOUT_MS }
            ),
          DRIVE_ATTEMPTS
        );
        for (const c of res.data.changes ?? []) {
          if (applyChange(idx, c)) changed = true;
        }
        if (res.data.nextPageToken) {
          token = res.data.nextPageToken;
          continue;
        }
        if (res.data.newStartPageToken) token = res.data.newStartPageToken;
        break;
      }
      idx.pageToken = token;
      idx.lastPollAt = Date.now();
      idx.backoffUntil = 0;
      if (changed) idx.paths = null;
      return true;
    } catch (err) {
      if (isInvalidTokenError(err)) {
        // The stored token is no longer replayable. Start from now and merge a
        // fresh listing in (add only — the listing can't be trusted for
        // removals), so nothing already known disappears.
        console.warn(
          `[folder-index] change token for drive "${idx.driveName}" rejected (${
            err instanceof Error ? err.message : String(err)
          }); resetting.`
        );
        try {
          const fresh = await fetchStartToken(idx.driveId);
          const listing = await listDriveFolderRecords(idx.driveId);
          for (const [id, rec] of listing) {
            if (!idx.byId.has(id)) idx.byId.set(id, rec);
          }
          idx.pageToken = fresh;
          idx.paths = null;
          idx.lastPollAt = Date.now();
          idx.backoffUntil = 0;
          if (idx.persist) {
            await updateSyncRow(idx.driveId, {
              page_token: fresh,
              candidate_token: fresh,
              candidate_at: new Date().toISOString(),
            });
          }
          return true;
        } catch (inner) {
          console.warn("[folder-index] token reset failed:", inner);
          idx.backoffUntil = Date.now() + BACKOFF_MS;
          return false;
        }
      }
      console.warn(
        `[folder-index] changes.list failed for drive "${idx.driveName}":`,
        err instanceof Error ? err.message : err
      );
      idx.backoffUntil = Date.now() + BACKOFF_MS;
      return false;
    } finally {
      idx.polling = null;
    }
  })();
  return idx.polling;
}

// ---------------------------------------------------------------------------
// Bootstrap

async function buildDriveIndex(drive: {
  id: string;
  name: string;
}): Promise<DriveIndex> {
  // Token FIRST, then the listing, then replay from the token: nothing that
  // happens during the listing can fall between the two.
  const loaded = await loadSyncRow(drive.id);
  let token: string;
  let row: SyncRow | null = null;
  let persist = false;
  if (loaded.kind === "row") {
    token = loaded.row.page_token;
    row = loaded.row;
    persist = true;
  } else {
    token = await fetchStartToken(drive.id);
    // Only seed when the row is genuinely absent; a read error must never turn
    // into a write that replaces a good, old token with a young one.
    if (loaded.kind === "absent") persist = await seedSyncRow(drive.id, token);
  }

  const byId = await listDriveFolderRecords(drive.id);
  const idx: DriveIndex = {
    driveId: drive.id,
    driveName: drive.name,
    byId,
    pageToken: token,
    lastPollAt: 0,
    backoffUntil: 0,
    polling: null,
    paths: null,
    persist,
    lastPromotionCheckAt: Date.now(),
  };
  const ok = await pollChanges(idx);
  if (ok && row && persist) await maybePromoteToken(idx, row, idx.pageToken);
  console.log(
    `[folder-index] drive "${drive.name}": ${idx.byId.size} folders indexed` +
      (row ? " (replayed changes since the stored token)" : "") +
      (ok ? "" : " — change replay FAILED, will retry")
  );
  return idx;
}

async function buildAllIndexes(): Promise<Map<string, DriveIndex>> {
  const drives = await withDriveRetry(() => listSharedDrives(), DRIVE_ATTEMPTS);
  const built = await Promise.all(drives.map((d) => buildDriveIndex(d)));
  const map = new Map<string, DriveIndex>();
  for (const idx of built) map.set(idx.driveId, idx);
  state.drivesCheckedAt = Date.now();
  state.drivesDirty = false;
  return map;
}

function startBootstrap(): Promise<Map<string, DriveIndex>> {
  if (state.building) return state.building;
  if (Date.now() - state.bootstrapFailedAt < BACKOFF_MS) {
    return Promise.reject(
      new Error("Folder index bootstrap failed recently; backing off.")
    );
  }
  state.building = buildAllIndexes()
    .then((m) => {
      state.indexes = m;
      return m;
    })
    .catch((err) => {
      state.bootstrapFailedAt = Date.now();
      console.error("[folder-index] bootstrap failed:", err);
      throw err;
    })
    .finally(() => {
      state.building = null;
    });
  return state.building;
}

// Adds state.indexes for drives that appeared since bootstrap, drops ones that are
// gone, refreshes names. Runs in the background; failures are logged and leave
// the current set alone.
function recheckDrivesInBackground(current: Map<string, DriveIndex>) {
  if (state.recheckingDrives) return;
  state.recheckingDrives = true;
  state.drivesCheckedAt = Date.now();
  state.drivesDirty = false;
  void (async () => {
    try {
      const drives = await withDriveRetry(() => listSharedDrives(), DRIVE_ATTEMPTS);
      const seen = new Set<string>();
      for (const d of drives) {
        seen.add(d.id);
        const idx = current.get(d.id);
        if (!idx) {
          current.set(d.id, await buildDriveIndex(d));
        } else if (idx.driveName !== d.name) {
          idx.driveName = d.name;
          idx.paths = null;
        }
      }
      for (const id of Array.from(current.keys())) {
        if (!seen.has(id)) current.delete(id);
      }
    } catch (err) {
      console.warn("[folder-index] could not re-list Shared Drives:", err);
    } finally {
      state.recheckingDrives = false;
    }
  })();
}

// Brings every built index up to date if its last change poll is older than
// POLL_INTERVAL_MS (skipping drives that are backing off after an error).
async function freshen(current: Map<string, DriveIndex>): Promise<void> {
  if (state.drivesDirty || Date.now() - state.drivesCheckedAt > DRIVES_RECHECK_MS) {
    recheckDrivesInBackground(current);
  }
  const now = Date.now();
  const due = Array.from(current.values()).filter(
    (idx) => now - idx.lastPollAt > POLL_INTERVAL_MS && now >= idx.backoffUntil
  );
  await Promise.all(due.map((idx) => pollChanges(idx)));
  // Long-lived instances advance the replay token too, not only cold starts.
  for (const idx of current.values()) {
    if (
      idx.persist &&
      idx.lastPollAt > 0 &&
      now - idx.lastPromotionCheckAt > PROMOTION_CHECK_MS
    ) {
      idx.lastPromotionCheckAt = now;
      void loadSyncRow(idx.driveId).then((loaded) => {
        if (loaded.kind === "row") {
          return maybePromoteToken(idx, loaded.row, idx.pageToken);
        }
      });
    }
  }
}

// The state.indexes, bootstrapped once per process (single-flight) and brought up
// to date. Blocks for as long as that takes — the tree readers need the whole
// thing.
async function getIndexes(): Promise<Map<string, DriveIndex>> {
  const current = state.indexes ?? (await startBootstrap());
  await freshen(current);
  return current;
}

// The state.indexes if they are ready within `maxWaitMs`, else whatever is built
// (possibly null). For the write paths: they must not stall on a cold
// instance's bootstrap listing or on a slow change poll — Drive's own name
// query is a fine fallback there, and the bootstrap keeps running in the
// background. Never throws.
async function getIndexesWithin(
  maxWaitMs: number
): Promise<Map<string, DriveIndex> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = state.indexes
      ? freshen(state.indexes).then(() => state.indexes)
      : startBootstrap();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), maxWaitMs);
    });
    const result = await Promise.race([ready, timeout]);
    return result ?? state.indexes;
  } catch {
    return state.indexes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Paths

// True when every ancestor up to the drive root exists and none is trashed.
// Orphans (parent unknown) are hidden rather than shown at the root: a folder
// misplaced at the root is more confusing than one that appears a moment later
// when its parent arrives through the change feed.
function livePaths(idx: DriveIndex): string[] {
  if (idx.paths) return idx.paths;
  const pathOf = new Map<string, string | null>(); // null = not live
  const resolve = (id: string, seen: Set<string>): string | null => {
    if (pathOf.has(id)) return pathOf.get(id)!;
    const f = idx.byId.get(id);
    if (!f || f.trashed || seen.has(id)) return null;
    seen.add(id);
    let parentPath: string | null;
    if (!f.parent || f.parent === idx.driveId) parentPath = idx.driveName;
    else parentPath = resolve(f.parent, seen);
    const path = parentPath === null ? null : `${parentPath}/${f.name}`;
    pathOf.set(id, path);
    return path;
  };
  const out = new Set<string>([idx.driveName]);
  for (const id of idx.byId.keys()) {
    const p = resolve(id, new Set());
    if (p) out.add(p);
  }
  idx.paths = Array.from(out).sort();
  return idx.paths;
}

// Every folder path across every Shared Drive (drive name as the root
// segment), sorted — the tree the browse page, the upload picker's search and
// GET /api/v1/folders are built from.
export async function getFolderPaths(): Promise<string[]> {
  const all = await getIndexes();
  const merged = new Set<string>();
  for (const idx of all.values()) for (const p of livePaths(idx)) merged.add(p);
  return Array.from(merged).sort();
}

// Kept for the existing call sites, which used to need it to drop a 60 s cache
// after a mutation. Mutations now update the index directly
// (noteFolderCreated / noteFolderTrashed), so there is nothing to clear; this
// only drops the memoised path list, which is cheap to rebuild.
export function clearFolderPathCache() {
  if (!state.indexes) return;
  for (const idx of state.indexes.values()) idx.paths = null;
}

// Poll the change feed now and wait for it — for the user's explicit Refresh.
export async function pollFolderIndexNow(): Promise<void> {
  if (!state.indexes) return;
  const now = Date.now();
  await Promise.all(
    Array.from(state.indexes.values())
      .filter((idx) => now >= idx.backoffUntil)
      .map((idx) => pollChanges(idx))
  );
}

// ---------------------------------------------------------------------------
// Lookups & local mutations (used by lib/googleDrive.ts)

// The live folder named `name` directly under `parentId` (its id and its REAL
// name), or null — including when the index isn't ready in time. Names are
// compared case-insensitively because that is what Drive's `name = '…'` query
// does; callers must use the returned name, not the one they asked with.
export async function indexFindChild(
  driveId: string,
  parentId: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const idx = (await getIndexesWithin(LOOKUP_MAX_WAIT_MS))?.get(driveId);
  if (!idx) return null;
  const wanted = name.toLowerCase();
  for (const r of idx.byId.values()) {
    if (
      r.parent === parentId &&
      !r.trashed &&
      r.name.toLowerCase() === wanted
    ) {
      return { id: r.id, name: r.name };
    }
  }
  return null;
}

// Record a folder this process just created (or discovered via a Drive query
// the index had missed).
export function noteFolderCreated(
  driveId: string,
  folder: { id: string; name: string; parent: string }
) {
  const idx = state.indexes?.get(driveId);
  if (!idx) return;
  idx.byId.set(folder.id, {
    id: folder.id,
    name: folder.name,
    parent: folder.parent,
    trashed: false,
    localMutatedAt: Date.now(),
  });
  idx.paths = null;
}

// Record a folder this process just moved to the trash.
export function noteFolderTrashed(driveId: string, folderId: string) {
  const idx = state.indexes?.get(driveId);
  if (!idx) return;
  const rec = idx.byId.get(folderId);
  if (!rec) return;
  rec.trashed = true;
  rec.localMutatedAt = Date.now();
  idx.paths = null;
}

// Force a change poll now, bounded — for a miss that another instance may
// explain (it created the folder moments ago). Never turns a miss into a long
// stall.
export async function refreshFolderIndex(): Promise<void> {
  if (!state.indexes) {
    await getIndexesWithin(LOOKUP_MAX_WAIT_MS);
    return;
  }
  for (const idx of state.indexes.values()) idx.lastPollAt = 0;
  await getIndexesWithin(LOOKUP_MAX_WAIT_MS * 3);
}
