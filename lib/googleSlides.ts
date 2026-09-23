import { google, type slides_v1 } from "googleapis";
import {
  createFolderAtPath,
  getDriveClient,
  getDriveMediaShape,
  getDriveThumbnailBytes,
  withDriveRetry,
} from "@/lib/googleDrive";
import { buildSignedImageUrl } from "@/lib/signedImageUrl";
import type { SlideLayout, SlidesExport } from "@/lib/types";

// Google Slides export: turn a set of DAM assets into a presentation with one
// slide per asset.
//
// Two things drive the shape of this module:
//
//  1. A presentation is created through the DRIVE API (files.create with the
//     presentation mimeType) rather than slides.presentations.create, because
//     the latter drops the file in the service account's own My Drive — which
//     has no storage quota and which nobody else can open. Creating it inside a
//     Shared Drive folder makes the deck owned by the drive, so every member of
//     that drive can open it, and it costs the service account nothing.
//
//  2. Slides never receives image bytes from us. createImage takes a URL and
//     Google's servers fetch it themselves, then store their own copy inside
//     the presentation. So each image is handed over as a short-lived signed
//     URL pointing back at /api/slides/image (see lib/signedImageUrl.ts), and
//     the deck keeps working long after those URLs expire.

const EMU_PER_INCH = 914400;
const PRESENTATION_MIME = "application/vnd.google-apps.presentation";

// Slides fetches every image in a batchUpdate before replying, so a batch of
// 60 would sit on one HTTP request for minutes. Small batches keep each call
// well inside Cloud Run's timeout and limit the blast radius of one bad image.
const SLIDES_PER_BATCH = 6;

// Layout margins, in inches, for the "contain" layout.
const MARGIN_IN = 0.35;
const CAPTION_BAND_IN = 0.5;

// Aspect ratio assumed when neither Drive nor the thumbnail can tell us the
// real one (3:2 — the most common photographic frame).
const FALLBACK_ASPECT = 3 / 2;

export interface SlideItem {
  driveFileId: string;
  name: string;
  mimeType: string;
  // Text placed under (contain) or over (cover) the image. Omit for none.
  caption?: string | null;
}

export interface SlidesExportOptions {
  items: SlideItem[];
  // Deck file name.
  name: string;
  // Full Drive path of the folder to save the deck in, e.g.
  // "dwp_Digital_Asset/Slide Exports". Created if it doesn't exist.
  folderPath: string;
  layout: SlideLayout;
  // Public origin Google should fetch the images from.
  baseUrl: string;
}

function getSlidesAuth() {
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n"
  );
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

export function getSlidesClient() {
  return google.slides({ version: "v1", auth: getSlidesAuth() });
}

// Default destination for exported decks: DAM_SLIDES_EXPORT_PATH when set,
// otherwise a "Slide Exports" folder at the root of the same Shared Drive the
// assets came from (so nothing has to be configured for this to work).
export function defaultExportFolderPath(assetFolderPath: string): string {
  const configured = (process.env.DAM_SLIDES_EXPORT_PATH || "").trim();
  if (configured) return configured.replace(/^\/+|\/+$/g, "");
  const driveName = assetFolderPath.split("/").filter(Boolean)[0] ?? "";
  if (!driveName) {
    throw new Error(
      "Can't tell which Shared Drive to save the presentation in. Set DAM_SLIDES_EXPORT_PATH."
    );
  }
  return `${driveName}/Slide Exports`;
}

// Drive folder names can't contain a slash, and Drive silently trims trailing
// dots/spaces; keep the deck name recognisable but safe.
export function sanitizeDeckName(raw: string): string {
  const cleaned = stripControlChars(raw)
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "DAM export";
}

// Newlines, tabs and other control characters are rejected by Drive in file
// names and would wreck a caption's layout; collapse them to spaces.
export function stripControlChars(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

async function resolveExportFolder(
  folderPath: string
): Promise<{ id: string; path: string }> {
  const segments = folderPath.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      `"${folderPath}" isn't a folder inside a Shared Drive — the export path needs at least "DriveName/Folder".`
    );
  }
  const name = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join("/");
  const folder = await createFolderAtPath(parentPath, name, {
    createParents: true,
  });
  return { id: folder.id, path: folder.path };
}

