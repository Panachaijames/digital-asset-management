import { NextRequest, NextResponse } from "next/server";
import {
  scanImageFilesChunk,
  type DriveImageFile,
  type ScanQueueEntry,
} from "@/lib/googleDrive";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

// Upper bound on a resume cursor a client can hand back — far above any real
// folder tree's BFS frontier, just a guard against a nonsense payload.
const MAX_CURSOR_QUEUE = 100_000;

// The client echoes back `nextCursor` untouched, but it still crosses the
// wire — validate the shape and bail to null (= start over from the root)
// on anything malformed. Restarting is harmless: registered files drop out
// of the candidate list.
function parseCursorQueue(raw: unknown): ScanQueueEntry[] | null {
  if (!raw || typeof raw !== "object") return null;
  const q = (raw as { queue?: unknown }).queue;
  if (!Array.isArray(q) || q.length === 0 || q.length > MAX_CURSOR_QUEUE) {
    return null;
  }
  const out: ScanQueueEntry[] = [];
  for (const entry of q) {
    if (!entry || typeof entry !== "object") return null;
    const { id, p } = entry as { id?: unknown; p?: unknown };
    if (typeof id !== "string" || !id || id.length > 200) return null;
    if (typeof p !== "string" || p.length > 4000) return null;
    out.push({ id, p });
  }
  return out;
}

// POST /api/import/scan
// Finds image/video files that live under a Drive folder but have no DAM
// metadata row yet (typically synced in bulk via Drive for desktop during a
// migration). Read-only: registers nothing.
//
// The walk is CHUNKED: one call visits folders breadth-first only until a
// time/file budget is spent, then hands back the unvisited folders as
// `nextCursor`. The client imports what was found, then calls again with the
// cursor, looping until `nextCursor` is null. This keeps every request short —
// a whole-tree walk in one request used to die mid-flight on big nested
// folders ("fetch failed" after minutes of sequential Drive calls).
//
// JSON body: { driveId: string, folderId: string, cursor?: { queue } }
// Returns (all counts are for THIS round only; the client accumulates):
//   total:          media files seen this round
//   registered:     of those, how many already have a DAM row
//   candidates:     unregistered files found this round
//   candidatesTotal: candidates.length (kept for back-compat)
//   truncated:      true when more folders remain (i.e. nextCursor != null)
//   nextCursor:     opaque cursor to continue the walk, or null when done
//   foldersScanned: folders visited this round
//   foldersPending: folders still queued after this round
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const driveId = typeof body?.driveId === "string" ? body.driveId : "";
    const folderId = typeof body?.folderId === "string" ? body.folderId : "";
    if (!driveId || !folderId) {
      return NextResponse.json(
        { error: "Missing driveId or folderId." },
        { status: 400 }
      );
    }

    const cursorQueue = parseCursorQueue(body?.cursor);
    const startQueue: ScanQueueEntry[] = cursorQueue ?? [
      { id: folderId, p: "" },
    ];

    const { files, queue, foldersScanned } = await scanImageFilesChunk(
      driveId,
      startQueue
    );

    // Which of these are already registered? Batched .in() lookups keep each
    // query URL under the gateway's URL-length limit — 500 IDs built a ~22 KB
    // URL that Supabase's edge dropped mid-handshake ("TypeError: fetch
    // failed", the original cause of big scans dying). 200 IDs ≈ 9 KB, the
    // same size the register route has always used safely.
    const registered = new Set<string>();
    for (let i = 0; i < files.length; i += 200) {
      const ids = files.slice(i, i + 200).map((f) => f.id);
      const { data, error } = await supabaseAdmin
        .from("common_dam_assets")
        .select("drive_file_id")
        .in("drive_file_id", ids);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) registered.add(row.drive_file_id);
    }

    const candidates: DriveImageFile[] = files.filter(
      (f) => !registered.has(f.id)
    );

    return NextResponse.json({
      total: files.length,
      registered: registered.size,
      candidates,
      candidatesTotal: candidates.length,
      truncated: queue.length > 0,
      nextCursor: queue.length > 0 ? { queue } : null,
      foldersScanned,
      foldersPending: queue.length,
    });
  } catch (error) {
    console.error("Import scan error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not scan the folder.",
      },
      { status: 500 }
    );
  }
}
