import type { drive_v3 } from "googleapis";
import { Readable } from "stream";
import {
  getAuth,
  getDriveClient,
  listSharedDrives,
  withDriveRetry,
} from "./driveClient";
import {
  indexFindChild,
  noteFolderCreated,
  refreshFolderIndex,
} from "./folderIndex";

// Auth, the API client, the Shared Drive list and the retry wrapper live in
// lib/driveClient.ts (see the note there); re-exported so existing importers
// keep working.
export { getDriveClient, listSharedDrives, withDriveRetry };

export interface DriveUploadResult {
  id: string;
  name: string;
  webViewLink: string;
  thumbnailLink: string | null;
  mimeType: string;
  size: string;
}

export async function uploadFileToDrive(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  folderId: string
): Promise<DriveUploadResult> {
  const drive = getDriveClient();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: "id, name, webViewLink, thumbnailLink, mimeType, size",
    supportsAllDrives: true,
  });

  const data = res.data;
  return {
    id: data.id!,
    name: data.name!,
    webViewLink: data.webViewLink!,
    thumbnailLink: data.thumbnailLink ?? null,
    mimeType: data.mimeType!,
    size: data.size ?? "0",
  };
}

// Opens a Drive resumable-upload session and returns its session URL. The
// browser PUTs the file bytes straight to that URL — no auth header needed,
// the URL itself is the (single-use, ~1 week) credential — which bypasses
// Cloud Run's 32 MiB per-request cap entirely. `origin` must be the browser
// page's origin: Google echoes it in CORS headers on the upload responses,
// without which the browser blocks the direct PUT.
export async function createResumableUploadSession(
  fileName: string,
  mimeType: string,
  sizeBytes: number,
  folderId: string,
  origin: string
): Promise<string> {
  const auth = getAuth();
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("Could not obtain a Drive access token.");

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(sizeBytes),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ name: fileName, parents: [folderId] }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Drive refused to open an upload session (HTTP ${res.status}). ${body.slice(0, 300)}`
    );
  }
  const uploadUrl = res.headers.get("location");
  if (!uploadUrl) {
    throw new Error("Drive did not return an upload session URL.");
  }
  return uploadUrl;
}

// Fetches one file's metadata (including its parent folder, so the upload
// completion route can verify the file really landed where it claimed).
export async function getDriveFileMetadata(fileId: string): Promise<{
  id: string;
  name: string;
  mimeType: string;
  size: string;
  webViewLink: string;
  thumbnailLink: string | null;
  parents: string[];
}> {
  const drive = getDriveClient();
  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, webViewLink, thumbnailLink, parents",
    supportsAllDrives: true,
  });
  const d = res.data;
  return {
    id: d.id!,
    name: d.name!,
    mimeType: d.mimeType ?? "application/octet-stream",
    size: d.size ?? "0",
    webViewLink: d.webViewLink!,
    thumbnailLink: d.thumbnailLink ?? null,
    parents: d.parents ?? [],
  };
}

// Escapes a value for embedding in a Drive query string.
function escapeQueryValue(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Drive's own name+parent query. Consistent within a few seconds of a change
// (unlike the whole-drive listing), but not instantly — hence the index below.
async function queryFolder(
  driveId: string,
  parentId: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const drive = getDriveClient();
  const res = await drive.files.list({
    corpora: "drive",
    driveId,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    q: `name = '${escapeQueryValue(name)}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
  });
  const f = res.data.files?.[0];
  return f?.id ? { id: f.id, name: f.name ?? name } : null;
}

// How long to wait before asking Drive a second time about a folder that isn't
// there yet: another Cloud Run instance may have created it moments ago, and
// Drive's name query trails a creation by a few seconds.
const MISS_RETRY_DELAY_MS = 1_500;

