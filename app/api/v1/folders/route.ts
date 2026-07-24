import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { createFolderAtPath } from "@/lib/googleDrive";
import { clearFolderPathCache } from "@/lib/drivePaths";

export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/api/cors";

// POST /api/v1/folders — create a folder.
// Body: { parentPath: string, name: string }. parentPath starts with the
// Shared Drive name and must already exist. Find-or-create underneath, so
// calling twice is safe — `created: false` means it was already there.
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError("bad_request", "Expected a JSON body.", 400);
  }

  const parentPath = typeof body.parentPath === "string" ? body.parentPath : "";
  const name = typeof body.name === "string" ? body.name : "";

  try {
    const folder = await createFolderAtPath(parentPath, name);
    // Drop the cached folder tree so the DAM UI sees the new folder too.
    clearFolderPathCache();

    console.log(
      `[api-v1] folder site=${auth.site} path="${folder.path}" created=${folder.created}`
    );
    // Only the human path goes out — Drive IDs stay internal.
    return jsonWithCors(
      { data: { path: folder.path, created: folder.created } },
      { status: folder.created ? 201 : 200 }
    );
  } catch (err) {
    // createFolderAtPath throws caller-fixable messages (bad name, missing
    // parent, unknown drive).
    const message =
      err instanceof Error ? err.message : "Could not create the folder.";
    console.error(`v1 folder error (site=${auth.site}):`, err);
    return apiError("bad_request", message, 400);
  }
}
