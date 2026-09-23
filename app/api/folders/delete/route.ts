import { NextRequest, NextResponse } from "next/server";
import { resolveFolderPathToId, trashDriveFile } from "@/lib/googleDrive";
import { clearFolderPathCache } from "@/lib/drivePaths";
import { noteFolderTrashed } from "@/lib/folderIndex";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

// POST /api/folders/delete
// Body: { path: string } — a full folder_path with at least 2 segments (a
// Shared Drive itself can't be deleted). Moves the Drive folder to trash —
// its entire subtree travels with it — then removes every asset row at or
// under that path so search stays in sync.
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const path =
    typeof body.path === "string" ? body.path.trim().replace(/\/+$/, "") : "";
  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    return NextResponse.json(
      {
        error:
          "Pick a folder inside a Shared Drive — a drive itself can't be deleted.",
      },
      { status: 400 }
    );
  }

  try {
    const { driveId, folderId } = await resolveFolderPathToId(path);

    // Drive first: one call moves the folder AND its whole subtree to trash.
    // If it fails, nothing is half-deleted.
    await trashDriveFile(folderId);
    // Out of the tree immediately — Drive's change feed confirms it a few
    // seconds later, but the next /api/paths must not still show it.
    noteFolderTrashed(driveId, folderId);
    clearFolderPathCache();

    // Then drop every asset row at or under the path. LIKE wildcards must be
    // escaped — folder names contain underscores (e.g. dwp_Digital_Asset).
    const escaped = path.replace(/([\\%_])/g, "\\$1");
    const { data: exact, error: e1 } = await supabaseAdmin
      .from("common_dam_assets")
      .delete()
      .eq("folder_path", path)
      .select("id");
    if (e1) throw new Error(e1.message);
    const { data: subtree, error: e2 } = await supabaseAdmin
      .from("common_dam_assets")
      .delete()
      .like("folder_path", `${escaped}/%`)
      .select("id");
    if (e2) throw new Error(e2.message);

    const assetsRemoved = (exact?.length ?? 0) + (subtree?.length ?? 0);
    console.log(
      `[browse] folder delete path="${path}" assetsRemoved=${assetsRemoved}`
    );
    return NextResponse.json({ path, trashed: true, assetsRemoved });
  } catch (error) {
    console.error("Folder delete error:", error);
    const message =
      error instanceof Error ? error.message : "Could not delete the folder.";
    const callerFixable = /not found|no longer exists/i.test(message);
    return NextResponse.json(
      { error: message },
      { status: callerFixable ? 400 : 500 }
    );
  }
}
