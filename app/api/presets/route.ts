import { NextRequest, NextResponse } from "next/server";
import { addPresetTags, getPresetGroups } from "@/lib/presets";

// GET /api/presets
// Returns the preset tag library (from common_dam_presets in Supabase, with
// built-in defaults as fallback) for the upload page's Presets panel and the
// settings page.
export async function GET() {
  const groups = await getPresetGroups();
  return NextResponse.json({ groups });
}

// POST /api/presets
// Body: { group: string, tags: string[] } — add tags to a group, creating the
// group if it's new. The first-ever write seeds the table with the built-in
// defaults (see lib/presets.ts). Returns the fresh library.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const groups = await addPresetTags(body.group, body.tags);
    return NextResponse.json({ groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not add the preset.";
    console.error("Preset add error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