// Finds a folder named `name` directly under `parentId`, or null if absent.
// Never creates. Asks the change-feed-backed folder index first (exact, and
// aware of anything this process just created or trashed), then Drive's name
// query; a hit from Drive that the index lacked is remembered. With
// `retryOnMiss`, a miss is re-checked once after a short pause — for the
// find-only walks, where "not there" becomes a hard error.
// (Note: Drive allows duplicate-named siblings; this returns the first match.)
async function findFolder(
  driveId: string,
  parentId: string,
  name: string,
  options: { retryOnMiss?: boolean } = {}
): Promise<{ id: string; name: string } | null> {
  const indexed = await indexFindChild(driveId, parentId, name);
  if (indexed) return indexed;

  const remember = (hit: { id: string; name: string }) => {
    noteFolderCreated(driveId, { id: hit.id, name: hit.name, parent: parentId });
    return hit;
  };

  const queried = await queryFolder(driveId, parentId, name);
  if (queried) return remember(queried);
  if (!options.retryOnMiss) return null;

  await new Promise((r) => setTimeout(r, MISS_RETRY_DELAY_MS));
  await refreshFolderIndex();
  const indexedLater = await indexFindChild(driveId, parentId, name);
  if (indexedLater) return indexedLater;
  const queriedLater = await queryFolder(driveId, parentId, name);
  return queriedLater ? remember(queriedLater) : null;
}

// In-flight find-or-creates on this instance, keyed by drive + parent +
// lower-cased name, so two concurrent requests for the same folder (an API
// consumer firing parallel uploads that each "ensure" the project folder)
// share one create instead of racing to make two.
const pendingCreates = new Map<
  string,
  Promise<{ id: string; name: string; created: boolean }>
>();

// Finds a folder named `name` directly under `parentId`, creating it if it
// doesn't exist. Returns its id, its REAL name (Drive matches names
// case-insensitively, so "australia" can find "Australia") and whether it was
// newly created (so an explicit "New folder" action can warn instead of
// silently reusing). The index-first lookup is what stops two quick calls
// from producing duplicate same-named siblings while Drive's name query still
// lags the first create; the single-flight map covers concurrent ones on the
// same instance. Concurrent creates on DIFFERENT instances inside the change
// feed's ~4 s propagation window can still both succeed — see the API guides,
// which ask consumers not to call folder creation in parallel.
async function findOrCreateFolder(
  driveId: string,
  parentId: string,
  name: string
): Promise<{ id: string; name: string; created: boolean }> {
  const key = `${driveId}/${parentId}/${name.toLowerCase()}`;
  const pending = pendingCreates.get(key);
  if (pending) {
    // The other caller did the work; for this caller the folder now exists.
    const r = await pending;
    return { ...r, created: false };
  }
  const task = (async () => {
    const existing = await findFolder(driveId, parentId, name);
    if (existing) return { ...existing, created: false };
    // Last look before creating: one forced change-feed poll catches a folder
    // another instance made a few seconds ago that Drive's name query hasn't
    // surfaced yet. Shrinks the duplicate window to the feed's own latency.
    await refreshFolderIndex();
    const lateHit = await indexFindChild(driveId, parentId, name);
    if (lateHit) return { ...lateHit, created: false };

    const drive = getDriveClient();
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id, name",
      supportsAllDrives: true,
    });
    if (!created.data.id) throw new Error(`Could not create folder "${name}".`);
    const realName = created.data.name ?? name;
    // Visible in the tree, and to the next lookup, immediately.
    noteFolderCreated(driveId, {
      id: created.data.id,
      name: realName,
      parent: parentId,
    });
    return { id: created.data.id, name: realName, created: true };
  })();
  pendingCreates.set(key, task);
  try {
    return await task;
  } finally {
    pendingCreates.delete(key);
  }
}

