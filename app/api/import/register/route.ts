import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import {
  deriveSelectionFromTags,
  normalizeTags,
  type MacroPortfolio,
} from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";

export const runtime = "nodejs";

const MAX_ITEMS = 200;

interface RegisterItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  thumbnailLink: string | null;
  folderId: string;
  relativePath: string;
}

// Canonical (lower-cased key) vocabulary of every macro, core, and tag name
// in the taxonomy — folder-name segments matching any of these become tags.
function buildVocab(tree: MacroPortfolio[]): Map<string, string> {
  const vocab = new Map<string, string>();
  for (const m of tree) {
    if (!vocab.has(m.name.toLowerCase())) vocab.set(m.name.toLowerCase(), m.name);
    for (const c of m.coreSectors) {
      if (!vocab.has(c.name.toLowerCase()))
        vocab.set(c.name.toLowerCase(), c.name);
      for (const t of c.subSectors) {
        if (!vocab.has(t.toLowerCase())) vocab.set(t.toLowerCase(), t);
      }
    }
  }
  return vocab;
}

const cleanString = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function sanitizeItem(raw: unknown): RegisterItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = cleanString(r.id, 200);
  const name = cleanString(r.name, 400);
  const folderId = cleanString(r.folderId, 200);
  if (!id || !name || !folderId) return null;
  return {
    id,
    name,
    mimeType: cleanString(r.mimeType, 100) || "application/octet-stream",
    size: Number(r.size) || 0,
    webViewLink: cleanString(r.webViewLink, 1000),
    thumbnailLink: cleanString(r.thumbnailLink, 1000) || null,
    folderId,
    relativePath: cleanString(r.relativePath, 2000),
  };
}

// POST /api/import/register
// Registers already-in-Drive files (found by /api/import/scan) as DAM assets:
// one Supabase metadata row each, no bytes moved. Tags are seeded from folder
// names along each file's path that exactly match a taxonomy term; the sector
// columns derive from those tags. No AI classification (too slow/expensive
// for a bulk migration) — images can be re-tagged later in the browse UI.
//
// JSON body: { folderPath: string, items: RegisterItem[] } — folderPath is
// the human-readable path of the SCANNED folder ("Drive/Sub"); each item's
// relativePath is appended to it for the stored folder_path.
// Returns { imported: number, skipped: number, failures: [{id,name,error}] }.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const basePath = cleanString(body?.folderPath, 2000);
    const rawItems: unknown[] = Array.isArray(body?.items) ? body.items : [];
    if (!basePath) {
      return NextResponse.json(
        { error: "Missing folderPath." },
        { status: 400 }
      );
    }
    if (!rawItems.length) {
      return NextResponse.json({ error: "No items to register." }, { status: 400 });
    }
    if (rawItems.length > MAX_ITEMS) {
      return NextResponse.json(
        { error: `Send at most ${MAX_ITEMS} items per request.` },
        { status: 400 }
      );
    }

    const items = rawItems
      .map(sanitizeItem)
      .filter((i): i is RegisterItem => i !== null);

    // Drop anything registered since the scan (double-click, overlapping
    // batches, a colleague uploading the same file the normal way).
    const { data: existingRows, error: existErr } = await supabaseAdmin
      .from("common_dam_assets")
      .select("drive_file_id")
      .in("drive_file_id", items.map((i) => i.id));
    if (existErr) throw new Error(existErr.message);
    const existing = new Set((existingRows ?? []).map((r) => r.drive_file_id));

    const fresh = items.filter((i) => !existing.has(i.id));
    const skipped = items.length - fresh.length;

    const tree = await getTaxonomyTree();
    const vocab = buildVocab(tree);

    const rows = fresh.map((item) => {
      const segments = item.relativePath
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      const segTags = segments
        .map((s) => vocab.get(s.toLowerCase()))
        .filter((s): s is string => !!s);
      const initialTags = normalizeTags(segTags, 20);
      const taxonomy = deriveSelectionFromTags(initialTags, tree);
      const tags = normalizeTags(
        [
          ...initialTags,
          ...(taxonomy.macro_portfolio ? [taxonomy.macro_portfolio] : []),
          ...(taxonomy.core_sector ? [taxonomy.core_sector] : []),
          ...(taxonomy.sub_sectors || []),
        ],
        20
      );
      return {
        drive_file_id: item.id,
        name: item.name,
        folder_id: item.folderId,
        folder_path: item.relativePath
          ? `${basePath}/${item.relativePath}`
          : basePath,
        tags,
        macro_portfolio: taxonomy.macro_portfolio,
        core_sector: taxonomy.core_sector,
        sub_sectors: taxonomy.sub_sectors,
        mime_type: item.mimeType,
        size_bytes: item.size,
        web_view_link: item.webViewLink,
        thumbnail_link: item.thumbnailLink,
      };
    });

    let imported = 0;
    const failures: { id: string; name: string; error: string }[] = [];

    if (rows.length) {
      // One bulk insert; if the whole batch is rejected, retry row-by-row so
      // a single bad file doesn't sink the other 199.
      const bulk = await supabaseAdmin.from("common_dam_assets").insert(rows);
      if (!bulk.error) {
        imported = rows.length;
      } else {
        for (let i = 0; i < rows.length; i++) {
          const single = await supabaseAdmin
            .from("common_dam_assets")
            .insert(rows[i]);
          if (single.error) {
            failures.push({
              id: fresh[i].id,
              name: fresh[i].name,
              error: single.error.message,
            });
          } else {
            imported++;
          }
        }
      }
    }

    return NextResponse.json({ imported, skipped, failures });
  } catch (error) {
    console.error("Import register error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not register the files.",
      },
      { status: 500 }
    );
  }
}
