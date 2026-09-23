import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import {
  getSiteRoot,
  resolveSiteLocation,
  splitPath,
} from "@/lib/api/folderScope";
import { createFolderAtPath, MissingFolderError } from "@/lib/googleDrive";
import { clearFolderPathCache, getFolderPaths } from "@/lib/drivePaths";

export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/api/cors";

const MAX_NAME_LENGTH = 200;
const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 2000;

// GET /api/v1/folders — list folder paths, so a consumer can discover valid
// locations (and check whether one already exists) instead of guessing.
// Params: location/prefix (limit to that folder + its subfolders), depth
// (levels below it, 1 = immediate children only), q (substring match on the
// path), limit. A key with a configured root only ever sees inside that root.
export async function GET(request: NextRequest) {
  const auth = requireApiKey(request, "read");
  if (!auth.ok) return auth.response;

  const p = request.nextUrl.searchParams;
  const prefixRaw = (p.get("location") ?? p.get("prefix") ?? "").trim();
  const root = getSiteRoot(auth.site);

  // No prefix + no root = the whole tree; a root always narrows it.
  let prefix: string[] | null = root;
  if (prefixRaw) {
    const resolved = resolveSiteLocation(auth.site, prefixRaw);
    if (!resolved.ok) {
      return apiError(
        resolved.code,
        resolved.message,
        resolved.code === "forbidden" ? 403 : 400
      );
    }
    prefix = resolved.segments;
  }

  const depthRaw = p.get("depth");
  const depth = depthRaw === null ? null : Number(depthRaw);
  if (depth !== null && (!Number.isInteger(depth) || depth < 1)) {
    return apiError("bad_request", "depth must be a whole number >= 1.", 400);
  }

  const limitRaw = p.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIST_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return apiError(
      "bad_request",
      `limit must be a whole number between 1 and ${MAX_LIST_LIMIT}.`,
      400
    );
  }

  const q = (p.get("q") ?? "").trim().toLowerCase();

  let paths: string[];
  try {
    paths = await getFolderPaths();
  } catch (err) {
    console.error(`v1 folder list error (site=${auth.site}):`, err);
    return apiError("server_error", "Could not read the folder tree.", 500);
  }

  const prefixPath = prefix ? prefix.join("/") : null;
  // Depth counts levels BELOW the prefix — or below each Shared Drive root
  // when there's no prefix (the drive name is one segment).
  const baseLength = prefix ? prefix.length : 1;

  const matched = paths.filter((path) => {
    if (prefixPath && path !== prefixPath && !path.startsWith(`${prefixPath}/`)) {
      return false;
    }
    if (depth !== null && splitPath(path).length - baseLength > depth) {
      return false;
    }
    if (q && !path.toLowerCase().includes(q)) return false;
    return true;
  });

  return jsonWithCors({
    data: { root: prefixPath, paths: matched.slice(0, limit) },
    meta: { count: Math.min(matched.length, limit), total: matched.length, limit },
  });
}

// POST /api/v1/folders — create a folder.
// Body: { name, location?, createParents?, parentPath? }
//   name          the folder to create. Slashes are allowed and mean nesting,
//                 so "Marketing Hub/Q3" creates both levels.
//   location      where to put it. Optional for a key with a configured root
//                 (see lib/api/folderScope.ts): omit it and the folder lands in
//                 the root; give a short relative path and the root is implied;
//                 give a full path and it must sit inside the root. A key with
//                 no root must send the full path, starting with the Shared
//                 Drive name — exactly as before.
//   createParents missing folders along `location` are created by default
//                 (a whole branch in one call); pass false to require the
//                 location to already exist.
//   parentPath    the original name for `location`, still accepted.
// Find-or-create at every level, so calling twice is safe: `created: false`
// means the folder was already there.
export async function POST(request: NextRequest) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError("bad_request", "Expected a JSON body.", 400);
  }

  const locationRaw =
    typeof body.location === "string"
      ? body.location
      : typeof body.parentPath === "string"
        ? body.parentPath
        : "";
  const nameRaw = typeof body.name === "string" ? body.name : "";
  if (body.createParents !== undefined && typeof body.createParents !== "boolean") {
    return apiError("bad_request", "createParents must be true or false.", 400);
  }
  const createParents = body.createParents !== false;

  // A name may carry its own nesting ("Marketing Hub/Q3"): everything before
  // the last segment joins the location, and the last segment is the folder
  // actually being created.
  const nameSegments = splitPath(nameRaw);
  if (!nameSegments.length) {
    return apiError("bad_request", 'Missing "name" — the folder to create.', 400);
  }
  const name = nameSegments[nameSegments.length - 1];
  if (name.length > MAX_NAME_LENGTH) {
    return apiError(
      "bad_request",
      `Folder name is longer than ${MAX_NAME_LENGTH} characters.`,
      400
    );
  }
  if (name === "." || name === "..") {
    return apiError("bad_request", `"${name}" is not a usable folder name.`, 400);
  }

  const scoped = resolveSiteLocation(auth.site, locationRaw);
  if (!scoped.ok) {
    return apiError(
      scoped.code,
      scoped.message,
      scoped.code === "forbidden" ? 403 : 400
    );
  }
  const parentSegments = [...scoped.segments, ...nameSegments.slice(0, -1)];

  try {
    const folder = await createFolderAtPath(parentSegments.join("/"), name, {
      createParents,
    });
    // Drop the cached folder tree so the DAM UI (and the GET above) see the
    // new folder immediately.
    clearFolderPathCache();

    console.log(
      `[api-v1] folder site=${auth.site} path="${folder.path}" created=${folder.created}` +
        (folder.createdParents.length
          ? ` parents=${folder.createdParents.length}`
          : "")
    );
    // Only human paths go out — Drive IDs stay internal.
    return jsonWithCors(
      {
        data: {
          path: folder.path,
          name: folder.name,
          // As Drive spells it (names match case-insensitively), not as the
          // caller typed it — consistent with `path`.
          location: folder.path.split("/").slice(0, -1).join("/"),
          created: folder.created,
          createdParents: folder.createdParents,
        },
      },
      { status: folder.created ? 201 : 200 }
    );
  } catch (err) {
    console.error(`v1 folder error (site=${auth.site}):`, err);
    // Only reachable with createParents: false — otherwise the walk creates
    // what's missing. Say "create it first", not the UI's "refresh and retry".
    if (err instanceof MissingFolderError) {
      return apiError(
        "bad_request",
        `Location "${parentSegments.join("/")}" doesn't exist — "${
          err.segment
        }" is missing. Create it first, or drop "createParents": false and the DAM will create the missing levels for you.`,
        400
      );
    }
    const message =
      err instanceof Error ? err.message : "Could not create the folder.";
    // createFolderAtPath throws caller-fixable messages (bad name, missing
    // parent with createParents: false, unknown Shared Drive); anything else
    // is a Drive/server problem and shouldn't read as the caller's fault.
    const callerFixable =
      /no longer exists|not found|can't be empty|Pick a Shared Drive/i.test(
        message
      );
    return apiError(
      callerFixable ? "bad_request" : "server_error",
      callerFixable ? message : "Could not create the folder.",
      callerFixable ? 400 : 500
    );
  }
}