// Thrown by the find-only path walks when a segment isn't in Drive. The
// message is the one the app's UI wants ("your tree is stale, refresh"); the
// `segment` field lets the external API phrase its own ("create it first"),
// since for an API caller the folder usually never existed at all.
export class MissingFolderError extends Error {
  constructor(readonly segment: string) {
    super(
      `Folder "${segment}" no longer exists in Drive — it may have been moved, renamed, or deleted. Refresh and try again.`
    );
    this.name = "MissingFolderError";
  }
}

// Resolves a nested folder path under `rootParentId` WITHOUT creating anything,
// throwing a clear error naming the first missing segment. Used for the
// explicit "create a folder under THIS existing parent" flow, so a stale tree
// (parent renamed/deleted in Drive) surfaces a "refresh" error rather than
// silently resurrecting an empty parent.
async function resolveFolderPath(
  driveId: string,
  rootParentId: string,
  segments: string[]
): Promise<{ id: string; names: string[] }> {
  let parentId = rootParentId;
  // Drive's real spelling of each segment (names match case-insensitively).
  const names: string[] = [];
  for (const seg of segments) {
    const hit = await findFolder(driveId, parentId, seg, { retryOnMiss: true });
    if (!hit) throw new MissingFolderError(seg);
    parentId = hit.id;
    names.push(hit.name);
  }
  return { id: parentId, names };
}

// Walks (creating as needed) a nested folder path under `rootParentId` and
// returns the deepest folder's ID. `cache` maps already-resolved sub-paths to
// folder IDs so a batch of files landing in the same folders only pays each
// lookup/create once per request.
export async function ensureFolderPath(
  driveId: string,
  rootParentId: string,
  segments: string[],
  cache: Map<string, string>
): Promise<string> {
  let parentId = rootParentId;
  let key = "";
  for (const seg of segments) {
    key = key ? `${key}/${seg}` : seg;
    const hit = cache.get(key);
    if (hit) {
      parentId = hit;
      continue;
    }
    parentId = (await findOrCreateFolder(driveId, parentId, seg)).id;
    cache.set(key, parentId);
  }
  return parentId;
}

// Creates a folder named `name` directly under `parentId` (find-or-create, so
// repeated calls with the same name don't produce duplicates). Returns the
// folder's id, its real name as stored in Drive, and whether it was newly
// created.
export async function createDriveFolder(
  driveId: string,
  parentId: string,
  name: string
): Promise<{ id: string; name: string; created: boolean }> {
  return findOrCreateFolder(driveId, parentId, name);
}

// Walks a nested folder path under `rootParentId`, CREATING any segment that
// doesn't exist yet (mkdir -p), and reports which ones it had to create so the
// caller can show/log them. Same walk as ensureFolderPath, but path-aware:
// `rootPath` is the human path of rootParentId so created segments come back
// as full paths.
async function ensureFolderPathTracked(
  driveId: string,
  rootParentId: string,
  segments: string[],
  rootPath: string
): Promise<{ parentId: string; createdParents: string[]; path: string }> {
  let parentId = rootParentId;
  let path = rootPath;
  const createdParents: string[] = [];
  for (const seg of segments) {
    const result = await findOrCreateFolder(driveId, parentId, seg);
    // Drive's real name, not the caller's spelling (case may differ).
    path = `${path}/${result.name}`;
    if (result.created) createdParents.push(path);
    parentId = result.id;
  }
  return { parentId, createdParents, path };
}

export interface CreateFolderOptions {
  // Create missing folders along `parentPath` instead of failing on the first
  // one that isn't there. Off by default: the app's own "New folder" button
  // wants a stale tree (parent renamed/deleted in Drive) to surface a
  // "refresh" error rather than silently rebuilding empty parents. The
  // external API turns it on so a consumer can create a whole branch —
  // "Projects/Marketing Hub/Q3" — in one call.
  createParents?: boolean;
}

