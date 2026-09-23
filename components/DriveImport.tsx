"use client";

import { useState, useEffect, useRef } from "react";
import FolderPicker from "@/components/FolderPicker";
import type { DriveFolder } from "@/lib/types";

// Import → register files that are ALREADY in Google Drive (e.g. bulk-synced
// with Drive for desktop during the Filecamp migration) as DAM assets.
// Nothing is moved or uploaded — a scan finds image/video/PDF files under a
// folder with no metadata row yet, and importing writes those rows in
// batches.

interface Candidate {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  thumbnailLink: string | null;
  folderId: string;
  relativePath: string;
}

// Opaque scan-resume cursor (the server's BFS frontier) — echoed back as-is.
interface ScanCursor {
  queue: { id: string; p: string }[];
}

// One /api/import/scan response. Counts cover that round only; the walk is
// chunked server-side so one request never has to visit the whole tree.
interface ScanRound {
  total: number;
  registered: number;
  candidates: Candidate[];
  candidatesTotal: number;
  truncated: boolean;
  nextCursor: ScanCursor | null;
  foldersScanned: number;
  foldersPending: number;
}

// Accumulated walk state across rounds. `cursor` null = the whole tree has
// been visited; `candidates` holds files found but not yet imported.
interface ScanState {
  total: number;
  registered: number;
  candidates: Candidate[];
  candidatesTotal: number;
  foldersScanned: number;
  foldersPending: number;
  cursor: ScanCursor | null;
}

interface ImportOutcome {
  imported: number;
  skipped: number;
  failures: { id: string; name: string; error: string }[];
  truncatedScan: boolean;
}

interface ImportProgress {
  imported: number;
  skipped: number;
  failed: number;
  roundDone: number;
  roundTotal: number;
  foldersPending: number;
}

const BATCH_SIZE = 100;

const EMPTY_SCAN: ScanState = {
  total: 0,
  registered: 0,
  candidates: [],
  candidatesTotal: 0,
  foldersScanned: 0,
  foldersPending: 0,
  cursor: null,
};

const EMPTY_PROGRESS: ImportProgress = {
  imported: 0,
  skipped: 0,
  failed: 0,
  roundDone: 0,
  roundTotal: 0,
  foldersPending: 0,
};

import { useAutoTag, type RecentTaggedAsset } from "@/components/AutoTagContext";
export type { RecentTaggedAsset };

