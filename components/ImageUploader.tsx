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
  PublishPermission,
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
  if (isPdfFile(file)) {
    return file;
  }
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

// Accept images, videos, and PDFs by MIME type or (folder drops sometimes report no
// type) by file extension.
function isMediaFile(f: File) {
  return (
    f.type.startsWith("image/") ||
    f.type.startsWith("video/") ||
    f.type === "application/pdf" ||
    /\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|m4v|webm|avi|mkv|pdf)$/i.test(f.name)
  );
}

function isPdfFile(f: { type?: string; name?: string }) {
  return (
    f.type === "application/pdf" ||
    /\.pdf$/i.test(f.name || "")
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

// One queued image: preview, status, its publishing permission, and its OWN tags.
function QueueCard({
  q,
  isUploading,
  onRemove,
  onTagsChange,
  onPermissionChange,
}: {
  q: QueuedFile;
  isUploading: boolean;
  onRemove: (id: string) => void;
  onTagsChange: (id: string, tags: string[]) => void;
  onPermissionChange: (id: string, perm: PublishPermission) => void;
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
    <div className="flex gap-4 rounded border border-border bg-surface p-4">
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded bg-bg">
        {isVideoFile(q.file) ? (
          <video
            src={q.previewUrl}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : isPdfFile(q.file) ? (
          <div className="flex h-full w-full select-none flex-col items-center justify-center bg-bg p-2 text-muted">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="mb-1 h-4 w-4"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span className="text-xs font-medium">PDF</span>
          </div>
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
          <span className="absolute left-1 top-1 rounded bg-text/70 px-1 text-xs font-medium text-surface">
            Video
          </span>
        )}
        {isPdfFile(q.file) && (
          <span className="absolute left-1 top-1 rounded bg-text/70 px-1 text-xs font-medium text-surface">
            PDF
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-text">
            {q.file.name}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {q.status === "done" && (
              <span className="badge-status">Uploaded</span>
            )}
            {q.status === "error" && (
              <span className="badge-status border-danger/25 bg-danger/5 text-danger">
                Failed
              </span>
            )}
            {q.classifyStatus === "classifying" && (
              <span className="text-xs font-medium text-accent">
                Classifying
              </span>
            )}
            {q.classifyStatus === "done" && (
              <span className="text-xs font-medium text-muted">
                Tags suggested
              </span>
            )}
            {q.classifyStatus === "error" && (
              <span className="text-xs font-medium text-muted">
                Suggestions unavailable, tag manually
              </span>
            )}
            {!isUploading && q.status === "queued" && (
              <button
                type="button"
                onClick={() => onRemove(q.id)}
                aria-label={`Remove ${q.file.name}`}
                className="inline-flex items-center rounded border border-border px-2 py-1 text-xs font-medium text-danger transition-colors hover:border-danger"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {q.relativePath && (
          <p className="mt-1 truncate text-xs text-muted">
            {q.relativePath}/
          </p>
        )}

        {/* Per-image Publishing Permission Selector */}
        {q.status !== "done" && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Publishing</span>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                disabled={isUploading}
                onClick={() => onPermissionChange(q.id, "granted")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  q.publishPermission === "granted"
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
                title="Permission granted — approved for external marketing and publishing"
              >
                Granted
              </button>
              <button
                type="button"
                disabled={isUploading}
                onClick={() => onPermissionChange(q.id, "pending")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  q.publishPermission === "pending"
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
                title="Pending permission — awaiting client release or confirmation"
              >
                Pending
              </button>
              <button
                type="button"
                disabled={isUploading}
                onClick={() => onPermissionChange(q.id, "restricted")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  q.publishPermission === "restricted"
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
                title="Internal only — confidential, do not publish"
              >
                Internal only
              </button>
            </div>
          </div>
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
              className="mt-2 inline-flex items-center rounded px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
            >
              {showPresets ? "Hide presets" : "Add from presets"}
            </button>
            {showPresets && (
              <div className="mt-2 max-h-56 overflow-y-auto rounded border border-border bg-bg p-2">
                {!groups ? (
                  <p className="text-xs text-muted">Loading presets</p>
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
          <p className="mt-2 text-xs text-danger">
            Upload failed: {q.error}
          </p>
        )}
      </div>
    </div>
  );
}

export interface ImageUploaderProps {
  initialFolderPath?: string;
  initialFolder?: DriveFolder | null;
  initialFiles?: File[] | null;
  onUploadComplete?: () => void;
  onClose?: () => void;
  isModal?: boolean;
}

export default function ImageUploader({
  initialFolderPath,
  initialFolder,
  initialFiles,
  onUploadComplete,
  onClose,
  isModal = false,
}: ImageUploaderProps = {}) {
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [folder, setFolder] = useState<DriveFolder | null>(initialFolder ?? null);
  const [batchPermission, setBatchPermission] = useState<PublishPermission>("granted");
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchState, setBatchState] = useState<BatchState>("idle");
  const [progress, setProgress] = useState(0);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ fileName: string; error: string }[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Auto-resolve folder when initialFolderPath or initialFolder is provided
  useEffect(() => {
    if (initialFolder) {
      setFolder(initialFolder);
    } else if (initialFolderPath) {
      fetch(`/api/folders/resolve?path=${encodeURIComponent(initialFolderPath)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.folder) {
            setFolder(data.folder);
          }
        })
        .catch(() => undefined);
    }
  }, [initialFolderPath, initialFolder]);

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
      const isPdf = isPdfFile(file);
      const form = new FormData();
      form.append("image", blob, isPdf ? (file.name || "document.pdf") : "image.jpg");
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
        publishPermission: batchPermission,
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
    [classifyFile, batchPermission]
  );

  // If initialFiles were provided (e.g. from drag & drop directly onto /browse grid), queue them
  const initialFilesHandled = useRef(false);
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0 && !initialFilesHandled.current) {
      initialFilesHandled.current = true;
      addFiles(initialFiles.map((file) => ({ file, relativePath: "" })));
    }
  }, [initialFiles, addFiles]);

  // Replace one queued image's own tag list (edited on its card).
  const setFileTags = (id: string, next: string[]) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === id ? { ...q, tags: next } : q))
    );
  };

  // Replace one queued image's publishing permission.
  const setFilePermission = (id: string, perm: PublishPermission) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === id ? { ...q, publishPermission: perm } : q))
    );
  };

  // Change batch default permission and cascade to currently queued files.
  const handleBatchPermissionChange = (perm: PublishPermission) => {
    setBatchPermission(perm);
    setQueue((prev) =>
      prev.map((q) => ({ ...q, publishPermission: perm }))
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
    if (onUploadComplete) {
      onUploadComplete();
    }
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
        mimeType:
          q.file.type ||
          (isPdfFile(q.file) ? "application/pdf" : "application/octet-stream"),
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
        publishPermission: q.publishPermission,
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
      if (onUploadComplete) {
        onUploadComplete();
      }
    }
  };

  const isUploading = batchState === "uploading";
  const pendingCount = queue.filter((q) => q.status !== "done").length;

  const content = (
    <div className={isModal ? "p-6" : "px-8 pt-8 pb-12"}>
      {/* Header */}
      {!isModal ? (
        <header className="mb-6 flex items-start justify-between border-b border-border pb-4">
          <div>
            <h1 className="text-lg font-medium text-text">Upload</h1>
            <p className="mt-1 text-sm text-muted">
              Files land in Google Drive. Images are tagged automatically;
              videos and PDFs are tagged manually.
            </p>
          </div>
        </header>
      ) : (
        <header className="mb-6 flex items-start justify-between border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-5 w-5 text-muted"
              >
                <path
                  d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15"
                  strokeLinecap="round"
                />
              </svg>
              <h2 className="text-lg font-medium text-text">
                Upload to {folder?.name || (initialFolderPath ? initialFolderPath.split("/").pop() : "Folder")}
              </h2>
            </div>
            {folder?.path && (
              <p className="mt-1 text-sm text-muted">
                Destination: <span className="font-medium text-text">{folder.path}</span>
              </p>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
              title="Close"
              aria-label="Close"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-4 w-4"
              >
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </header>
      )}

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded border border-dashed px-6 py-12 text-center transition-colors ${
          isDragOver
            ? "border-accent bg-accent/5"
            : "border-border bg-surface hover:border-accent"
        }`}
      >
        <p className="text-base font-medium text-text">
          Drag images, videos or PDFs here, or click to browse
        </p>
        <p className="mt-1 max-w-md text-sm text-muted">
          JPG, PNG, WEBP, GIF, HEIC, PDF, MP4, MOV and WEBM — single files or
          entire folders, with subfolders recreated in Drive.
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            folderInputRef.current?.click();
          }}
          className="mt-4 inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
        >
          Select a folder
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,application/pdf,.pdf"
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
        <div className="mt-6 space-y-4">
          {queue.map((q) => (
            <QueueCard
              key={q.id}
              q={q}
              isUploading={isUploading}
              onRemove={removeFile}
              onTagsChange={setFileTags}
              onPermissionChange={setFilePermission}
            />
          ))}
          <p className="text-xs text-muted">
            {queue.length} file{queue.length === 1 ? "" : "s"} queued
          </p>
        </div>
      )}

      {/* Batch publishing permission, tags + folder */}
      <div className="mt-8 space-y-6">
        {/* Publishing Permission Settings */}
        <div className="rounded border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-text">
                  Publishing permission
                </label>
                <span className="badge-status">Required</span>
              </div>
              <p className="mt-1 max-w-lg text-sm text-muted">
                Confirm whether dwp has client and photographer clearance to
                publish this batch externally, for marketing, social media, PR
                and the website.
              </p>
            </div>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                disabled={isUploading}
                onClick={() => handleBatchPermissionChange("granted")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  batchPermission === "granted"
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
                title="Permission granted — approved for marketing, website, PR and external publishing"
              >
                Permission granted
              </button>
              <button
                type="button"
                disabled={isUploading}
                onClick={() => handleBatchPermissionChange("pending")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  batchPermission === "pending"
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
                title="Pending permission — awaiting client or photographer release"
              >
                Pending clearance
              </button>
              <button
                type="button"
                disabled={isUploading}
                onClick={() => handleBatchPermissionChange("restricted")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  batchPermission === "restricted"
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
                title="Internal only — confidential or restricted from external publishing"
              >
                Internal only
              </button>
            </div>
          </div>
        </div>

        <div>
          <TagInput
            tags={tags}
            onChange={setTags}
            label="Batch tags"
            hint="Press Enter or comma to add. Applied to every image in this batch, on top of each image's own tags above."
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
          <div className="h-1 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-accent transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-muted">Uploading {progress}%</p>
        </div>
      )}

      {batchError && (
        <p className="mt-4 rounded border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
          {batchError}
        </p>
      )}

      {batchState === "done" && failures.length > 0 && (
        <div className="mt-4 rounded border border-accent/25 bg-accent/5 px-3 py-2 text-sm text-text">
          {queue.filter((q) => q.status === "done").length} of {queue.length}{" "}
          uploaded to <span className="font-medium">{folder?.path}</span>.
          {` ${failures.length} failed.`}
        </div>
      )}

      {/* Success dialog */}
      {batchState === "done" && failures.length === 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text/40 px-6"
          role="dialog"
          aria-modal="true"
          aria-label="Upload completed"
          onClick={() => {
            reset();
            if (isModal && onClose) onClose();
          }}
        >
          <div
            className="w-full max-w-sm rounded border border-border bg-surface p-4 text-center shadow-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="mx-auto h-4 w-4 text-accent"
            >
              <path
                d="m5 13 4 4 10-10"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <h2 className="mt-3 text-lg font-medium text-text">
              Upload completed
            </h2>
            <p className="mt-1 text-sm text-muted">
              {queue.filter((q) => q.status === "done").length} file
              {queue.filter((q) => q.status === "done").length === 1 ? "" : "s"}{" "}
              uploaded to <span className="font-medium text-text">{folder?.path}</span>.
            </p>
            <button
              type="button"
              autoFocus
              onClick={() => {
                reset();
                if (isModal && onClose) onClose();
              }}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleUpload}
          disabled={
            !pendingCount ||
            isUploading ||
            !folder ||
            queue.some((q) => q.classifyStatus === "classifying")
          }
          className="btn-primary-dark"
        >
          {isUploading
            ? "Uploading to Drive"
            : `Upload ${pendingCount || ""} file${pendingCount === 1 ? "" : "s"}`}
        </button>
        {(queue.length > 0 || batchState === "done") && !isUploading && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
          >
            Clear
          </button>
        )}
        {!folder && queue.length > 0 && (
          <span className="text-sm text-muted">
            Select a destination folder in Google Drive to continue
          </span>
        )}
        {folder &&
          !isUploading &&
          queue.some((q) => q.classifyStatus === "classifying") && (
            <span className="text-sm font-medium text-accent">
              Waiting for classification
            </span>
          )}
      </div>

      {/* Results */}
      {queue.some((q) => q.status === "done") && (
        <div className="mt-8 border-t border-border pt-6">
          <h2 className="text-base font-medium text-text">Uploaded</h2>
          <ul className="mt-3 space-y-2">
            {queue
              .filter((q) => q.status === "done" && q.result)
              .map((q) => (
                <li
                  key={q.id}
                  className="flex items-center justify-between gap-3 rounded border border-border bg-surface px-3 py-2 text-sm"
                >
                  <span className="truncate text-sm text-text">
                    {q.result!.name}
                  </span>
                  <a
                    href={q.result!.web_view_link}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-sm font-medium text-accent hover:underline"
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

  if (isModal) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-text/40 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Direct folder upload"
        onClick={onClose}
      >
        <div
          className="relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded border border-border bg-surface shadow-menu"
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      </div>
    );
  }

  return content;
}