// Creates a new folder named `name` under the folder identified by the
// human-readable `parentPath` (e.g. "dwp_Digital_Asset/ProjectX"). The first
// path segment is the Shared Drive name. Returns the new folder's full path
// and whether it was newly created (false = a folder with that name already
// existed there), plus the paths of any parents created along the way
// (only ever non-empty with `createParents: true`).
//
// KNOWN LIMITATION: folders are addressed by name-path here. If you ever have
// two Shared Drives with the SAME name, or two sibling folders with the same
// name (only possible if created directly in Drive — this app never makes
// duplicates), the first match wins. Resolving that fully means keying the
// whole tree + assets on Drive folder IDs; out of scope while there's a single
// uniquely-named Shared Drive.
export async function createFolderAtPath(
  parentPath: string,
  name: string,
  options: CreateFolderOptions = {}
): Promise<{
  id: string;
  name: string;
  path: string;
  driveId: string;
  created: boolean;
  createdParents: string[];
}> {
  const clean = name.trim();
  if (!clean || clean.includes("/")) {
    throw new Error("Folder name can't be empty or contain a slash.");
  }

  const segments = parentPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) {
    throw new Error("Pick a Shared Drive (or a folder in one) first.");
  }

  const [driveName, ...rest] = segments;
  const drives = await listSharedDrives();
  // Case-insensitive, like Drive's own name matching for folders.
  const drive =
    drives.find((d) => d.name === driveName) ??
    drives.find((d) => d.name.toLowerCase() === driveName.toLowerCase());
  if (!drive) throw new Error(`Shared Drive "${driveName}" not found.`);

  // The Shared Drive itself is never created — only folders inside it.
  let parentId = drive.id;
  let createdParents: string[] = [];
  // The parent's path as Drive spells it — the caller's `parentPath` may
  // differ in case, and the returned path is what callers store and reuse.
  let realParentPath = driveName;
  if (rest.length) {
    if (options.createParents) {
      const walked = await ensureFolderPathTracked(
        drive.id,
        drive.id,
        rest,
        driveName
      );
      parentId = walked.parentId;
      createdParents = walked.createdParents;
      realParentPath = walked.path;
    } else {
      // Find-only walk of the parent chain: a stale path (parent
      // deleted/renamed) fails clearly instead of silently recreating empty
      // folders.
      const resolved = await resolveFolderPath(drive.id, drive.id, rest);
      parentId = resolved.id;
      realParentPath = [driveName, ...resolved.names].join("/");
    }
  }

  const created = await createDriveFolder(drive.id, parentId, clean);
  return {
    id: created.id,
    name: created.name,
    path: `${realParentPath}/${created.name}`,
    driveId: drive.id,
    created: created.created,
    createdParents,
  };
}

// The whole-drive folder listing that used to live here (listAllFolderPaths)
// is now the bootstrap step of lib/folderIndex.ts — see the note there on why
// it can't be trusted for anything recent.

// Lists folders directly under `parentId` within the given Shared Drive.
// For the root of a drive, pass parentId = driveId (a Shared Drive's root
// folder shares the drive's ID). corpora="drive" + driveId is the reliable,
// Google-recommended scope. We deliberately do NOT use `sharedWithMe` — the
// Drive backend rejects `sharedWithMe = false` with a 400 "Invalid Value".
export async function listDriveFolders(driveId: string, parentId: string) {
  const drive = getDriveClient();
  const folders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      corpora: "drive",
      driveId,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${parentId}' in parents`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) folders.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return folders;
}

// One media (image/video/PDF) file found by a bulk scan, with enough metadata to
// register it as a DAM asset without any further per-file Drive calls.
export interface DriveImageFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  thumbnailLink: string | null;
  folderId: string; // direct parent folder
  relativePath: string; // folder path below the scan root, "" = in the root
}

// One pending folder in a resumable scan walk: its Drive ID plus its path
// relative to the scan root ("" = the root itself). The key names are short
// because arrays of these round-trip to the browser as the scan cursor.
export interface ScanQueueEntry {
  id: string;
  p: string;
}

