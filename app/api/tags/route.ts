import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/tags
// Returns every distinct tag currently in use, with a count, sorted by
// frequency. Fine at moderate scale (thousands of assets); if this ever
// gets slow, replace with a Postgres function that does the unnest/count
// server-side instead of pulling all tag arrays into Node.
export async function GET() {
  const { data, error } = await supabaseAdmin.from("common_dam_assets").select("tags");

  if (error) {
    console.error("Tag list error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    for (const tag of row.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const tags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  return NextResponse.json({ tags });
}
