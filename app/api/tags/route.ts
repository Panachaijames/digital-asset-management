import { NextResponse } from "next/server";
import { getTagCounts } from "@/lib/tagCounts";

// GET /api/tags
// Returns every distinct tag currently in use, with a count, sorted by
// frequency. Counting reads the tags column of every asset — paginated in
// countAllTags, because a plain select stops at Supabase's 1000-row cap and
// silently undercounted at library scale — so it goes through the cache in
// lib/tagCounts.ts rather than recounting per request. If this ever needs to
// be exact-to-the-second, replace the counting with a Postgres function that
// does the unnest/count server-side.
export async function GET() {
  try {
    const tags = await getTagCounts();
    return NextResponse.json(
      { tags },
      // The facet list tolerates being a minute out of date; letting the
      // browser reuse it keeps re-opening Filters instant.
      { headers: { "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    console.error("Tag list error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not list tags." },
      { status: 500 }
    );
  }
}