export interface ScanChunkResult {
  files: DriveImageFile[];
  // Folders discovered but not yet visited — the cursor for the next round.
  // Empty means the walk is complete.
  queue: ScanQueueEntry[];
  foldersScanned: number;
}

// Budgets for one scan round. A round must comfortably fit inside one HTTP
// request — the previous implementation walked the WHOLE tree in a single
// request, which on big nested folders (thousands of subfolders) meant
// hundreds of sequential Drive calls until something broke mid-flight
// ("TypeError: fetch failed" / a 500 after minutes). Budgets are checked
// between 20-folder batches, so one round can overshoot by at most one
// batch's worth of files.
const SCAN_TIME_BUDGET_MS = 40_000;
const SCAN_FILE_BUDGET = 1_500;
const PARENTS_PER_QUERY = 20;

// Scans PART of a folder tree for image/video files, breadth-first from
// `startQueue`, and returns what it found plus the unvisited remainder as
// `queue`. Callers loop scan→import rounds, feeding `queue` back in, until it
// comes back empty — so arbitrarily deep or large trees never have to fit in
// one request. Works for a Shared Drive root too (children of the root have
// the drive ID as their parent).
export async function scanImageFilesChunk(
  driveId: string,
  startQueue: ScanQueueEntry[],
  opts: { timeBudgetMs?: number; fileBudget?: number } = {}
): Promise<ScanChunkResult> {
  const drive = getDriveClient();
  const timeBudgetMs = opts.timeBudgetMs ?? SCAN_TIME_BUDGET_MS;
  const fileBudget = opts.fileBudget ?? SCAN_FILE_BUDGET;
  const startedAt = Date.now();

  const queue: ScanQueueEntry[] = [...startQueue];
  const files: DriveImageFile[] = [];
  let foldersScanned = 0;

  while (
    queue.length > 0 &&
    Date.now() - startedAt < timeBudgetMs &&
    files.length < fileBudget
  ) {
    const batch = queue.splice(0, PARENTS_PER_QUERY);
    const pathById = new Map(batch.map((b) => [b.id, b.p]));
    const parentQuery = batch.map((b) => `'${b.id}' in parents`).join(" or ");

    // 1. Subfolders directly inside this batch → enqueue for later rounds.
    let pageToken: string | undefined;
    do {
      const res = await withDriveRetry(() =>
        drive.files.list({
          corpora: "drive",
          driveId,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          q: `(${parentQuery}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: "nextPageToken, files(id, name, parents)",
          pageSize: 1000,
          pageToken,
        })
      );
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        const parentPath = pathById.get(f.parents?.[0] ?? "");
        if (parentPath === undefined) continue;
        queue.push({
          id: f.id,
          p: parentPath ? `${parentPath}/${f.name}` : f.name,
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    // 2. Media files directly inside this batch.
    let filePageToken: string | undefined = undefined;
    do {
      const res: { data: drive_v3.Schema$FileList } = await withDriveRetry(() =>
        drive.files.list({
          corpora: "drive",
          driveId,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          q: `(${parentQuery}) and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/pdf') and trashed = false`,
          fields:
            "nextPageToken, files(id, name, mimeType, size, webViewLink, thumbnailLink, parents)",
          pageSize: 1000,
          pageToken: filePageToken,
        })
      );
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        const parent = f.parents?.[0];
        if (!parent) continue;
        const relativePath = pathById.get(parent);
        if (relativePath === undefined) continue;
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? "application/octet-stream",
          size: Number(f.size) || 0,
          webViewLink: f.webViewLink ?? "",
          thumbnailLink: f.thumbnailLink ?? null,
          folderId: parent,
          relativePath,
        });
      }
      filePageToken = res.data.nextPageToken ?? undefined;
    } while (filePageToken);

    foldersScanned += batch.length;
  }

  return { files, queue, foldersScanned };
}