function fitInside(
  aspect: number,
  boxW: number,
  boxH: number
): { w: number; h: number } {
  const boxAspect = boxW / boxH;
  if (aspect >= boxAspect) return { w: boxW, h: Math.round(boxW / aspect) };
  return { w: Math.round(boxH * aspect), h: boxH };
}

function coverBox(
  aspect: number,
  pageW: number,
  pageH: number
): { w: number; h: number } {
  const pageAspect = pageW / pageH;
  if (aspect >= pageAspect) return { w: Math.round(pageH * aspect), h: pageH };
  return { w: pageW, h: Math.round(pageW / aspect) };
}

function emuSize(w: number, h: number) {
  return {
    width: { magnitude: w, unit: "EMU" as const },
    height: { magnitude: h, unit: "EMU" as const },
  };
}

function emuTransform(x: number, y: number) {
  return {
    scaleX: 1,
    scaleY: 1,
    translateX: x,
    translateY: y,
    unit: "EMU" as const,
  };
}

// The requests that build ONE slide: a blank page, the image (or an embedded
// Drive video), and an optional caption.
//
// Verified against the live API: createImage treats elementProperties.size as a
// BOUNDING BOX — it scales the image to fit inside it, preserving the image's
// real aspect ratio, and re-centres it within the box. Two consequences:
//   - an image can never come out distorted, however wrong our aspect estimate
//     is, so "contain" is safe by construction;
//   - "cover" only truly bleeds when the estimate matches the real image. If it
//     doesn't, the slide letterboxes instead of filling — which is why
//     resolveAspect measures the thumbnail rather than guessing whenever Drive
//     has no dimensions of its own.
function buildSlideRequests(
  item: SlideItem,
  index: number,
  aspect: number,
  imageUrl: string | null,
  layout: SlideLayout,
  page: { w: number; h: number }
): slides_v1.Schema$Request[] {
  const id = String(index + 1).padStart(3, "0");
  const slideId = `damslide${id}`;
  const mediaId = `dammedia${id}`;
  const captionId = `damcap${id}`;

  const requests: slides_v1.Schema$Request[] = [
    {
      createSlide: {
        objectId: slideId,
        // No insertionIndex: each slide appends to the end, so chunked batches
        // stay in order without any index bookkeeping.
        slideLayoutReference: { predefinedLayout: "BLANK" },
      },
    },
  ];

  const caption = stripControlChars(item.caption ?? "").trim();
  const hasCaption = caption.length > 0;
  const margin = Math.round(MARGIN_IN * EMU_PER_INCH);
  const captionBand = hasCaption ? Math.round(CAPTION_BAND_IN * EMU_PER_INCH) : 0;

  let box: { w: number; h: number };
  let x: number;
  let y: number;
  if (layout === "cover") {
    box = coverBox(aspect, page.w, page.h);
    // Negative offsets are legal — the overflow simply falls off the slide,
    // which is what "full bleed" means.
    x = Math.round((page.w - box.w) / 2);
    y = Math.round((page.h - box.h) / 2);
  } else {
    const availW = page.w - margin * 2;
    const availH = page.h - margin * 2 - captionBand;
    box = fitInside(aspect, availW, availH);
    x = Math.round((page.w - box.w) / 2);
    y = margin + Math.round((availH - box.h) / 2);
  }

  if (item.mimeType.startsWith("video/")) {
    // Videos become an embedded Drive player rather than a still frame. Anyone
    // who can open the deck can already open the file, so playback works.
    requests.push({
      createVideo: {
        objectId: mediaId,
        source: "DRIVE",
        id: item.driveFileId,
        elementProperties: {
          pageObjectId: slideId,
          size: emuSize(box.w, box.h),
          transform: emuTransform(x, y),
        },
      },
    });
  } else {
    requests.push({
      createImage: {
        objectId: mediaId,
        url: imageUrl!,
        elementProperties: {
          pageObjectId: slideId,
          size: emuSize(box.w, box.h),
          transform: emuTransform(x, y),
        },
      },
    });
  }

  if (hasCaption) {
    const capH = Math.round(0.35 * EMU_PER_INCH);
    const capW = page.w - margin * 2;
    const capY =
      layout === "cover"
        ? page.h - margin - capH
        : page.h - margin - captionBand + Math.round(0.08 * EMU_PER_INCH);
    // Cover puts the caption on top of the photo, so it needs to be white.
    const rgb =
      layout === "cover"
        ? { red: 1, green: 1, blue: 1 }
        : { red: 0.29, green: 0.31, blue: 0.35 };
    requests.push(
      {
        createShape: {
          objectId: captionId,
          shapeType: "TEXT_BOX",
          elementProperties: {
            pageObjectId: slideId,
            size: emuSize(capW, capH),
            transform: emuTransform(margin, capY),
          },
        },
      },
      { insertText: { objectId: captionId, text: caption } },
      {
        updateTextStyle: {
          objectId: captionId,
          style: {
            fontSize: { magnitude: 10, unit: "PT" },
            foregroundColor: { opaqueColor: { rgbColor: rgb } },
          },
          textRange: { type: "ALL" },
          fields: "fontSize,foregroundColor",
        },
      },
      {
        updateParagraphStyle: {
          objectId: captionId,
          style: { alignment: "CENTER" },
          textRange: { type: "ALL" },
          fields: "alignment",
        },
      }
    );
  }

  return requests;
}

