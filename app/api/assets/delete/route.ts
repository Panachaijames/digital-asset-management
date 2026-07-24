import { NextRequest, NextResponse } from "next/server";
import { getAssetById } from "@/lib/api/search";
import { trashDriveFile } from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const MAX_IDS = 100;
const CONCURRENCY = 4;

// POST /api/assets/delete — bulk delete for the browse page's Select mode.
// Body: { ids: string[] } (max 100). Per asset: move the Drive file to trash
// (recoverable there ~30 days), then remove the metadata row — same semantics
// as the external /api/v1 delete. Partial failures are reported per id.
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && !!v)
    : [];
  if (!ids.length) {
    return NextResponse.json({ error: "Send ids: string[]." }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `At most ${MAX_IDS} ids per request.` },
      { status: 400 }
    );
  }

  const deleted: string[] = [];
  const failures: { id: string; error: string }[] = [];

  // Small worker pool — sequential is slow for a big selection, unbounded
  // parallelism trips Drive API rate limits.
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const row = await getAssetById(id);
        if (!row) {
          failures.push({ id, error: "No asset with that id." });
          continue;
        }
        // Drive first: if trashing fails, nothing is half-deleted.
        await trashDriveFile(row.drive_file_id);
        const { error } = await supabaseAdmin
          .from("common_dam_assets")
          .delete()
          .eq("id", id);
        if (error) {
          console.error(
            `bulk delete INCONSISTENT: drive file ${row.drive_file_id} trashed but row ${id} not deleted:`,
            error
          );
          throw new Error(error.message);
        }
        deleted.push(id);
      } catch (err) {
        failures.push({
          id,
          error: err instanceof Error ? err.message : "Delete failed.",
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker)
  );

  console.log(
    `[browse] bulk delete: ${deleted.length} deleted, ${failures.length} failed`
  );
  return NextResponse.json({ deleted, failures });
}
