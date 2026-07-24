"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import TagInput from "@/components/TagInput";
import TagPresets from "@/components/TagPresets";
import { PresetGroupChips, useAllPresetGroups } from "@/components/PresetChips";
import FolderPicker from "@/components/FolderPicker";
import type {
  QueuedFile,
  DamAsset,
  DriveFolder,
  TaxonomySelection,
} from "@/lib/types";

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Shrinks an image client-side before sending it to /api/classify — cuts the
// vision-model token cost and upload time. The full-resolution original is
// still what gets uploaded to Drive.
async function downscaleForClassify(
  file: File,
  maxDim = 1024,
  quality = 0.8
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    return blob ?? file;
  } catch {
    return file;
  }
}

type IncomingFile = { file: File; relativePath: string };

// Accept images and videos by MIME type or (folder drops sometimes report no
// type) by file extension.
function isMediaFile(f: File) {
  return (
    f.type.startsWith("image/") ||
    f.type.startsWith("video/") ||
    /\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|m4v|webm|avi|mkv)$/i.test(f.name)
  );
}

// Videos skip AI classification (the vision classifier is image-only) and
// render a <video> preview instead of an <img>.
function isVideoFile(f: File) {
  return (
    f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(f.name)
  );
}

// Recursively walks dropped directory entries, collecting files with their
// folder path relative to the drop (the dropped folder's own name included,
// so dropping "ProjectX" recreates ProjectX/... under the destination).
async function collectDroppedEntries(
  entries: FileSystemEntry[]
): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  async function walk(entry: FileSystemEntry, dir: string): Promise<void> {
    if (entry.isFile) {
      try {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject)
        );
        out.push({ file, relativePath: dir });
      } catch {
        // Unreadable entry — skip it.
      }
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const next = dir ? `${dir}/${entry.name}` : entry.name;
      // readEntries returns at most ~100 entries per call — loop until empty.
      for (;;) {
        let batch: FileSystemEntry[];
        try {
          batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject)
          );
        } catch {
          break;
        }
        if (!batch.length) break;
        for (const child of batch) await walk(child, next);
      }
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

// Files no longer pass through our server (Cloud Run caps a request at
// 32 MiB) — each one goes browser → Google Drive directly via a resumable
// session the server opens, so there is no practical per-file size limit.

// PUTs the whole file straight to a Drive resumable-session URL. Resolves
// with the new Drive file ID from Drive's completion response.
const putFileToDrive = (
  uploadUrl: string,
  file: File,
  onProgress: (loaded: number) => void
): Promise<string> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.id) {
            resolve(data.id);
            return;
          }
        } catch {
          // fall through to the reject below
        }
        reject(new Error("Google Drive returned an unexpected response."));
      } else {
        reject(
          new Error(`Google Drive rejected the upload (HTTP ${xhr.status}).`)
        );
      }
    };
    xhr.onerror = () =>
      reject(new Error("Network error while uploading to Google Drive."));
    xhr.send(file);
  });

type BatchState = "idle" | "uploading" | "done" | "error";

