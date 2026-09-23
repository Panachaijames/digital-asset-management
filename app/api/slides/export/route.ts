import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolvePublicBaseUrl } from "@/lib/publicUrl";
import {
  defaultExportFolderPath,
  errorMessage,
  exportAssetsToSlides,
  type SlideItem,
} from "@/lib/googleSlides";
import type { DamAsset, SlideLayout } from "@/lib/types";

export const runtime = "nodejs";
// Slides fetches every image itself during batchUpdate, so a big deck is slow
// by nature — well inside Cloud Run's 300 s but past Next's default budget.
export const maxDuration = 300;

// POST /api/slides/export
// Body: {
//   ids: string[]              — common_dam_assets ids, in the order they
//                                should appear; one slide each
//   name?: string              — deck file name (default "DAM export <date>")
//   layout?: "contain"|"cover" — whole image with a margin (default), or full
//                                bleed with the overflow cropped off-slide
//   captions?: boolean         — print each file's name under/over its image
//   folderPath?: string        — Drive folder for the deck (default
//                                DAM_SLIDES_EXPORT_PATH, else
//                                "<SharedDrive>/Slide Exports")
// }
// Returns { presentation: { presentationId, url, name, folderPath, slides,
//           failures, sharedWith }, missing: string[] }.

const MAX_SLIDES = 60;

// Google's own message for a disabled API is long but genuinely actionable, so
// it's surfaced rather than swallowed — with the one command that fixes it.
function friendlyError(message: string): string {
  if (
    /has not been used in project|accessNotConfigured|slides\.googleapis\.com/i.test(
      message
    )
  ) {
    return (
      "The Google Slides API isn't enabled for this Google Cloud project yet. " +
      "Enable it with: gcloud services enable slides.googleapis.com --project dwp2026 " +
      `(then retry). Google's message: ${message}`
    );
  }
  return message;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const rawIds: unknown = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return NextResponse.json(
        { error: "Pick at least one asset to export." },
        { status: 400 }
      );
    }
    const ids = Array.from(
      new Set(rawIds.filter((v): v is string => typeof v === "string" && !!v.trim()))
    );
    if (!ids.length) {
      return NextResponse.json({ error: "No valid asset ids." }, { status: 400 });
    }
    if (ids.length > MAX_SLIDES) {
      return NextResponse.json(
        {
          error: `That's ${ids.length} images — export at most ${MAX_SLIDES} at a time (Google fetches every image while building the deck).`,
        },
        { status: 400 }
      );
    }

    const layoutRaw = typeof body.layout === "string" ? body.layout : "contain";
    if (layoutRaw !== "contain" && layoutRaw !== "cover") {
      return NextResponse.json(
        { error: 'layout must be "contain" or "cover".' },
        { status: 400 }
      );
    }
    const layout = layoutRaw as SlideLayout;
    const captions = body.captions === true;

    // The images have to be fetchable from Google's network, not just ours.
    const base = resolvePublicBaseUrl(request.headers);
    if (!base.ok) {
      return NextResponse.json({ error: base.message }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("common_dam_assets")
      .select("*")
      .in("id", ids);
    if (error) {
      console.error("Slides export lookup error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const byId = new Map<string, DamAsset>(
      (data ?? []).map((row) => [row.id as string, row as DamAsset])
    );
    // Preserve the caller's order — that's the slide order.
    const rows = ids.map((id) => byId.get(id)).filter((r): r is DamAsset => !!r);
    const missing = ids.filter((id) => !byId.has(id));
    if (!rows.length) {
      return NextResponse.json(
        { error: "None of those assets exist any more." },
        { status: 404 }
      );
    }

    const items: SlideItem[] = rows.map((row) => ({
      driveFileId: row.drive_file_id,
      name: row.name,
      mimeType: row.mime_type || "image/jpeg",
      caption: captions ? row.name : null,
    }));

    const folderPath =
      typeof body.folderPath === "string" && body.folderPath.trim()
        ? body.folderPath.trim()
        : defaultExportFolderPath(rows[0].folder_path);

    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : `DAM export ${new Date().toISOString().slice(0, 10)}`;

    const presentation = await exportAssetsToSlides({
      items,
      name,
      folderPath,
      layout,
      baseUrl: base.base,
    });

    return NextResponse.json({ presentation, missing });
  } catch (e) {
    console.error("Slides export error:", e);
    const message = errorMessage(e) || "Could not create the presentation.";
    return NextResponse.json({ error: friendlyError(message) }, { status: 500 });
  }
}
