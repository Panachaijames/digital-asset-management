import { NextRequest, NextResponse } from "next/server";
import {
  classifyImage,
  ClassifierUnavailableError,
  UnsupportedMediaError,
} from "@/lib/gemini";

export const runtime = "nodejs";

// POST /api/classify
// FormData field:
//   image: File     a single image to classify into the dwp taxonomy
//
// Returns { taxonomy: { macro_portfolio, core_sector, sub_sectors }, presetTags }
// on success, or { disabled: true } (HTTP 200) when no GEMINI_API_KEY is set so
// the client can silently fall back to the manual picker.
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const image = formData.get("image") as File | null;

    if (!image) {
      return NextResponse.json({ error: "No image provided." }, { status: 400 });
    }

    const arrayBuffer = await image.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mediaType = image.type || "image/jpeg";

    const { presetTags, ...taxonomy } = await classifyImage(base64, mediaType);
    return NextResponse.json({ taxonomy, presetTags });
  } catch (error) {
    if (
      error instanceof ClassifierUnavailableError ||
      error instanceof UnsupportedMediaError
    ) {
      // Not an error condition for the client — either AI is turned off (no
      // key), or this particular image couldn't be decoded. Either way the
      // upload UI silently falls back to the manual picker.
      return NextResponse.json({ disabled: true });
    }
    console.error("Classify route error:", error);
    // Include a short reason so the client can show WHY the AI was skipped
    // (e.g. quota exhausted vs bad key) instead of a generic label.
    const reason =
      error instanceof Error ? error.message.slice(0, 200) : "unknown";
    return NextResponse.json(
      { error: "Could not classify the image.", reason },
      { status: 500 }
    );
  }
}
