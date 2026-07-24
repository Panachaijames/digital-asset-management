"use client";

import { useState, useEffect, useRef } from "react";
import FolderPicker from "@/components/FolderPicker";
import type { DriveFolder } from "@/lib/types";

// Import → register files that are ALREADY in Google Drive (e.g. bulk-synced
// with Drive for desktop during the Filecamp migration) as DAM assets.
// Nothing is moved or uploaded — a scan finds image/video files under a
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

  const [autoTagStats, setAutoTagStats] = useState<{
    total: number;
    totalImages: number;
    untaggedCount: number;
  } | null>(null);
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagProgress, setAutoTagProgress] = useState({
    done: 0,
    total: 0,
    tagged: 0,
    failed: 0,
  });
  const [autoTagError, setAutoTagError] = useState("");
  const [autoTagFailures, setAutoTagFailures] = useState<
    { id: string; name: string; error: string }[]
  >([]);
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

  // Fetch untagged asset stats whenever folder selection changes
  const fetchStats = async (folderPath = folder?.path || "") => {
    try {
      const url = folderPath
        ? `/api/autotag?folderPath=${encodeURIComponent(folderPath)}`
        : "/api/autotag";
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) setAutoTagStats(data);
    } catch {
      // Ignore background stats fetch errors
    }
  };

  useEffect(() => {
    void fetchStats();
  }, [folder]);

  const pickFolder = (f: DriveFolder | null) => {
    runRef.current++; // abandon any in-flight scan/import/auto-tag loop
    setFolder(f);
    setScan(null);
    setScanning(false);
    setImporting(false);
    setAutoTagging(false);
    setOutcome(null);
    setError("");
    setAutoTagError("");
    setAutoTagFailures([]);
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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // One auto-tag batch, retried STUBBORNLY. Cloud Logging showed runs dying
  // with the server perfectly healthy: the browser's next POST simply never
  // arrived (laptop wifi/VPN blip mid-marathon), and a ~10 s retry window
  // couldn't ride it out. Network-level failures now retry for up to 15
  // minutes with a visible countdown-ish status; server errors get a few
  // bounded retries; AI-disabled (no API key) is fatal immediately. The ID
  // queue makes retries safe — anything the server already tagged is skipped.
  const postAutoTagBatch = async (body: {
    assetIds: string[];
    limit: number;
    folderPath: string;
  }): Promise<{
    processed: number;
    tagged: number;
    failed: number;
    results: { id: string; name?: string; status?: string; error?: string }[];
  }> => {
    const startedAt = Date.now();
    const RETRY_WINDOW_MS = 15 * 60 * 1000;
    const MAX_SERVER_ERRORS = 5;
    let serverErrors = 0;

    for (let attempt = 1; ; attempt++) {
      let failure: { message: string; server: boolean };
      try {
        const res = await fetch("/api/autotag", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          if (attempt > 1) setAutoTagError(""); // clear the "retrying…" status
          return data;
        }
        if (data.disabled) {
          throw Object.assign(
            new Error(data.error || "Gemini API key is not configured."),
            { fatal: true }
          );
        }
        failure = {
          message: data.error || `Auto-tagging batch failed (HTTP ${res.status}).`,
          server: true,
        };
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal) throw e;
        failure = {
          message: e instanceof Error ? e.message : "Auto-tagging batch failed.",
          server: false,
        };
      }

      if (failure.server && ++serverErrors >= MAX_SERVER_ERRORS) {
        throw new Error(failure.message);
      }
      if (Date.now() - startedAt > RETRY_WINDOW_MS) {
        throw new Error(failure.message);
      }
      setAutoTagError(
        `${failure.server ? "Server hiccup" : "Connection lost"} — retrying automatically (attempt ${attempt})… tagging resumes by itself, nothing is lost.`
      );
      await sleep(Math.min(30_000, 3_000 * attempt));
    }
  };

  const runAutoTag = async (targetPath = folder?.path || "") => {
    const runId = ++runRef.current;
    setAutoTagging(true);
    setAutoTagError("");
    setAutoTagFailures([]);

    try {
      // Snapshot the untagged asset IDs once, then work through them in small
      // batches — no re-deriving "what's untagged" per batch, and a retried
      // or partially-processed batch resumes exactly where it stopped.
      const statsUrl = targetPath
        ? `/api/autotag?folderPath=${encodeURIComponent(targetPath)}&includeIds=1`
        : "/api/autotag?includeIds=1";
      let statsData: {
        error?: string;
        total?: number;
        totalImages?: number;
        untaggedCount?: number;
        untaggedIds?: string[];
      } = {};
      for (let attempt = 1; ; attempt++) {
        try {
          const statsRes = await fetch(statsUrl);
          statsData = await statsRes.json();
          if (!statsRes.ok) {
            throw new Error(
              statsData.error || "Could not fetch untagged assets."
            );
          }
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await sleep(2_000 * attempt);
        }
      }

      let queue: string[] = Array.isArray(statsData.untaggedIds)
        ? statsData.untaggedIds
        : [];
      const initialTotal = queue.length;

      if (initialTotal === 0) {
        setAutoTagStats({
          total: statsData.total || 0,
          totalImages: statsData.totalImages || 0,
          untaggedCount: statsData.untaggedCount || 0,
        });
        return;
      }

      setAutoTagProgress({ done: 0, total: initialTotal, tagged: 0, failed: 0 });

      let done = 0;
      let totalTagged = 0;
      let totalFailed = 0;

      while (queue.length > 0) {
        if (runRef.current !== runId) return;
        const batchIds = queue.slice(0, 20);
        const data = await postAutoTagBatch({
          assetIds: batchIds,
          limit: batchIds.length,
          folderPath: targetPath,
        });
        if (runRef.current !== runId) return;

        const results = Array.isArray(data.results) ? data.results : [];
        const processedIds = new Set(results.map((r) => r.id));

        if (processedIds.size === 0) {
          // Nothing in this batch needed tagging (e.g. tagged since the
          // snapshot) — drop it so the loop always makes progress.
          queue = queue.slice(batchIds.length);
          done += batchIds.length;
        } else {
          // The server may stop mid-batch on its time budget — only IDs it
          // reported leave the queue; the rest go into the next batch.
          queue = queue.filter((id) => !processedIds.has(id));
          done += processedIds.size;
        }

        totalTagged += data.tagged || 0;
        totalFailed += data.failed || 0;

        const newFailures = results
          .filter((r) => r.status === "failed")
          .map((r) => ({
            id: r.id,
            name: r.name || "Unnamed Asset",
            error: r.error || "Classification failed",
          }));
        if (newFailures.length > 0) {
          setAutoTagFailures((prev) => [...prev, ...newFailures]);
        }

        setAutoTagProgress({
          done: Math.min(done, initialTotal),
          total: initialTotal,
          tagged: totalTagged,
          failed: totalFailed,
        });
      }

      if (totalFailed > 0) {
        setAutoTagError(
          `${totalTagged} image${totalTagged === 1 ? "" : "s"} tagged. ${totalFailed} could not be classified and were skipped.`
        );
      }

      await fetchStats(targetPath);
    } catch (e) {
      if (runRef.current !== runId) return;
      const msg = e instanceof Error ? e.message : "Auto-tagging failed.";
      // Every tag is written per image, so a dead run loses nothing — make
      // sure the user knows one click picks up exactly where it stopped.
      setAutoTagError(
        `${msg} Progress is saved per image — click the Auto-Tag button to resume where it left off.`
      );
      void fetchStats(targetPath); // refresh the button's remaining count
    } finally {
      if (runRef.current === runId) setAutoTagging(false);
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
      void runAutoTag(folder.path);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl italic text-ink">
          Import from Drive
        </h1>
        <p className="mt-1.5 text-sm text-ink/60">
          Registers images and videos that are <em>already</em> in Google
          Drive (for example bulk-copied with Drive for desktop) so they
          appear in the DAM. Nothing is moved or re-uploaded. Folder names map
          to taxonomy tags, and you can run AI auto-tagging on untagged images below.
        </p>
      </header>

      <FolderPicker selected={folder} onSelect={pickFolder} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={!folder || scanning || importing || autoTagging}
            className="rounded-sm bg-blueprint-600 px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {scanning ? "Scanning…" : "Scan folder"}
          </button>
          {!folder && (
            <span className="text-xs text-ink/40">
              Select the folder to scan first
            </span>
          )}
          {scanning && (
            <span className="text-xs text-ink/40">
              {scan
                ? `Walking the tree… ${scan.foldersScanned} folders scanned · ${scan.foldersPending} queued · ${scan.candidatesTotal} files to import found`
                : "Walking the folder tree…"}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink/70">
            <input
              type="checkbox"
              checked={autoLoopImport}
              onChange={(e) => setAutoLoopImport(e.target.checked)}
              className="rounded-sm border-line text-blueprint-600 focus:ring-blueprint-500"
            />
            Auto-loop import until complete
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink/70">
            <input
              type="checkbox"
              checked={autoTagAfterImport}
              onChange={(e) => setAutoTagAfterImport(e.target.checked)}
              className="rounded-sm border-line text-blueprint-600 focus:ring-blueprint-500"
            />
            Automatically run AI auto-tagging
          </label>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-sm bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      {/* Scan summary */}
      {scan && (
        <div className="mt-6 rounded-sm border border-line bg-panel/60 p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-blueprint-400">
            Scan result
          </p>
          <p className="mt-2 text-sm text-ink/80">
            {scan.total} media file{scan.total === 1 ? "" : "s"} seen
            {scan.cursor ? " so far" : ""} under{" "}
            <span className="font-mono text-xs">{folder?.path}</span> —{" "}
            {scan.registered} already in the DAM,{" "}
            <strong className="text-ink">
              {scan.candidatesTotal} to import
            </strong>
            .
          </p>
          {scan.cursor && (
            <p className="mt-1.5 text-xs text-ink/50">
              Big folder — {scan.foldersScanned} folders walked,{" "}
              {scan.foldersPending} still queued (nested folders included).{" "}
              {autoLoopImport
                ? "Import All keeps scanning deeper and importing until everything is done."
                : `This batch holds ${scan.candidates.length} files.`}
            </p>
          )}
          {(scan.candidatesTotal > 0 || scan.cursor) && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runImport(true)}
                disabled={importing || scanning || autoTagging}
                className="rounded-sm bg-blueprint-600 px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {importing
                  ? "Importing in loop…"
                  : `Import All ${scan.candidatesTotal}${scan.cursor ? "+" : ""} Files (Auto-Loop)`}
              </button>

              {scan.cursor && scan.candidates.length > 0 && (
                <button
                  type="button"
                  onClick={() => void runImport(false)}
                  disabled={importing || scanning || autoTagging}
                  className="rounded-sm border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink/80 transition-colors hover:bg-panel disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Import Batch ({scan.candidates.length} files)
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Import Progress */}
      {importing && (
        <div className="mt-6">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              className={`h-full bg-blueprint-600 transition-all duration-150 ${
                progress.roundTotal === 0 ? "animate-pulse" : ""
              }`}
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
          <p className="mt-1.5 text-xs text-ink/40">
            {progress.roundTotal > 0
              ? `Registering batch… ${progress.roundDone} / ${progress.roundTotal}`
              : "Scanning deeper for the next batch…"}
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
        <div className="mt-6 rounded-sm bg-blueprint-50 px-4 py-3 text-sm text-blueprint-700">
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
                className="underline hover:opacity-80"
              >
                continue scanning
              </button>{" "}
              to pick up exactly where it stopped.
            </p>
          )}
        </div>
      )}

      {outcome && outcome.failures.length > 0 && (
        <div className="mt-4 rounded-sm border border-line bg-card p-3">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink/40">
            Failures (first {Math.min(outcome.failures.length, 20)})
          </p>
          <ul className="space-y-1">
            {outcome.failures.slice(0, 20).map((f) => (
              <li key={f.id} className="text-xs text-red-400">
                <span className="font-mono">{f.name}</span> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* AI Auto-Tagging Section */}
      <div className="mt-10 rounded-sm border border-line/80 bg-panel p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium text-ink">
              AI Auto-Tag Untagged Assets
            </h2>
            <p className="mt-0.5 text-xs text-ink/60">
              Scans imported images in <span className="font-mono text-xs">{folder?.path || "dwp.dam"}</span> that have no tags or sector taxonomy, downloads them from Google Drive, and classifies them using Gemini Vision AI.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runAutoTag(folder?.path || "")}
            disabled={
              autoTagging ||
              importing ||
              scanning ||
              (autoTagStats !== null && autoTagStats.untaggedCount === 0)
            }
            className="rounded-sm bg-blueprint-600 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30 shrink-0 ml-4"
          >
            {autoTagging
              ? "Auto-Tagging…"
              : `Auto-Tag ${
                  autoTagStats?.untaggedCount
                    ? `${autoTagStats.untaggedCount} Image${autoTagStats.untaggedCount === 1 ? "" : "s"}`
                    : "Untagged Images"
                }`}
          </button>
        </div>

        {autoTagStats !== null && (
          <div className="mt-3 text-xs text-ink/60">
            {autoTagStats.untaggedCount === 0 ? (
              <span className="text-emerald-600 font-medium">
                ✓ All {autoTagStats.totalImages} images in this scope have tags & taxonomy.
              </span>
            ) : (
              <span>
                Found <strong className="text-ink">{autoTagStats.untaggedCount}</strong> untagged image{autoTagStats.untaggedCount === 1 ? "" : "s"} out of {autoTagStats.totalImages} image assets in {folder?.path ? "this folder" : "dwp.dam"}.
                {autoTagStats.totalImages > autoTagStats.untaggedCount && (
                  <span className="text-emerald-500 font-medium ml-1.5">
                    ({autoTagStats.totalImages - autoTagStats.untaggedCount} already tagged)
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        {autoTagError && (
          <p className="mt-3 rounded-sm bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {autoTagError}
          </p>
        )}

        {/* Auto-Tagging Progress */}
        {autoTagging && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-blueprint-600 transition-all duration-200"
                style={{
                  width: `${
                    autoTagProgress.total > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (autoTagProgress.done / autoTagProgress.total) * 100
                          )
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-ink/50 font-mono">
              <span>
                Processing with Gemini Vision… {autoTagProgress.done} / {autoTagProgress.total}
              </span>
              <span>
                {autoTagProgress.tagged} tagged, {autoTagProgress.failed} failed
              </span>
            </div>
          </div>
        )}

        {/* Auto-Tagging Failures List */}
        {autoTagFailures.length > 0 && (
          <div className="mt-4 rounded-sm border border-line bg-card p-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink/40">
              Auto-Tagging Failures ({autoTagFailures.length})
            </p>
            <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {autoTagFailures.map((f, i) => (
                <li
                  key={`${f.id}-${i}`}
                  className="text-xs text-red-400 flex flex-col sm:flex-row sm:items-baseline sm:gap-2"
                >
                  <span className="font-mono font-medium shrink-0">
                    {f.name}
                  </span>
                  <span className="text-ink/60 truncate">— {f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
