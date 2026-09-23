import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import {
  getDriveFileBuffer,
  getDriveFileMetadata,
  getDriveThumbnailBytes,
} from "@/lib/googleDrive";
import { verifyImageSignature } from "@/lib/signedImageUrl";

export const runtime = "nodejs";

// GET /api/slides/image?f=<driveFileId>&e=<expiry>&s=<signature>&z=<size>
//
// The one endpoint here that GOOGLE calls rather than a browser: the Slides API
// fetches every createImage URL from its own servers, anonymously, so this can't
// sit behind a session. Instead each URL is signed and expires within minutes
// (lib/signedImageUrl.ts) — long enough for the batchUpdate that uses it, after
// which the deck holds Google's own copy of the bytes and this URL is dead.
//
// Unlike /api/thumbnail this returns BYTES, never a redirect (nothing promises
// Google's fetcher follows one), and it always returns a format Slides accepts
// — the DAM's originals include 50 MB TIFFs, which Slides rejects outright and
// which Drive renders as JPEG thumbnails anyway.

const SIZES = [640, 1024, 1600, 2048];
const DEFAULT_SIZE = 1600;
// Slides accepts PNG, JPEG and GIF only; anything else gets rasterised.
const PASSTHROUGH = new Set(["image/jpeg", "image/png", "image/gif"]);
// Above this, the original is never downloaded as a thumbnail fallback — a
// file that big with no Drive thumbnail is not going into a slide today.
const MAX_ORIGINAL_BYTES = 80 * 1024 * 1024;

function pickSize(raw: string | null): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_SIZE;
  return SIZES.reduce((best, s) =>
    Math.abs(s - n) < Math.abs(best - n) ? s : best
  );
}

async function toSlidesSafeJpeg(buffer: Buffer, size: number): Promise<Buffer> {
  return sharp(buffer, { failOn: "none" })
    .rotate() // honour EXIF orientation before we lose the metadata
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const fileId = params.get("f");

  const check = verifyImageSignature(fileId, params.get("e"), params.get("s"));
  if (!check.ok) {
    return NextResponse.json({ error: check.message }, { status: check.status });
  }
  const size = pickSize(params.get("z"));

  try {
    // Drive's own render is the fast path: a few hundred KB of JPEG, already
    // correctly oriented, and it exists even for originals that can't be
    // decoded in full.
    const thumb = await getDriveThumbnailBytes(fileId!, size);
    if (thumb && PASSTHROUGH.has(thumb.mimeType.split(";")[0].trim())) {
      return new NextResponse(new Uint8Array(thumb.buffer), {
        headers: {
          "Content-Type": thumb.mimeType,
          "Content-Length": String(thumb.buffer.length),
          "Cache-Control": "private, max-age=600",
        },
      });
    }
    if (thumb) {
      const jpeg = await toSlidesSafeJpeg(thumb.buffer, size);
      return new NextResponse(new Uint8Array(jpeg), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(jpeg.length),
          "Cache-Control": "private, max-age=600",
        },
      });
    }

    // No thumbnail at all: fall back to the original bytes, rasterised down to
    // something Slides will take. Check the size from METADATA first — the DAM
    // holds 60 MB TIFFs, and buffering one before rejecting it is how you OOM a
    // 1 GiB instance.
    const meta = await getDriveFileMetadata(fileId!);
    if (meta.mimeType.startsWith("video/")) {
      return NextResponse.json(
        { error: "Videos are embedded directly, not fetched as images." },
        { status: 400 }
      );
    }
    if (Number(meta.size) > MAX_ORIGINAL_BYTES) {
      return NextResponse.json(
        {
          error: `File is ${Math.round(
            Number(meta.size) / (1024 * 1024)
          )} MB and Drive has no thumbnail for it — too large to render for a slide.`,
        },
        { status: 413 }
      );
    }
    const original = await getDriveFileBuffer(fileId!);
    const jpeg = await toSlidesSafeJpeg(original.buffer, size);
    return new NextResponse(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.length),
        "Cache-Control": "private, max-age=600",
      },
    });
  } catch (e) {
    console.error("Slides image proxy error:", e);
    return NextResponse.json(
      { error: "Image unavailable for this file." },
      { status: 404 }
    );
  }
}
