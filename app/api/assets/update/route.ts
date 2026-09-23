import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { clearTagCountCache } from "@/lib/tagCounts";
import { deriveSelectionFromTags, normalizeTags } from "@/lib/taxonomy";
import { getTaxonomyTree } from "@/lib/taxonomyStore";
import { PublishPermission } from "@/lib/types";

export const runtime = "nodejs";

const VALID_PERMISSIONS: PublishPermission[] = ["granted", "pending", "restricted"];

// POST /api/assets/update
// Body:
//   id?: string
//   ids?: string[]
//   publishPermission?: "granted" | "pending" | "restricted"
//   tags?: string[]
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Expected JSON body." }, { status: 400 });
    }

    const rawIds = Array.isArray(body.ids)
      ? body.ids
      : typeof body.id === "string"
        ? [body.id]
        : [];
    const ids = rawIds.filter((v: unknown): v is string => typeof v === "string" && !!v);

    if (!ids.length) {
      return NextResponse.json({ error: "Missing asset id or ids array." }, { status: 400 });
    }

    const rawPermission = body.publishPermission ?? body.publish_permission;
    const hasPermission =
      typeof rawPermission === "string" &&
      VALID_PERMISSIONS.includes(rawPermission as PublishPermission);

    const hasTags = Array.isArray(body.tags);

    if (!hasPermission && !hasTags) {
      return NextResponse.json(
        { error: "Provide publishPermission and/or tags to update." },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = {};

    if (hasPermission) {
      updates.publish_permission = rawPermission;
    }

    if (hasTags) {
      const sanitizedTags = normalizeTags(
        body.tags.filter((t: unknown): t is string => typeof t === "string")
      );
      const taxonomy = deriveSelectionFromTags(sanitizedTags, await getTaxonomyTree());
      updates.tags = sanitizedTags;
      updates.macro_portfolio = taxonomy.macro_portfolio;
      updates.core_sector = taxonomy.core_sector;
      updates.sub_sectors = taxonomy.sub_sectors;
    }

    const CHUNK_SIZE = 50;
    const allUpdated: Record<string, unknown>[] = [];

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const { data, error } = await supabaseAdmin
        .from("common_dam_assets")
        .update(updates)
        .in("id", chunk)
        .select();

      if (error) {
        console.error("Failed to update assets chunk:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (data) {
        allUpdated.push(...data);
      }
    }

    if (hasTags) {
      clearTagCountCache();
    }

    return NextResponse.json({
      success: true,
      updatedCount: allUpdated.length,
      updatedAssets: allUpdated,
    });
  } catch (error) {
    console.error("Asset update route error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not update assets.",
      },
      { status: 500 }
    );
  }
}