// Resolves a human-readable folder path ("DriveName/Sub/Folder") to its Drive
// IDs WITHOUT creating anything — used by the external API's upload so a
// typo'd destination fails loudly instead of growing a stray folder tree.
// Throws with a message naming the missing drive/segment.
export async function resolveFolderPathToId(
  path: string
): Promise<{ driveId: string; folderId: string }> {
  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) throw new Error("folderPath is empty.");

  const [driveName, ...rest] = segments;
  const drives = await listSharedDrives();
  // Case-insensitive, like Drive's own name matching for folders.
  const drive =
    drives.find((d) => d.name === driveName) ??
    drives.find((d) => d.name.toLowerCase() === driveName.toLowerCase());
  if (!drive) throw new Error(`Shared Drive "${driveName}" not found.`);

  const folderId = rest.length
    ? (await resolveFolderPath(drive.id, drive.id, rest)).id
    : drive.id;
  return { driveId: drive.id, folderId };
}

// Replaces a file's CONTENT in place (same fileId, so links/URLs keep
// working). Drive regenerates the thumbnail; the returned link may briefly
// still show the old image.
export async function replaceDriveFile(
  fileId: string,
  buffer: Buffer,
  mimeType: string
): Promise<{ mimeType: string; size: string; thumbnailLink: string | null }> {
  const drive = getDriveClient();
  const res = await drive.files.update({
    fileId,
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id, mimeType, size, thumbnailLink",
    supportsAllDrives: true,
  });
  return {
    mimeType: res.data.mimeType ?? mimeType,
    size: res.data.size ?? "0",
    thumbnailLink: res.data.thumbnailLink ?? null,
  };
}

// Renames a file; returns the name Drive actually stored.
export async function renameDriveFile(
  fileId: string,
  name: string
): Promise<string> {
  const drive = getDriveClient();
  const res = await drive.files.update({
    fileId,
    requestBody: { name },
    fields: "id, name",
    supportsAllDrives: true,
  });
  return res.data.name ?? name;
}

// Moves a file to the Drive trash (recoverable there for ~30 days) rather
// than deleting permanently. Requires the service account to be Content
// manager or higher on the Shared Drive.
export async function trashDriveFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

// Downloads a file's raw buffer from Google Drive by its file ID.
export async function getDriveFileBuffer(
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const drive = getDriveClient();
  const meta = await getDriveFileMetadata(fileId);
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  const buffer = Buffer.from(res.data as ArrayBuffer);
  return { buffer, mimeType: meta.mimeType };
}

// Shape of one media file as far as slide layout cares: what it is, and its
// aspect ratio (width / height) so an image can be fitted to a slide without
// distortion. `aspect` is null when Drive has no dimensions for the file —
// callers fall back to measuring the thumbnail, or to a sane default.
export async function getDriveMediaShape(fileId: string): Promise<{
  mimeType: string;
  aspect: number | null;
  thumbnailLink: string | null;
}> {
  const drive = getDriveClient();
  const res = await withDriveRetry(
    () =>
      drive.files.get(
        {
          fileId,
          fields:
            "mimeType, imageMediaMetadata(width, height), videoMediaMetadata(width, height), thumbnailLink",
          supportsAllDrives: true,
        },
        { timeout: 20_000 }
      ),
    3
  );
  const d = res.data;
  const dims = d.imageMediaMetadata ?? d.videoMediaMetadata ?? null;
  const w = Number(dims?.width) || 0;
  const h = Number(dims?.height) || 0;
  return {
    mimeType: d.mimeType ?? "application/octet-stream",
    aspect: w > 0 && h > 0 ? w / h : null,
    thumbnailLink: d.thumbnailLink ?? null,
  };
}