// Aspect ratio for one item, cheapest source first: Drive's own metadata, then
// the pixel dimensions of its thumbnail (which Drive renders even for TIFFs and
// truncated originals), then a plain 3:2 assumption.
async function resolveAspect(item: SlideItem): Promise<number> {
  try {
    const shape = await getDriveMediaShape(item.driveFileId);
    if (shape.aspect && Number.isFinite(shape.aspect)) return shape.aspect;

    const thumb = await getDriveThumbnailBytes(
      item.driveFileId,
      220,
      shape.thumbnailLink
    );
    if (thumb) {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(thumb.buffer, { failOn: "none" }).metadata();
      if (meta.width && meta.height) return meta.width / meta.height;
    }
  } catch (e) {
    console.warn(
      `Slides export: couldn't measure "${item.name}", using 3:2 —`,
      e instanceof Error ? e.message : e
    );
  }
  return FALLBACK_ASPECT;
}

// Resolves aspect ratios for every item with a small amount of concurrency:
// one Drive metadata call each, so a 40-image deck doesn't run 40 sequential
// round trips, and doesn't fire 40 at once either.
async function resolveAspects(items: SlideItem[]): Promise<number[]> {
  const out = new Array<number>(items.length);
  const CONCURRENCY = 5;
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await resolveAspect(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Google API errors carry the useful text in response.data.error.message; the
// Error's own message is often just "Request failed with status code 403".
export function errorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const anyErr = e as {
      response?: { data?: { error?: { message?: string } } };
      message?: string;
    };
    const apiMessage = anyErr.response?.data?.error?.message;
    if (apiMessage) return apiMessage;
    if (anyErr.message) return anyErr.message;
  }
  return String(e);
}

// Every object we create carries an objectId we chose, which makes a retry
// self-checking: if a batchUpdate actually landed but its response was lost to
// a timeout, the retry comes back "the object ID ... is already in use" rather
// than duplicating the slide. Treat that as success — reporting six perfectly
// good slides as failures because the ACK went missing is the worse outcome.
function isAlreadyApplied(message: string): boolean {
  return /already in use|already exists/i.test(message);
}

// Grants writer access on the new deck to DAM_SLIDES_SHARE_WITH (comma or
// space separated emails). Best-effort: the deck already opens for anyone with
// access to the Shared Drive, so a failure here is logged, not fatal.
async function shareDeck(fileId: string): Promise<string[]> {
  const raw = (process.env.DAM_SLIDES_SHARE_WITH || "").trim();
  if (!raw) return [];
  const emails = raw
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
  const drive = getDriveClient();
  const shared: string[] = [];
  for (const emailAddress of emails) {
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { type: "user", role: "writer", emailAddress },
        sendNotificationEmail: false,
        supportsAllDrives: true,
      });
      shared.push(emailAddress);
    } catch (e) {
      console.warn(
        `Slides export: couldn't share the deck with ${emailAddress} —`,
        errorMessage(e)
      );
    }
  }
  return shared;
}

