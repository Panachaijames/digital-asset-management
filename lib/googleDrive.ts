import { google, type drive_v3 } from "googleapis";
import { Readable } from "stream";

// Service account auth. The service account must be added as a member
// (Content Manager or higher) of whichever Shared Drive holds your assets —
// Drive API access to "My Drive" folders owned by a personal account does
// not work with service accounts, so this assumes a Shared Drive.
//
// GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY come
// from a JSON key downloaded in Google Cloud Console for a service account
// with the Drive API enabled on its project.
function getAuth() {
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n"
  );

  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getAuth() });
}

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

// Lists the Shared Drives the service account is a member of. These are the
// top-level entries in the folder picker — a service account has no personal
// "My Drive". Membership is sufficient; no domain-wide delegation is needed.
export async function listSharedDrives() {
  const drive = getDriveClient();
  const drives: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.drives.list({
      pageSize: 100,
      fields: "nextPageToken, drives(id, name)",
      pageToken,
    });
    for (const d of res.data.drives ?? []) {
      if (d.id && d.name) drives.push({ id: d.id, name: d.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return drives;
}

// Escapes a value for embedding in a Drive query string.
function escapeQueryValue(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Finds a folder named `name` directly under `parentId`, or null if absent.
// Never creates. (Note: Drive allows duplicate-named siblings; this returns
// the first match — the app never creates duplicates so this is only reachable
// via folders made directly in Drive.)
async function findFolder(
  driveId: string,
  parentId: string,
  name: string
): Promise<string | null> {
  const drive = getDriveClient();
  const res = await drive.files.list({
    corpora: "drive",
    driveId,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    q: `name = '${escapeQueryValue(name)}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  return res.data.files?.[0]?.id ?? null;
}

// Finds a folder named `name` directly under `parentId`, creating it if it
// doesn't exist. Returns its ID and whether it was newly created (so an
// explicit "New folder" action can warn instead of silently reusing).
async function findOrCreateFolder(
  driveId: string,
  parentId: string,
  name: string
): Promise<{ id: string; created: boolean }> {
  const existing = await findFolder(driveId, parentId, name);
  if (existing) return { id: existing, created: false };

  const drive = getDriveClient();
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error(`Could not create folder "${name}".`);
  return { id: created.data.id, created: true };
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
): Promise<string> {
  let parentId = rootParentId;
  for (const seg of segments) {
    const id = await findFolder(driveId, parentId, seg);
    if (!id) {
      throw new Error(
        `Folder "${seg}" no longer exists in Drive — it may have been moved, renamed, or deleted. Refresh and try again.`
      );
    }
    parentId = id;
  }
  return parentId;
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
// folder's id, name, and whether it was newly created.
export async function createDriveFolder(
  driveId: string,
  parentId: string,
  name: string
): Promise<{ id: string; name: string; created: boolean }> {
  const { id, created } = await findOrCreateFolder(driveId, parentId, name);
  return { id, name, created };
}

// Creates a new folder named `name` under the folder identified by the
// human-readable `parentPath` (e.g. "dwp_Digital_Asset/ProjectX"). The first
// path segment is the Shared Drive name. Returns the new folder's full path
// and whether it was newly created (false = a folder with that name already
// existed there).
//
// KNOWN LIMITATION: folders are addressed by name-path here. If you ever have
// two Shared Drives with the SAME name, or two sibling folders with the same
// name (only possible if created directly in Drive — this app never makes
// duplicates), the first match wins. Resolving that fully means keying the
// whole tree + assets on Drive folder IDs; out of scope while there's a single
// uniquely-named Shared Drive.
export async function createFolderAtPath(
  parentPath: string,
  name: string
): Promise<{
  id: string;
  name: string;
  path: string;
  driveId: string;
  created: boolean;
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
  const drive = drives.find((d) => d.name === driveName);
  if (!drive) throw new Error(`Shared Drive "${driveName}" not found.`);

  // Find-only walk of the parent chain: a stale path (parent deleted/renamed)
  // fails clearly instead of silently recreating empty folders.
  const parentId = rest.length
    ? await resolveFolderPath(drive.id, drive.id, rest)
    : drive.id;

  const created = await createDriveFolder(drive.id, parentId, clean);
  return {
    id: created.id,
    name: created.name,
    path: `${parentPath}/${created.name}`,
    driveId: drive.id,
    created: created.created,
  };
}

// Walks every Shared Drive the service account can access and returns the full
// human-readable path of every folder (drive name as the root segment), so the
// media-library tree reflects the real Drive structure — including empty
// folders. Efficient: one paginated files.list per drive (all folders at once),
// then paths are reconstructed from the parent chain, not a call per folder.
export async function listAllFolderPaths(): Promise<string[]> {
  const drive = getDriveClient();
  const drives = await listSharedDrives();
  const allPaths = new Set<string>();

  for (const d of drives) {
    const folders: { id: string; name: string; parent: string | null }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        corpora: "drive",
        driveId: d.id,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: "nextPageToken, files(id, name, parents)",
        pageSize: 1000,
        pageToken,
      });
      for (const f of res.data.files ?? []) {
        if (f.id && f.name) {
          folders.push({ id: f.id, name: f.name, parent: f.parents?.[0] ?? null });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    const byId = new Map(folders.map((f) => [f.id, f]));
    const pathCache = new Map<string, string>();
    const resolve = (id: string, seen: Set<string>): string => {
      const cached = pathCache.get(id);
      if (cached) return cached;
      const f = byId.get(id);
      if (!f || seen.has(id)) return d.name; // missing/cyclic → treat as root
      seen.add(id);
      const parentPath =
        f.parent && f.parent !== d.id && byId.has(f.parent)
          ? resolve(f.parent, seen)
          : d.name;
      const path = `${parentPath}/${f.name}`;
      pathCache.set(id, path);
      return path;
    };

    allPaths.add(d.name); // the drive root itself
    for (const f of folders) allPaths.add(resolve(f.id, new Set()));
  }

  return Array.from(allPaths).sort();
}

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

// One media (image/video) file found by a bulk scan, with enough metadata to
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

// Retry transient Google Drive API / network errors (fetch failed, ECONNRESET, 429, 503, 500)
async function withDriveRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      const isNetworkError =
        msg.includes("fetch failed") ||
        msg.includes("socket") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("epipe") ||
        msg.includes("etimedout") ||
        msg.includes("enotfound") ||
        msg.includes("eai_again") ||
        msg.includes("und_err") ||
        msg.includes("other side closed") ||
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("econnaborted") ||
        msg.includes("ratelimitexceeded");
      const e = err as { status?: number; code?: number };
      const status = e?.status ?? e?.code;
      const isTransientStatus =
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504;

      if ((!isNetworkError && !isTransientStatus) || i >= attempts - 1) {
        throw err;
      }
      console.warn(
        `Drive API call failed (${msg}), retrying attempt ${i + 1}/${attempts}...`
      );
      await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
      delay *= 2;
    }
  }
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
          q: `(${parentQuery}) and (mimeType contains 'image/' or mimeType contains 'video/') and trashed = false`,
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
  const drive = drives.find((d) => d.name === driveName);
  if (!drive) throw new Error(`Shared Drive "${driveName}" not found.`);

  const folderId = rest.length
    ? await resolveFolderPath(drive.id, drive.id, rest)
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
