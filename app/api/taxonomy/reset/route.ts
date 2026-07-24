import { NextResponse } from "next/server";
import { resetTaxonomy } from "@/lib/taxonomyStore";

export const runtime = "nodejs";

// POST /api/taxonomy/reset
// Discards all edits and restores the built-in default taxonomy.
export async function POST() {
  try {
    const rows = await resetTaxonomy();
    return NextResponse.json({ rows });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not reset the taxonomy.";
    console.error("Taxonomy reset error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