export async function exportAssetsToSlides(
  opts: SlidesExportOptions
): Promise<SlidesExport> {
  const { items, layout, baseUrl } = opts;
  if (!items.length) throw new Error("Nothing selected to export.");

  const name = sanitizeDeckName(opts.name);
  const folder = await resolveExportFolder(opts.folderPath);
  const drive = getDriveClient();
  const slides = getSlidesClient();

  // 1. The deck itself, inside the Shared Drive folder (see the note at the
  //    top of this file for why this isn't presentations.create).
  const created = await withDriveRetry(() =>
    drive.files.create({
      requestBody: { name, mimeType: PRESENTATION_MIME, parents: [folder.id] },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    })
  );
  const presentationId = created.data.id;
  if (!presentationId) throw new Error("Drive did not return a presentation id.");
  const url =
    created.data.webViewLink ??
    `https://docs.google.com/presentation/d/${presentationId}/edit`;

  // 2. Real page size — a new deck is 16:9 today, but read it rather than
  //    assume, so a template change can't silently break every layout.
  const meta = await withDriveRetry(() =>
    slides.presentations.get({
      presentationId,
      fields: "pageSize,slides(objectId)",
    })
  );
  const page = {
    w: Number(meta.data.pageSize?.width?.magnitude) || 10 * EMU_PER_INCH,
    h: Number(meta.data.pageSize?.height?.magnitude) || 5.625 * EMU_PER_INCH,
  };
  const originalSlideIds = (meta.data.slides ?? [])
    .map((s) => s.objectId)
    .filter((id): id is string => !!id);

  // 3. One slide's worth of requests per item.
  const aspects = await resolveAspects(items);

  const perItem = items.map((item, i) => ({
    item,
    requests: buildSlideRequests(
      item,
      i,
      aspects[i],
      item.mimeType.startsWith("video/")
        ? null
        : buildSignedImageUrl(baseUrl, item.driveFileId, { size: 1600 }),
      layout,
      page
    ),
  }));

  const runBatch = (requests: slides_v1.Schema$Request[]) =>
    withDriveRetry(
      () => slides.presentations.batchUpdate({ presentationId, requestBody: { requests } }),
      3
    );

  // 4. Apply in small batches. batchUpdate is atomic, so a batch that trips
  //    over one unfetchable image changes nothing — retry those items one at a
  //    time so a single bad asset costs one slide, not six.
  const failures: { name: string; error: string }[] = [];
  let slideCount = 0;
  for (const group of chunk(perItem, SLIDES_PER_BATCH)) {
    try {
      await runBatch(group.flatMap((g) => g.requests));
      slideCount += group.length;
    } catch (batchError) {
      const batchMessage = errorMessage(batchError);
      if (isAlreadyApplied(batchMessage)) {
        slideCount += group.length;
        continue;
      }
      if (group.length === 1) {
        failures.push({ name: group[0].item.name, error: batchMessage });
        continue;
      }
      console.warn(
        `Slides export: batch of ${group.length} failed, retrying individually —`,
        batchMessage
      );
      for (const one of group) {
        try {
          await runBatch(one.requests);
          slideCount += 1;
        } catch (e) {
          const message = errorMessage(e);
          if (isAlreadyApplied(message)) {
            slideCount += 1;
            continue;
          }
          failures.push({ name: one.item.name, error: message });
        }
      }
    }
  }

  // 5. Nothing landed — don't leave an empty deck behind.
  if (slideCount === 0) {
    await drive.files
      .update({ fileId: presentationId, requestBody: { trashed: true }, supportsAllDrives: true })
      .catch(() => {});
    throw new Error(
      failures[0]?.error
        ? `Couldn't add any slides: ${failures[0].error}`
        : "Couldn't add any slides."
    );
  }

  // 6. Drop the blank slide Drive created the deck with. Done last so the deck
  //    is never momentarily slide-less (which the API rejects).
  if (originalSlideIds.length) {
    await runBatch(
      originalSlideIds.map((objectId) => ({ deleteObject: { objectId } }))
    ).catch((e) =>
      console.warn(
        "Slides export: couldn't remove the deck's initial blank slide —",
        errorMessage(e)
      )
    );
  }

  const sharedWith = await shareDeck(presentationId);

  return {
    presentationId,
    url,
    name,
    folderPath: folder.path,
    slides: slideCount,
    failures,
    sharedWith,
  };
}