// Fetches Drive's pre-rendered thumbnail for a file at roughly `size` px on its
// longest edge, or null when Drive has none. Always a raster image (JPEG/PNG)
// even when the original is a TIFF or PSD, which is exactly what the Slides API
// needs. `thumbnailLink` may be passed in to save a metadata round trip; stored
// links expire within hours, so only ever pass a freshly-fetched one.
export async function getDriveThumbnailBytes(
  fileId: string,
  size: number,
  thumbnailLink?: string | null
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  let link = thumbnailLink ?? null;
  if (!link) {
    const drive = getDriveClient();
    const res = await withDriveRetry(
      () =>
        drive.files.get(
          { fileId, fields: "thumbnailLink", supportsAllDrives: true },
          { timeout: 20_000 }
        ),
      3
    );
    link = res.data.thumbnailLink ?? null;
  }
  if (!link) return null;

  // Thumbnail links end in a size directive (e.g. "=s220") — ask for the size
  // we actually want. The URL is itself the (short-lived) credential.
  const url = /=s\d+(-c)?$/.test(link)
    ? link.replace(/=s\d+(-c)?$/, `=s${size}`)
    : link;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return null;
    return {
      buffer,
      mimeType: res.headers.get("content-type") || "image/jpeg",
    };
  } catch {
    return null;
  }
}

// Above this size the original is never downloaded for AI tagging — with no
// usable thumbnail either, the image is reported as a per-image failure.
const MAX_CLASSIFY_DOWNLOAD_BYTES = 80 * 1024 * 1024;

// Fetches image bytes for AI classification, preferring Drive's pre-rendered
// thumbnail (a ~1600px JPEG) over the original file:
//   - originals here are often 40–60 MB TIFFs — downloading a batch of them
//     blows the request timeout ("Failed to fetch" in the auto-tag UI), and
//     decoding them can exceed vips' memory ceiling on a 1 GiB instance;
//   - the thumbnail is a few hundred KB and classifies identically, since the
//     model input is downscaled to ~1568px anyway;
//   - Drive usually renders a thumbnail even for truncated/corrupt originals,
//     rescuing images whose full bytes can't be decoded at all.
// thumbnailLink is fetched fresh per call (stored links expire within hours).
// Falls back to the original bytes when there is no usable thumbnail and the
// file is small enough; otherwise throws a descriptive per-image error.
export async function getDriveImageForClassification(
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const drive = getDriveClient();
  // Every network step is time-capped so one stuck image can never hold a
  // batch request open toward the platform's 300 s limit: metadata 20 s ×3,
  // thumbnail 20 s, original download 75 s ×3.
  const meta = await withDriveRetry(
    () =>
      drive.files.get(
        {
          fileId,
          fields: "mimeType, size, thumbnailLink",
          supportsAllDrives: true,
        },
        { timeout: 20_000 }
      ),
    3
  );
  const mimeType = meta.data.mimeType ?? "application/octet-stream";
  const size = Number(meta.data.size) || 0;

  const thumbnailLink = meta.data.thumbnailLink;
  if (thumbnailLink) {
    try {
      // Thumbnail links end in a size directive (e.g. "=s220") — ask for a
      // 1600px render instead. The URL is itself the (short-lived) credential.
      const url = /=s\d+(-c)?$/.test(thumbnailLink)
        ? thumbnailLink.replace(/=s\d+(-c)?$/, "=s1600")
        : thumbnailLink;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 0) {
          return {
            buffer,
            mimeType: res.headers.get("content-type") || "image/jpeg",
          };
        }
      }
    } catch {
      // Thumbnail fetch is best-effort — fall through to the original bytes.
    }
  }

  if (size > MAX_CLASSIFY_DOWNLOAD_BYTES) {
    throw new Error(
      `File is ${Math.round(size / (1024 * 1024))} MB and Drive has no thumbnail for it — too large to auto-tag; tag it manually.`
    );
  }
  const res = await withDriveRetry(
    () =>
      drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer", timeout: 75_000 }
      ),
    3
  );
  return { buffer: Buffer.from(res.data as ArrayBuffer), mimeType };
}