// One queued image: preview, status, and its OWN tags (the AI's picks land
// here). "+ add from presets" opens the preset chips for JUST this image —
// the batch Presets panel at the bottom applies to every image instead.
function QueueCard({
  q,
  isUploading,
  onRemove,
  onTagsChange,
}: {
  q: QueuedFile;
  isUploading: boolean;
  onRemove: (id: string) => void;
  onTagsChange: (id: string, tags: string[]) => void;
}) {
  const [showPresets, setShowPresets] = useState(false);
  const groups = useAllPresetGroups();

  const toggleTag = (tag: string) => {
    const has = q.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
    onTagsChange(
      q.id,
      has
        ? q.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...q.tags, tag]
    );
  };

  return (
    <div className="flex gap-3 rounded-sm border border-line bg-card p-3">
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-sm bg-panel">
        {isVideoFile(q.file) ? (
          <video
            src={q.previewUrl}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : (
          <Image
            src={q.previewUrl}
            alt={q.file.name}
            fill
            unoptimized
            className="object-cover"
          />
        )}
        {isVideoFile(q.file) && (
          <span className="absolute left-1 top-1 rounded-sm bg-ink/70 px-1 font-mono text-[9px] uppercase text-white">
            video
          </span>
        )}
        {q.status === "done" && (
          <div className="absolute inset-x-0 bottom-0 bg-blueprint-600/90 py-0.5 text-center text-[10px] font-mono text-white">
            uploaded
          </div>
        )}
        {q.status === "error" && (
          <div className="absolute inset-x-0 bottom-0 bg-red-700/90 py-0.5 text-center text-[10px] font-mono text-white">
            failed
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-ink/60">
            {q.file.name}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {q.classifyStatus === "classifying" && (
              <span className="animate-pulse font-mono text-[10px] text-blueprint-600">
                AI classifying…
              </span>
            )}
            {q.classifyStatus === "done" && (
              <span className="font-mono text-[10px] text-ink/30">
                AI suggested
              </span>
            )}
            {q.classifyStatus === "error" && (
              <span className="font-mono text-[10px] text-ink/30">
                AI unavailable — pick manually
              </span>
            )}
            {!isUploading && q.status === "queued" && (
              <button
                type="button"
                onClick={() => onRemove(q.id)}
                aria-label={`Remove ${q.file.name}`}
                className="text-xs text-ink/40 hover:text-red-400"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {q.relativePath && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-ink/40">
            📁 {q.relativePath}/
          </p>
        )}

        {/* This image's own tags — AI suggestions land here, editable per
            image. Batch tags below are added on top at upload. */}
        {q.status !== "done" && (
          <div className="mt-2">
            <TagInput
              tags={q.tags}
              onChange={(next) => onTagsChange(q.id, next)}
              label="Tags for this image"
              hint={null}
              compact
            />
            <button
              type="button"
              onClick={() => setShowPresets((v) => !v)}
              disabled={isUploading}
              className="mt-1.5 font-mono text-[11px] text-blueprint-400 hover:underline disabled:opacity-40"
            >
              {showPresets ? "− hide presets" : "+ add from presets"}
            </button>
            {showPresets && (
              <div className="mt-1.5 max-h-56 overflow-y-auto rounded-sm border border-line bg-panel/60 p-2.5">
                {!groups ? (
                  <p className="text-xs text-ink/40">Loading presets…</p>
                ) : (
                  <PresetGroupChips
                    groups={groups}
                    selected={q.tags}
                    onToggle={toggleTag}
                    disabled={isUploading}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {q.status === "error" && q.error && (
          <p className="mt-1.5 text-xs text-red-400">
            Upload failed: {q.error}
          </p>
        )}
      </div>
    </div>
  );
}

export default function ImageUploader() {
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [folder, setFolder] = useState<DriveFolder | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchState, setBatchState] = useState<BatchState>("idle");
  const [progress, setProgress] = useState(0);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ fileName: string; error: string }[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Keep a live reference to the queue so the unmount cleanup can revoke the
  // latest set of preview blob URLs without re-subscribing on every change.
  const queueRef = useRef<QueuedFile[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Revoke any outstanding preview object URLs when the uploader unmounts
  // (e.g. navigating to /browse) so preview blobs don't leak for the
  // document's lifetime. removeFile/reset already revoke on their paths;
  // revoking an already-revoked URL is a harmless no-op.
  useEffect(() => {
    return () => {
      queueRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    };
  }, []);

  // Ask the vision model to classify one queued image, then pre-fill its
  // taxonomy — but only if the user hasn't already picked one.
  const classifyFile = useCallback(async (id: string, file: File) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.id === id ? { ...q, classifyStatus: "classifying" } : q
      )
    );
    try {
      const blob = await downscaleForClassify(file);
      const form = new FormData();
      form.append("image", blob, "image.jpg");
      const res = await fetch("/api/classify", { method: "POST", body: form });
      const data = await res.json();

      if (data.disabled) {
        // AI turned off (no API key) — leave it to the manual picker.
        setQueue((prev) =>
          prev.map((q) => (q.id === id ? { ...q, classifyStatus: "idle" } : q))
        );
        return;
      }
      if (!res.ok || !data.taxonomy) {
        // Surface WHY in the console so failures are debuggable from the browser.
        console.warn("AI classify failed:", data.reason ?? data.error ?? res.status);
        throw new Error("classify failed");
      }

      // EVERYTHING the AI picked — Portfolio, Sector, Typologies and presets —
      // lands on THIS image's own tags (each image is tagged individually).
      // Batch tags below are added to every image on top of these at upload.
      const tx = data.taxonomy as TaxonomySelection;
      const aiTags = [
        tx.macro_portfolio,
        tx.core_sector,
        ...(tx.sub_sectors ?? []),
        ...((data.presetTags as string[]) ?? []),
      ].filter((t): t is string => !!t);
      setQueue((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          const seen = new Set(q.tags.map((t) => t.toLowerCase()));
          const merged = [...q.tags];
          for (const t of aiTags) {
            if (!seen.has(t.toLowerCase())) {
              seen.add(t.toLowerCase());
              merged.push(t);
            }
          }
          return { ...q, classifyStatus: "done", tags: merged };
        })
      );
    } catch {
      setQueue((prev) =>
        prev.map((q) => (q.id === id ? { ...q, classifyStatus: "error" } : q))
      );
    }
  }, []);

  const addFiles = useCallback(
    (incomingRaw: IncomingFile[]) => {
      const incoming = incomingRaw.filter(({ file }) => isMediaFile(file));

      const newItems: QueuedFile[] = incoming.map(({ file, relativePath }) => ({
        id: makeId(),
        file,
        relativePath,
        previewUrl: URL.createObjectURL(file),
        tags: [],
        status: "queued" as const,
        progress: 0,
        // Images: "classifying" from the moment they're queued (even before
        // the bounded pool picks them up) so the Upload button stays gated
        // until every image's AI picks have landed in the Tags field.
        // Videos: the vision classifier is image-only — straight to manual.
        classifyStatus: isVideoFile(file)
          ? ("idle" as const)
          : ("classifying" as const),
      }));

      setQueue((prev) => [...prev, ...newItems]);
      // Kick off AI classification (images only) with a small bounded pool so
      // a big drop doesn't fire dozens of concurrent vision calls at once
      // (eases browser connection pressure, server memory, and API burst).
      const toClassify = newItems.filter((item) => !isVideoFile(item.file));
      const LIMIT = 3;
      let idx = 0;
      const runNext = async (): Promise<void> => {
        while (idx < toClassify.length) {
          const item = toClassify[idx++];
          await classifyFile(item.id, item.file);
        }
      };
      void Promise.all(
        Array.from({ length: Math.min(LIMIT, toClassify.length) }, runNext)
      );
    },
    [classifyFile]
  );

  // Replace one queued image's own tag list (edited on its card).
  const setFileTags = (id: string, next: string[]) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === id ? { ...q, tags: next } : q))
    );
  };

  const removeFile = (id: string) => {
    setQueue((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  };

  // Toggle a preset tag in/out of the batch tags (case-insensitive match).
  const togglePresetTag = (tag: string) => {
    setTags((prev) => {
      const has = prev.some((t) => t.toLowerCase() === tag.toLowerCase());
      return has
        ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...prev, tag];
    });
  };

  const reset = () => {
    queue.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setQueue([]);
    setTags([]);
    setBatchState("idle");
    setProgress(0);
    setBatchError(null);
    setFailures([]);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const dt = e.dataTransfer;
    // The entries API is what lets us receive whole folders. Entries must be
    // grabbed synchronously — the DataTransfer is neutered after the handler.
    const entries = Array.from(dt.items ?? [])
      .map((item) =>
        typeof item.webkitGetAsEntry === "function"
          ? item.webkitGetAsEntry()
          : null
      )
      .filter((en): en is FileSystemEntry => en !== null);
    if (entries.length) {
      void collectDroppedEntries(entries).then((collected) => {
        if (collected.length) addFiles(collected);
      });
    } else if (dt.files?.length) {
      addFiles(
        Array.from(dt.files).map((file) => ({ file, relativePath: "" }))
      );
    }
  };

  // Uploads ONE file: ask the server for a Drive resumable session (it also
  // recreates any dropped subfolders), PUT the bytes straight to Drive, then
  // tell the server to record the metadata row. Returns the created asset.
  const uploadOne = async (
    q: QueuedFile,
    dest: DriveFolder,
    onProgress: (loaded: number) => void
  ): Promise<DamAsset> => {
    const sessionRes = await fetch("/api/upload/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: q.file.name,
        mimeType: q.file.type || "application/octet-stream",
        sizeBytes: q.file.size,
        folderId: dest.id,
        folderPath: dest.path,
        driveId: dest.driveId,
        relativePath: q.relativePath,
      }),
    });
    const session = await sessionRes.json().catch(() => ({}));
    if (!sessionRes.ok) {
      throw new Error(session.error || "Could not start the upload.");
    }

    const driveFileId = await putFileToDrive(
      session.uploadUrl,
      q.file,
      onProgress
    );

    const completeRes = await fetch("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driveFileId,
        folderId: session.folderId,
        folderPath: session.folderPath,
        fileTags: q.tags,
        batchTags: tags,
      }),
    });
    const complete = await completeRes.json().catch(() => ({}));
    if (!completeRes.ok || !complete.result) {
      throw new Error(
        complete.error || "Uploaded to Drive but could not record the file."
      );
    }
    return complete.result as DamAsset;
  };

  const handleUpload = async () => {
    if (!queue.length || !folder) return;
    const dest = folder;

    setBatchState("uploading");
    setBatchError(null);
    setFailures([]);
    setProgress(0);

    // Only send what hasn't already uploaded — re-running after a partial
    // failure must not duplicate the already-done files in Drive.
    const pending = queue.filter((q) => q.status !== "done");
    const totalBytes = pending.reduce((n, q) => n + q.file.size, 0) || 1;
    let doneBytes = 0;
    let successCount = 0;
    const allFailures: { fileName: string; error: string }[] = [];

    // Sequential files: predictable progress, gentle on Drive rate limits,
    // and later files reuse folders created for earlier ones.
    for (const q of pending) {
      try {
        const result = await uploadOne(q, dest, (loaded) => {
          setProgress(
            Math.min(
              99,
              Math.round(
                ((doneBytes + Math.min(loaded, q.file.size)) / totalBytes) *
                  100
              )
            )
          );
        });
        successCount++;
        setQueue((prev) =>
          prev.map((item) =>
            item.id === q.id
              ? { ...item, status: "done" as const, result }
              : item
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed.";
        allFailures.push({ fileName: q.file.name, error: msg });
        setQueue((prev) =>
          prev.map((item) =>
            item.id === q.id
              ? { ...item, status: "error" as const, error: msg }
              : item
          )
        );
      }
      doneBytes += q.file.size;
    }

    setFailures(allFailures);
    setProgress(100);
    if (successCount === 0 && pending.length > 0) {
      setBatchError(allFailures[0]?.error ?? "Upload failed.");
      setBatchState("error");
    } else {
      setBatchState("done");
    }
  };

  const isUploading = batchState === "uploading";
  const pendingCount = queue.filter((q) => q.status !== "done").length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl italic text-ink">
          Upload assets
        </h1>
        <p className="mt-1.5 text-sm text-ink/60">
          Files land in Google Drive. Images are auto-classified into the dwp
          sector taxonomy (videos are tagged manually) — review and adjust
          before uploading.
        </p>
      </header>

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-sm border-2 border-dashed px-6 py-14 text-center transition-colors ${
          isDragOver
            ? "border-blueprint-600 bg-blueprint-50"
            : "border-line bg-card hover:border-blueprint-400"
        }`}
      >
        <p className="font-display text-lg text-ink">
          Drag images or videos here, or click to browse
        </p>
        <p className="mt-1 text-xs text-ink/40">
          JPG, PNG, WEBP, GIF, HEIC + MP4, MOV, WEBM — single files or entire
          folders (subfolders are recreated in Drive). Videos skip AI tagging.
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            folderInputRef.current?.click();
          }}
          className="mt-3 font-mono text-xs text-blueprint-600 hover:underline"
        >
          Select a whole folder…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (!e.target.files) return;
            addFiles(
              Array.from(e.target.files).map((file) => ({
                file,
                relativePath: "",
              }))
            );
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (!e.target.files) return;
            addFiles(
              Array.from(e.target.files).map((file) => {
                const rel = file.webkitRelativePath || "";
                const dir = rel.includes("/")
                  ? rel.slice(0, rel.lastIndexOf("/"))
                  : "";
                return { file, relativePath: dir };
              })
            );
            e.target.value = "";
          }}
          {...({ webkitdirectory: "" } as Record<string, string>)}
        />
      </div>

      {/* Per-image cards with AI-suggested taxonomy */}
      {queue.length > 0 && (
        <div className="mt-6 space-y-3">
          {queue.map((q) => (
            <QueueCard
              key={q.id}
              q={q}
              isUploading={isUploading}
              onRemove={removeFile}
              onTagsChange={setFileTags}
            />
          ))}
          <p className="text-xs text-ink/40">
            {queue.length} file{queue.length === 1 ? "" : "s"} queued
          </p>
        </div>
      )}

      {/* Batch tags + folder (added to every image, on top of its own tags) */}
      <div className="mt-8 space-y-6">
        <div>
          <TagInput
            tags={tags}
            onChange={setTags}
            label="Batch tags"
            hint="Press Enter or comma to add. Added to EVERY image in this batch, on top of each image's own tags above."
          />
          <TagPresets
            selected={tags}
            onToggle={togglePresetTag}
            disabled={isUploading}
          />
        </div>
        <FolderPicker selected={folder} onSelect={setFolder} />
      </div>

      {/* Progress */}
      {isUploading && (
        <div className="mt-6">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full bg-blueprint-600 transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink/40">Uploading… {progress}%</p>
        </div>
      )}

      {batchError && (
        <p className="mt-4 rounded-sm bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {batchError}
        </p>
      )}

      {batchState === "done" && failures.length > 0 && (
        <div className="mt-4 rounded-sm bg-blueprint-50 px-3 py-2 text-sm text-blueprint-700">
          {queue.filter((q) => q.status === "done").length} of {queue.length}{" "}
          uploaded to <span className="font-mono">{folder?.path}</span>.
          {` ${failures.length} failed.`}
        </div>
      )}

      {/* Success dialog — OK resets the form (folder kept) so the next
          upload can start immediately. Shown only on a fully clean batch;
          partial failures keep the inline banner + error cards instead. */}
      {batchState === "done" && failures.length === 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6"
          role="dialog"
          aria-modal="true"
          aria-label="Upload completed"
          onClick={reset}
        >
          <div
            className="w-full max-w-sm rounded-sm border border-line bg-card p-6 text-center shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-blueprint-600 text-lg text-white">
              ✓
            </div>
            <h2 className="mt-3 font-display text-lg italic text-ink">
              Upload completed
            </h2>
            <p className="mt-1.5 text-sm text-ink/60">
              {queue.filter((q) => q.status === "done").length} file
              {queue.filter((q) => q.status === "done").length === 1 ? "" : "s"}{" "}
              uploaded to <span className="font-mono">{folder?.path}</span>.
            </p>
            <button
              type="button"
              autoFocus
              onClick={reset}
              className="mt-5 w-full rounded-sm bg-blueprint-600 px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={handleUpload}
          disabled={
            !pendingCount ||
            isUploading ||
            !folder ||
            queue.some((q) => q.classifyStatus === "classifying")
          }
          className="rounded-sm bg-blueprint-600 px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {isUploading
            ? "Uploading…"
            : `Upload ${pendingCount || ""} file${pendingCount === 1 ? "" : "s"}`}
        </button>
        {(queue.length > 0 || batchState === "done") && !isUploading && (
          <button
            type="button"
            onClick={reset}
            className="text-sm text-ink/50 hover:text-ink"
          >
            Clear
          </button>
        )}
        {!folder && queue.length > 0 && (
          <span className="text-xs text-ink/40">Select a folder to enable upload</span>
        )}
        {folder &&
          !isUploading &&
          queue.some((q) => q.classifyStatus === "classifying") && (
            <span className="text-xs text-ink/40">Waiting for AI classification…</span>
          )}
      </div>

      {/* Results */}
      {queue.some((q) => q.status === "done") && (
        <div className="mt-10 border-t border-line pt-6">
          <h2 className="font-display text-lg italic text-ink">Uploaded</h2>
          <ul className="mt-3 space-y-2">
            {queue
              .filter((q) => q.status === "done" && q.result)
              .map((q) => (
                <li
                  key={q.id}
                  className="flex items-center justify-between gap-3 rounded-sm border border-line bg-card px-3 py-2 text-sm"
                >
                  <span className="truncate font-mono text-xs text-ink/60">
                    {q.result!.name}
                  </span>
                  <a
                    href={q.result!.web_view_link}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-blueprint-600 hover:underline"
                  >
                    View in Drive
                  </a>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
