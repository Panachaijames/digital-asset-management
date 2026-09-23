import { google } from "googleapis";

// Low-level Google Drive access: service-account auth, the API client, the
// Shared Drive list, and the transient-error retry wrapper. Split out of
// lib/googleDrive.ts so that lib/folderIndex.ts (which needs a client) and
// lib/googleDrive.ts (which needs the index) don't import each other.
// lib/googleDrive.ts re-exports everything here, so existing importers of
// getDriveClient / listSharedDrives / withDriveRetry keep working unchanged.

// Service account auth. The service account must be added as a member
// (Content Manager or higher) of whichever Shared Drive holds your assets —
// Drive API access to "My Drive" folders owned by a personal account does
// not work with service accounts, so this assumes a Shared Drive.
//
// GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY come
// from a JSON key downloaded in Google Cloud Console for a service account
// with the Drive API enabled on its project.
export function getAuth() {
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

// Retry transient Google Drive API / network errors (fetch failed, ECONNRESET, 429, 503, 500).
// Exported because the Slides API (lib/googleSlides.ts) fails the same ways.
export async function withDriveRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
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
