import { NextRequest, NextResponse } from "next/server";
import { deletePreset } from "@/lib/presets";

// POST /api/presets/delete
// Delete a tag:         { group, tag }
// Delete a whole group: { group }
// Returns the fresh library. Deleting a preset does NOT remove that tag from
// assets already tagged with it.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const groups = await deletePreset(body.group, body.tag);
    return NextResponse.json({ groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not delete the preset.";
    console.error("Preset delete error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
