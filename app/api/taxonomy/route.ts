import { NextRequest, NextResponse } from "next/server";
import { getTaxonomyRows, saveTaxonomyRows } from "@/lib/taxonomyStore";

export const runtime = "nodejs";

// GET /api/taxonomy
// The unified, user-editable tag taxonomy (Macro Portfolio → Core Sector →
// Sub-Sector tags) as flat rows — what the Tag Settings table, the upload
// chips, and the browse filters render.
export async function GET() {
  const rows = await getTaxonomyRows();
  return NextResponse.json({ rows });
}

// POST /api/taxonomy
// Body: { rows: TaxonomyRow[] } — replaces the WHOLE row set (the settings
// table auto-saves its full state; whole-set replace avoids per-row race
// conditions). Returns the sanitised rows as stored.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const rows = await saveTaxonomyRows(body?.rows);
    return NextResponse.json({ rows });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not save the taxonomy.";
    console.error("Taxonomy save error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
