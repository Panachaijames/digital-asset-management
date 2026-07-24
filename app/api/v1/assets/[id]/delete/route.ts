import { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/api/auth";
import { apiError, jsonWithCors } from "@/lib/api/cors";
import { getAssetById } from "@/lib/api/search";
import { trashDriveFile } from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/api/cors";

// POST /api/v1/assets/{id}/delete — move the Drive file to trash (recoverable
// there for ~30 days) and remove the metadata row. The metadata is NOT
// restored if the file is later rescued from trash.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireApiKey(request, "write");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const row = await getAssetById(id);
    if (!row) return apiError("not_found", "No asset with that id.", 404);

    // Drive first: if trashing fails, nothing is half-deleted.
    await trashDriveFile(row.drive_file_id);

    const { error } = await supabaseAdmin
      .from("common_dam_assets")
      .delete()
      .eq("id", id);
    if (error) {
      // File is trashed but the row remains — flag loudly for manual cleanup.
      console.error(
        `v1 delete INCONSISTENT: drive file ${row.drive_file_id} trashed but row ${id} not deleted:`,
        error
      );
      throw new Error(error.message);
    }

    console.log(
      `[api-v1] delete site=${auth.site} id=${id} drive_file=${row.drive_file_id} name="${row.name}"`
    );
    return jsonWithCors({ data: { id, deleted: true } });
  } catch (err) {
    console.error("v1 delete error:", err);
    return apiError("server_error", "Delete failed.", 500);
  }
}