export default function DriveImport() {
  const [folder, setFolder] = useState<DriveFolder | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>(EMPTY_PROGRESS);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState("");
  // Bumped when a new run starts or the folder changes, so an in-flight
  // scan/import loop from a previous selection stops touching state.
  const runRef = useRef(0);

  const {
    job: autoTagJob,
    isRunning: autoTagging,
    isPaused: autoTagPaused,
    stats: autoTagStats,
    fetchStats,
    startAutoTag,
    pauseAutoTag,
    resumeAutoTag,
    resetAutoTag,
  } = useAutoTag();

  const [autoLoopImport, setAutoLoopImport] = useState(true);
  const [autoTagAfterImport, setAutoTagAfterImport] = useState(true);

  // Keep the screen awake while a long scan/import/auto-tag run is going —
  // the machine going to sleep severs the network mid-run, which is exactly
  // how marathon runs were observed to die (the server stayed healthy; the
  // browser's next request simply never arrived). Best-effort: silently does
  // nothing where the Wake Lock API is unavailable or denied, and the lock
  // is re-acquired when the tab becomes visible again.
  const busy = scanning || importing || autoTagging;
  useEffect(() => {
    if (!busy) return;
    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      try {
        if (!stopped && document.visibilityState === "visible") {
          sentinel = (await navigator.wakeLock?.request("screen")) ?? null;
        }
      } catch {
        // Unsupported browser or policy — nothing we can do.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, [busy]);

  useEffect(() => {
    void fetchStats(folder?.path || "");
  }, [folder, fetchStats]);

  const pickFolder = (f: DriveFolder | null) => {
    runRef.current++; // abandon any in-flight scan/import loop
    setFolder(f);
    setScan(null);
    setScanning(false);
    setImporting(false);
    setOutcome(null);
    setError("");
  };

  // One scan round with client-side retries — a single transient hiccup must
  // not kill a long walk (the cursor from the last good round is preserved).
  const scanRound = async (
    target: DriveFolder,
    cursor: ScanCursor | null
  ): Promise<ScanRound> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/import/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            driveId: target.driveId,
            folderId: target.id,
            ...(cursor ? { cursor } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Scan failed.");
        return data as ScanRound;
      } catch (e) {
        lastError = e;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000 + attempt * 4000));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Scan failed.");
  };

  const mergeRound = (acc: ScanState, round: ScanRound): ScanState => ({
    total: acc.total + round.total,
    registered: acc.registered + round.registered,
    candidates: [...acc.candidates, ...round.candidates],
    candidatesTotal: acc.candidatesTotal + round.candidatesTotal,
    foldersScanned: acc.foldersScanned + round.foldersScanned,
    foldersPending: round.foldersPending,
    cursor: round.nextCursor,
  });

  // Walks the tree round by round, going deeper into nested folders each
  // call until something importable turns up (or the walk finishes). Fresh
  // start by default; resume = true continues from the cursor left in `scan`
  // (the "Continue scan" button after a single-batch import).
  const runScan = async (resume = false) => {
    if (!folder) return;
    const runId = ++runRef.current;
    setScanning(true);
    setOutcome(null);
    setError("");
    let acc: ScanState =
      resume && scan
        ? { ...scan, candidates: [...scan.candidates] }
        : EMPTY_SCAN;
    let cursor: ScanCursor | null = resume ? (scan?.cursor ?? null) : null;
    if (!resume) setScan(null);
    try {
      do {
        const round = await scanRound(folder, cursor);
        if (runRef.current !== runId) return;
        cursor = round.nextCursor;
        acc = mergeRound(acc, round);
        setScan(acc);
      } while (cursor && acc.candidates.length === 0);
    } catch (e) {
      if (runRef.current !== runId) return;
      setError(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      if (runRef.current === runId) setScanning(false);
    }
  };



  const runImport = async (overrideLoop?: boolean) => {
    if (!folder || !scan) return;
    if (!scan.candidates.length && !scan.cursor) return;
    const runId = ++runRef.current;
    const shouldLoop =
      overrideLoop !== undefined ? overrideLoop : autoLoopImport;
    setImporting(true);
    setError("");

    let totalImported = 0;
    let totalSkipped = 0;
    const failures: ImportOutcome["failures"] = [];

    let remaining = [...scan.candidates];
    let cursor = scan.cursor;
    setProgress({
      ...EMPTY_PROGRESS,
      roundTotal: remaining.length,
      foldersPending: scan.foldersPending,
    });

    // Decided inside the try, kicked off only after the import has fully
    // settled — runAutoTag starts its own run (bumps runRef), which must not
    // trip this run's stale-guards while they're still unwinding.
    let kickAutoTag = false;

    try {
      // Register-what-we-have, then walk the next stretch of the tree, then
      // register again — repeating until the cursor comes back empty. Each
      // round is one short server request, so deeply nested / huge folders
      // import in bounded steps instead of one giant request that dies.
      while (true) {
        const roundTotal = remaining.length;
        while (remaining.length > 0) {
          const batch = remaining.slice(0, BATCH_SIZE);
          const res = await fetch("/api/import/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ folderPath: folder.path, items: batch }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Import failed.");
          if (runRef.current !== runId) return;

          totalImported += data.imported ?? 0;
          totalSkipped += data.skipped ?? 0;
          if (Array.isArray(data.failures)) failures.push(...data.failures);
          remaining = remaining.slice(batch.length);

          setProgress((p) => ({
            ...p,
            imported: totalImported,
            skipped: totalSkipped,
            failed: failures.length,
            roundDone: roundTotal - remaining.length,
            roundTotal,
          }));
          // Mirror the not-yet-imported remainder (and cursor) into state, so
          // a failure at any point leaves a resumable scan card — clicking
          // Import All again picks up right here.
          setScan((s) => (s ? { ...s, candidates: remaining, cursor } : s));
        }

        if (!shouldLoop || !cursor) break;
        const round = await scanRound(folder, cursor);
        if (runRef.current !== runId) return;
        cursor = round.nextCursor;
        remaining = round.candidates;
        setScan((s) => (s ? mergeRound(s, round) : s));
        setProgress((p) => ({
          ...p,
          roundDone: 0,
          roundTotal: remaining.length,
          foldersPending: round.foldersPending,
        }));
        if (!cursor && remaining.length === 0) break;
      }

      if (runRef.current !== runId) return;
      setOutcome({
        imported: totalImported,
        skipped: totalSkipped,
        failures,
        truncatedScan: Boolean(cursor) && !shouldLoop,
      });
      if (cursor && !shouldLoop) {
        // Single-batch mode with more tree left — keep the cursor so
        // "Continue scan" picks up where this batch stopped.
        setScan((s) => (s ? { ...s, candidates: [], cursor } : s));
      } else {
        setScan(null);
      }
      await fetchStats(folder.path);

      kickAutoTag = autoTagAfterImport && totalImported > 0;
    } catch (e) {
      if (runRef.current !== runId) return;
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      if (runRef.current === runId) setImporting(false);
    }

    if (kickAutoTag && runRef.current === runId) {
      void startAutoTag({
        folderPath: folder.path,
        reTagAll: false,
        folderName: folder.path,
      });
    }
  };

  return (
    <div className="px-8 py-8 pb-12">
      {/* Header — title, description, no extra chrome (§5.5) */}
      <div className="mb-6 flex items-start justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-medium text-text">Import</h1>
          <p className="mt-1 text-sm text-muted">
            Registers images and videos already in Google Drive so they
            appear in the DAM, without moving or re-uploading them.
          </p>
        </div>
      </div>

      <FolderPicker selected={folder} onSelect={pickFolder} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={!folder || scanning || importing || autoTagging}
            className="btn-primary-dark"
          >
            {scanning ? "Scanning" : "Scan folder"}
          </button>
          {!folder && (
            <span className="text-sm text-muted">
              Select the folder to scan first
            </span>
          )}
          {scanning && (
            <span className="text-sm text-muted">
              {scan
                ? `Walking the tree — ${scan.foldersScanned} folders scanned · ${scan.foldersPending} queued · ${scan.candidatesTotal} files to import found`
                : "Walking the folder tree"}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={autoLoopImport}
              onChange={(e) => setAutoLoopImport(e.target.checked)}
              className="accent-accent"
            />
            Auto-loop import until complete
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={autoTagAfterImport}
              onChange={(e) => setAutoTagAfterImport(e.target.checked)}
              className="accent-accent"
            />
            Run auto-tagging after import
          </label>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {/* Scan summary */}
      {scan && (
        <div className="mt-6 rounded border border-border bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-text">Scan result</h2>
          <p className="text-sm text-text">
            {scan.total} media file{scan.total === 1 ? "" : "s"} seen
            {scan.cursor ? " so far" : ""} under{" "}
            <span className="text-muted">{folder?.path}</span> —{" "}
            {scan.registered} already in the DAM,{" "}
            <strong className="text-text">
              {scan.candidatesTotal} to import
            </strong>
            .
          </p>
          {scan.cursor && (
            <p className="mt-2 text-sm text-muted">
              Big folder — {scan.foldersScanned} folders walked,{" "}
              {scan.foldersPending} still queued (nested folders included).{" "}
              {autoLoopImport
                ? "Import all keeps scanning deeper and importing until everything is done."
                : `This batch holds ${scan.candidates.length} files.`}
            </p>
          )}
          {(scan.candidatesTotal > 0 || scan.cursor) && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runImport(true)}
                disabled={importing || scanning || autoTagging}
                className="inline-flex items-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                {importing
                  ? "Importing"
                  : `Import all ${scan.candidatesTotal}${scan.cursor ? "+" : ""} files`}
              </button>

              {scan.cursor && scan.candidates.length > 0 && (
                <button
                  type="button"
                  onClick={() => void runImport(false)}
                  disabled={importing || scanning || autoTagging}
                  className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
                >
                  Import batch ({scan.candidates.length} files)
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Import progress */}
      {importing && (
        <div className="mt-6">
          <div className="h-1 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-accent transition-all duration-150"
              style={{
                width: `${
                  progress.roundTotal > 0
                    ? Math.round(
                        (progress.roundDone / progress.roundTotal) * 100
                      )
                    : 100
                }%`,
              }}
            />
          </div>
          <p className="mt-2 text-sm text-muted">
            {progress.roundTotal > 0
              ? `Registering batch — ${progress.roundDone} / ${progress.roundTotal}`
              : "Scanning deeper for the next batch"}
            {" · "}
            {progress.imported} imported
            {progress.skipped > 0 && `, ${progress.skipped} skipped`}
            {progress.failed > 0 && `, ${progress.failed} failed`}
            {progress.foldersPending > 0 &&
              ` · ${progress.foldersPending} folders left to scan`}
          </p>
        </div>
      )}

      {/* Outcome */}
      {outcome && (
        <div className="mt-6 rounded border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-text">
          <p>
            Imported {outcome.imported} file
            {outcome.imported === 1 ? "" : "s"}.
            {outcome.skipped > 0 &&
              ` ${outcome.skipped} skipped (already registered).`}
            {outcome.failures.length > 0 &&
              ` ${outcome.failures.length} failed.`}
          </p>
          {outcome.truncatedScan && (
            <p className="mt-1">
              That was one batch of a large folder —{" "}
              <button
                type="button"
                onClick={() => void runScan(true)}
                className="font-medium text-accent underline hover:opacity-90"
              >
                continue scanning
              </button>{" "}
              to pick up exactly where it stopped.
            </p>
          )}
        </div>
      )}

      {outcome && outcome.failures.length > 0 && (
        <div className="mt-4 rounded border border-border bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-text">
            Failures (first {Math.min(outcome.failures.length, 20)})
          </h2>
          <ul className="space-y-1">
            {outcome.failures.slice(0, 20).map((f) => (
              <li key={f.id} className="text-sm text-danger">
                <span className="font-medium">{f.name}</span> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Auto-tagging */}
      <div className="mt-6 rounded border border-border bg-surface p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-accent/5 text-accent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" strokeLinejoin="round" />
                </svg>
              </span>
              <h2 className="flex items-center gap-2 text-sm font-medium text-text">
                <span>Auto-tagging</span>
                {autoTagging && (
                  <span className="badge-status">Running in background</span>
                )}
                {autoTagPaused && (
                  <span className="badge-status">Paused, progress saved</span>
                )}
              </h2>
            </div>
            <p className="mt-1 text-sm text-muted">
              Scans images in <span className="font-medium text-text">{folder?.path || "the entire DAM Drive"}</span>, analyses them with Gemini Vision, and adds materials, space types and style keywords. Runs in the background and saves progress across pages.
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {autoTagging ? (
              <button
                type="button"
                onClick={() => pauseAutoTag()}
                className="inline-flex items-center gap-2 rounded border border-border bg-transparent px-3 py-2 text-sm font-medium text-danger transition-colors hover:border-danger"
              >
                Stop tagging
              </button>
            ) : autoTagPaused ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => resumeAutoTag()}
                  className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <polygon points="5 3 19 12 5 21 5 3" strokeLinejoin="round" />
                  </svg>
                  <span>
                    Resume tagging ({autoTagJob?.done.toLocaleString()} / {autoTagJob?.total.toLocaleString()})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => resetAutoTag()}
                  title="Discard the saved progress and start a new run"
                  className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                >
                  Reset progress
                </button>
              </div>
            ) : (
              <>
                {/* Re-tag every image already in the drive */}
                <button
                  type="button"
                  onClick={() =>
                    void startAutoTag({
                      folderPath: folder?.path || "",
                      reTagAll: true,
                      folderName: folder?.path || "the entire DAM Drive",
                    })
                  }
                  disabled={importing || scanning || (autoTagStats !== null && autoTagStats.totalImages === 0)}
                  title="Re-tags every image already in the drive with Gemini Vision"
                  className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                    <path d="M16 21h5v-5" />
                  </svg>
                  <span>
                    Re-tag all photos ({autoTagStats?.totalImages ? autoTagStats.totalImages.toLocaleString() : "34,233"})
                  </span>
                </button>

                {/* Tag the untagged only */}
                {Boolean(autoTagStats?.untaggedCount && autoTagStats.untaggedCount > 0) && (
                  <button
                    type="button"
                    onClick={() =>
                      void startAutoTag({
                        folderPath: folder?.path || "",
                        reTagAll: false,
                        folderName: folder?.path || "the entire DAM Drive",
                      })
                    }
                    disabled={importing || scanning}
                    className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
                  >
                    Tag untagged only ({autoTagStats?.untaggedCount?.toLocaleString()})
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {autoTagStats !== null && (
          <div className="mt-3 text-sm text-muted">
            Found <strong className="text-text">{autoTagStats.totalImages.toLocaleString()}</strong> total image assets in {folder?.path ? "this folder" : "dwp.dam"}.
            {autoTagStats.untaggedCount > 0 ? (
              <span className="ml-1 font-medium text-accent">
                ({autoTagStats.untaggedCount.toLocaleString()} untagged, {(autoTagStats.totalImages - autoTagStats.untaggedCount).toLocaleString()} already tagged)
              </span>
            ) : (
              <span className="ml-1 font-medium text-muted">
                (All {autoTagStats.totalImages.toLocaleString()} indexed)
              </span>
            )}
          </div>
        )}

        {autoTagJob?.error && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded border border-border bg-bg px-3 py-2 text-sm text-text">
            <span>{autoTagJob.error}</span>
            {autoTagPaused && (
              <button
                type="button"
                onClick={() => resumeAutoTag()}
                className="shrink-0 text-sm font-medium text-accent underline hover:opacity-90"
              >
                Resume now
              </button>
            )}
          </div>
        )}

        {/* Auto-tagging progress */}
        {autoTagJob && autoTagJob.total > 0 && (autoTagging || autoTagPaused || autoTagJob.status === "completed") && (
          <div className="mt-4">
            <div className="h-1 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{
                  width: `${
                    autoTagJob.total > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (autoTagJob.done / autoTagJob.total) * 100
                          )
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted">
              <span className="flex items-center gap-2 font-medium text-text">
                {autoTagging && (
                  <span className="h-2 w-2 rounded-full bg-accent" />
                )}
                <span>
                  {autoTagJob.done.toLocaleString()} / {autoTagJob.total.toLocaleString()} photos ({autoTagJob.total > 0 ? Math.round((autoTagJob.done / autoTagJob.total) * 100) : 0}%)
                </span>
                <span className="text-xs text-muted">
                  in {autoTagJob.targetName}
                </span>
              </span>
              <span className="text-muted">
                <strong className="text-text">{autoTagJob.tagged.toLocaleString()}</strong> tagged · <strong className="text-danger">{autoTagJob.failed}</strong> failed
              </span>
            </div>
          </div>
        )}

        {/* Currently tagging */}
        {(autoTagging && autoTagJob?.currentlyTagging) && (
          <div className="mt-4 flex items-center gap-3 rounded border border-accent/25 bg-accent/5 p-4">
            {autoTagJob.currentlyTagging.driveFileId ? (
              <img
                src={`/api/thumbnail?id=${autoTagJob.currentlyTagging.driveFileId}&size=320`}
                alt={autoTagJob.currentlyTagging.name || "Tagging photo"}
                className="h-12 w-12 shrink-0 rounded border border-border bg-bg object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = "none";
                }}
              />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-bg text-muted">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                </svg>
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span className="text-xs font-medium text-muted">
                  Tagging with Gemini Vision
                </span>
              </div>
              <p className="mt-1 truncate text-sm font-medium text-text">
                {autoTagJob.currentlyTagging.name || "Processing photo"}
              </p>
              <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted" title={autoTagJob.currentlyTagging.folderPath}>
                <span className="font-medium text-muted">{autoTagJob.currentlyTagging.folderPath || "Root Drive"}</span>
              </p>
            </div>
          </div>
        )}

        {/* Recently tagged */}
        {(autoTagJob?.recentTagged && autoTagJob.recentTagged.length > 0) && (
          <div className="mt-6 rounded border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium text-text">
                <span className={`inline-block h-2 w-2 rounded-full ${autoTagging ? "bg-accent" : "bg-border"}`} />
                Recently tagged ({autoTagJob.recentTagged.length})
              </h3>
              {autoTagging && (
                <span className="text-xs text-muted">
                  Updating live, safe to navigate away or close
                </span>
              )}
            </div>

            <div className="grid max-h-96 grid-cols-1 gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
              {autoTagJob.recentTagged.map((item) => (
                <div
                  key={item.id}
                  className="flex gap-3 rounded border border-border bg-surface p-2 transition-colors hover:border-text"
                >
                  {item.driveFileId ? (
                    <img
                      src={`/api/thumbnail?id=${item.driveFileId}&size=320`}
                      alt={item.name}
                      className="h-12 w-12 shrink-0 rounded border border-border bg-bg object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-bg text-muted">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                      </svg>
                    </div>
                  )}

                  <div className="flex min-w-0 flex-1 flex-col justify-between">
                    <div>
                      <div className="flex items-start justify-between gap-1">
                        <span className="truncate text-sm font-medium text-text" title={item.name}>
                          {item.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted">
                          Tagged
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted" title={item.folderPath}>
                        {item.folderPath || "Root"}
                      </p>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {item.macro && (
                        <span className="badge-status">
                          {item.macro}
                        </span>
                      )}
                      {item.spaceType && (
                        <span className="badge-status">
                          {item.spaceType}
                        </span>
                      )}
                      {(item.tags || []).slice(0, 4).map((t, idx) => (
                        <span
                          key={`${item.id}-tag-${idx}`}
                          className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted"
                        >
                          {t}
                        </span>
                      ))}
                      {(item.tags?.length || 0) > 4 && (
                        <span className="text-xs text-muted">
                          +{(item.tags?.length || 0) - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Auto-tagging failures */}
        {(autoTagJob?.failures && autoTagJob.failures.length > 0) && (
          <div className="mt-4 rounded border border-border bg-surface p-4">
            <h3 className="mb-3 text-sm font-medium text-text">
              Auto-tagging failures ({autoTagJob.failures.length})
            </h3>
            <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {autoTagJob.failures.map((f, i) => (
                <li
                  key={`${f.id}-${i}`}
                  className="flex flex-col text-sm text-danger sm:flex-row sm:items-baseline sm:gap-2"
                >
                  <span className="shrink-0 font-medium">
                    {f.name}
                  </span>
                  <span className="truncate text-muted">— {f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
