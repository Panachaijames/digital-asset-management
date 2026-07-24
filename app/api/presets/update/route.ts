import { NextRequest, NextResponse } from "next/server";
import { renamePresetGroup, renamePresetTag } from "@/lib/presets";

// POST /api/presets/update
// Rename a tag:   { group, tag, newTag }
// Rename a group: { group, newGroup }
// Returns the fresh library. Renames do NOT touch tags already applied to
// assets — the preset library is the menu, not the applied tags.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const groups =
      body.newGroup !== undefined
        ? await renamePresetGroup(body.group, body.newGroup)
        : await renamePresetTag(body.group, body.tag, body.newTag);
    return NextResponse.json({ groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update the preset.";
    console.error("Preset update error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
