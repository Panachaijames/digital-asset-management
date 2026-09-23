"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type AutoTagStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error";

export interface RecentTaggedAsset {
  id: string;
  name: string;
  folderPath?: string;
  driveFileId?: string;
  status: "success" | "failed";
  tags?: string[];
  macro?: string | null;
  core?: string | null;
  spaceType?: string | null;
  error?: string;
  timestamp?: number;
}

export interface CurrentlyTaggingAsset {
  id?: string;
  name?: string;
  folderPath?: string;
  driveFileId?: string;
}

export interface AutoTagFailure {
  id: string;
  name: string;
  error: string;
}

export interface AutoTagStats {
  total: number;
  totalImages: number;
  untaggedCount: number;
}

export interface AutoTagJob {
  id: string;
  status: AutoTagStatus;
  reTagAll: boolean;
  targetPath: string; // "" represents the entire DAM Drive
  targetName: string;
  total: number;
  done: number;
  tagged: number;
  failed: number;
  queue: string[]; // remaining asset IDs to process
  recentTagged: RecentTaggedAsset[];
  currentlyTagging: CurrentlyTaggingAsset | null;
  failures: AutoTagFailure[];
  error: string;
  startedAt: number;
  updatedAt: number;
}

interface AutoTagContextValue {
  job: AutoTagJob | null;
  isRunning: boolean;
  isPaused: boolean;
  stats: AutoTagStats | null;
  fetchStats: (folderPath?: string) => Promise<void>;
  startAutoTag: (options?: {
    folderPath?: string;
    reTagAll?: boolean;
    folderName?: string;
  }) => Promise<void>;
  pauseAutoTag: (userInitiated?: boolean) => void;
  resumeAutoTag: () => void;
  resetAutoTag: () => void;
}

const STORAGE_KEY = "dam_autotag_job_v1";
const BROADCAST_CHANNEL = "dam_autotag_channel";
const BATCH_LIMIT = 20;

const AutoTagContext = createContext<AutoTagContextValue | null>(null);

function loadSavedJob(): AutoTagJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutoTagJob;
    if (parsed && typeof parsed.id === "string") {
      // If was previously running when page was closed/refreshed, mark as paused so user can resume
      if (parsed.status === "running") {
        parsed.status = "paused";
        parsed.error = "Auto-tagging paused when page was closed. Progress has been saved.";
      }
      return parsed;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function persistJob(job: AutoTagJob | null) {
  if (typeof window === "undefined") return;
  try {
    if (!job) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
    }
  } catch {
    // Ignore storage quota or disabled errors
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AutoTagProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<AutoTagJob | null>(null);
  const [stats, setStats] = useState<AutoTagStats | null>(null);

  // References to handle loop cancellation and active control
  const activeRunRef = useRef(0);
  const isLoopRunningRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Synchronize state changes to localStorage and BroadcastChannel
  const updateJob = useCallback((updater: (prev: AutoTagJob | null) => AutoTagJob | null) => {
    setJob((prev) => {
      const next = updater(prev);
      persistJob(next);
      try {
        channelRef.current?.postMessage({ type: "JOB_UPDATED", job: next });
      } catch {
        // Ignore broadcast errors
      }
      return next;
    });
  }, []);

  // Fetch stats for folder or entire drive
  const fetchStats = useCallback(async (folderPath = "") => {
    try {
      const url = folderPath
        ? `/api/autotag?folderPath=${encodeURIComponent(folderPath)}`
        : "/api/autotag";
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) {
        setStats(data);
      }
    } catch {
      // Ignore background stats fetch errors
    }
  }, []);

  // Stubborn single batch execution
  const postBatch = async (
    assetIds: string[],
    folderPath: string,
    reTagAll: boolean,
    runId: number,
    onErrorStatus: (msg: string) => void
  ): Promise<{
    processed: number;
    tagged: number;
    failed: number;
    results: RecentTaggedAsset[];
  }> => {
    const startedAt = Date.now();
    const RETRY_WINDOW_MS = 15 * 60 * 1000;
    const MAX_SERVER_ERRORS = 5;
    let serverErrors = 0;

    for (let attempt = 1; ; attempt++) {
      if (activeRunRef.current !== runId) {
        throw new Error("ABORTED");
      }

      let failure: { message: string; server: boolean };
      try {
        const res = await fetch("/api/autotag", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            assetIds,
            limit: assetIds.length,
            folderPath,
            forceAll: reTagAll,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          onErrorStatus("");
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
        if ((e as Error).message === "ABORTED") throw e;
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

      onErrorStatus(
        `${failure.server ? "Server hiccup" : "Connection lost"} — retrying automatically (attempt ${attempt})… Progress is saved.`
      );
      await sleep(Math.min(30_000, 3_000 * attempt));
    }
  };

  // Main processing worker loop
  const runWorkerLoop = useCallback(async (initialJob: AutoTagJob) => {
    const runId = ++activeRunRef.current;
    isLoopRunningRef.current = true;

    let currentQueue = [...initialJob.queue];
    const totalItems = initialJob.total;
    const targetPath = initialJob.targetPath;
    const reTagAll = initialJob.reTagAll;

    try {
      while (currentQueue.length > 0) {
        if (activeRunRef.current !== runId) {
          return;
        }

        const batchIds = currentQueue.slice(0, BATCH_LIMIT);

        const data = await postBatch(
          batchIds,
          targetPath,
          reTagAll,
          runId,
          (statusMsg) => {
            updateJob((prev) => (prev ? { ...prev, error: statusMsg } : null));
          }
        );

        if (activeRunRef.current !== runId) return;

        const results = Array.isArray(data.results) ? data.results : [];
        const processedIds = new Set(results.map((r) => r.id));

        if (processedIds.size === 0) {
          currentQueue = currentQueue.slice(batchIds.length);
        } else {
          currentQueue = currentQueue.filter((id) => !processedIds.has(id));
        }

        const newTagged = data.tagged || 0;
        const newFailed = data.failed || 0;

        const latestItem = results.length > 0 ? results[results.length - 1] : null;

        const newFailures = results
          .filter((r) => r.status === "failed")
          .map((r) => ({
            id: r.id,
            name: r.name || "Unnamed Asset",
            error: r.error || "Classification failed",
          }));

        updateJob((prev) => {
          if (!prev || activeRunRef.current !== runId) return prev;
          const nextDone = totalItems - currentQueue.length;
          const updatedRecent = results.length > 0
            ? [
                ...results.map((r) => ({ ...r, timestamp: Date.now() })),
                ...prev.recentTagged,
              ]
                .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
                .slice(0, 8)
            : prev.recentTagged;

          return {
            ...prev,
            status: "running",
            done: nextDone,
            tagged: prev.tagged + newTagged,
            failed: prev.failed + newFailed,
            queue: currentQueue,
            currentlyTagging: latestItem
              ? {
                  id: latestItem.id,
                  name: latestItem.name,
                  folderPath: latestItem.folderPath,
                  driveFileId: latestItem.driveFileId,
                }
              : prev.currentlyTagging,
            recentTagged: updatedRecent,
            failures: [...prev.failures, ...newFailures].slice(-50),
            updatedAt: Date.now(),
          };
        });
      }

      // Completed successfully
      updateJob((prev) => {
        if (!prev || activeRunRef.current !== runId) return prev;
        return {
          ...prev,
          status: "completed",
          done: totalItems,
          queue: [],
          currentlyTagging: null,
          error:
            prev.failed > 0
              ? `Completed! ${prev.tagged} tagged, ${prev.failed} skipped/failed.`
              : `All ${prev.tagged} image assets successfully tagged!`,
          updatedAt: Date.now(),
        };
      });

      void fetchStats(targetPath);
    } catch (err) {
      if (activeRunRef.current !== runId) return;
      const msg = err instanceof Error ? err.message : "Auto-tagging stopped.";
      updateJob((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          status: "paused",
          error: `${msg} Progress is saved. You can click Resume at any time.`,
          updatedAt: Date.now(),
        };
      });
      void fetchStats(targetPath);
    } finally {
      if (activeRunRef.current === runId) {
        isLoopRunningRef.current = false;
      }
    }
  }, [fetchStats, updateJob]);

  // Start new auto-tag job
  const startAutoTag = useCallback(
    async (options?: {
      folderPath?: string;
      reTagAll?: boolean;
      folderName?: string;
    }) => {
      const targetPath = options?.folderPath ?? "";
      const reTagAll = Boolean(options?.reTagAll);
      const targetName =
        options?.folderName || (targetPath ? targetPath : "the entire DAM Drive");

      activeRunRef.current++; // Stop previous runs

      updateJob(() => ({
        id: `autotag-${Date.now()}`,
        status: "running",
        reTagAll,
        targetPath,
        targetName,
        total: 0,
        done: 0,
        tagged: 0,
        failed: 0,
        queue: [],
        recentTagged: [],
        currentlyTagging: null,
        failures: [],
        error: "Fetching asset list for tagging…",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }));

      try {
        const statsUrl = targetPath
          ? `/api/autotag?folderPath=${encodeURIComponent(targetPath)}&includeIds=1`
          : "/api/autotag?includeIds=1";

        let statsData: {
          error?: string;
          total?: number;
          totalImages?: number;
          untaggedCount?: number;
          untaggedIds?: string[];
          allImageIds?: string[];
        } = {};

        for (let attempt = 1; ; attempt++) {
          try {
            const res = await fetch(statsUrl);
            statsData = await res.json();
            if (!res.ok) {
              throw new Error(statsData.error || "Could not fetch image assets.");
            }
            break;
          } catch (e) {
            if (attempt >= 3) throw e;
            await sleep(2000 * attempt);
          }
        }

        const candidateIds = reTagAll
          ? Array.isArray(statsData.allImageIds)
            ? statsData.allImageIds
            : []
          : Array.isArray(statsData.untaggedIds)
          ? statsData.untaggedIds
          : [];

        if (candidateIds.length === 0) {
          updateJob((prev) =>
            prev
              ? {
                  ...prev,
                  status: "completed",
                  error: "No images need tagging in this selection.",
                }
              : null
          );
          void fetchStats(targetPath);
          return;
        }

        const freshJob: AutoTagJob = {
          id: `autotag-${Date.now()}`,
          status: "running",
          reTagAll,
          targetPath,
          targetName,
          total: candidateIds.length,
          done: 0,
          tagged: 0,
          failed: 0,
          queue: candidateIds,
          recentTagged: [],
          currentlyTagging: null,
          failures: [],
          error: "",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        };

        updateJob(() => freshJob);
        void runWorkerLoop(freshJob);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to start auto-tagging.";
        updateJob((prev) =>
          prev
            ? {
                ...prev,
                status: "error",
                error: msg,
              }
            : null
        );
      }
    },
    [fetchStats, runWorkerLoop, updateJob]
  );

  // Pause job
  const pauseAutoTag = useCallback((userInitiated = true) => {
    activeRunRef.current++;
    isLoopRunningRef.current = false;
    updateJob((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        status: "paused",
        error: userInitiated
          ? "Auto-tagging paused. All processed tags are saved."
          : prev.error,
        updatedAt: Date.now(),
      };
    });
  }, [updateJob]);

  // Resume paused job
  const resumeAutoTag = useCallback(() => {
    if (!job || job.queue.length === 0) return;
    const resumedJob: AutoTagJob = {
      ...job,
      status: "running",
      error: "",
      updatedAt: Date.now(),
    };
    updateJob(() => resumedJob);
    void runWorkerLoop(resumedJob);
  }, [job, runWorkerLoop, updateJob]);

  // Reset / Discard job
  const resetAutoTag = useCallback(() => {
    activeRunRef.current++;
    isLoopRunningRef.current = false;
    updateJob(() => null);
  }, [updateJob]);

  // Hydrate from localStorage on client mount & listen for multi-tab sync
  useEffect(() => {
    const saved = loadSavedJob();
    if (saved) {
      setJob(saved);
    }

    try {
      channelRef.current = new BroadcastChannel(BROADCAST_CHANNEL);
      channelRef.current.onmessage = (e) => {
        if (e.data?.type === "JOB_UPDATED") {
          setJob(e.data.job);
        }
      };
    } catch {
      // BroadcastChannel unsupported
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        try {
          const parsed = e.newValue ? (JSON.parse(e.newValue) as AutoTagJob) : null;
          setJob(parsed);
        } catch {
          // Ignore
        }
      }
    };

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      try {
        channelRef.current?.close();
      } catch {
        // Ignore
      }
    };
  }, []);

  // Screen WakeLock while auto-tagging is running
  const isRunning = job?.status === "running";
  useEffect(() => {
    if (!isRunning) return;
    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      try {
        if (!stopped && document.visibilityState === "visible") {
          sentinel = (await navigator.wakeLock?.request("screen")) ?? null;
        }
      } catch {
        // Unsupported browser or policy
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
  }, [isRunning]);

  return (
    <AutoTagContext.Provider
      value={{
        job,
        isRunning: job?.status === "running",
        isPaused: job?.status === "paused",
        stats,
        fetchStats,
        startAutoTag,
        pauseAutoTag,
        resumeAutoTag,
        resetAutoTag,
      }}
    >
      {children}
    </AutoTagContext.Provider>
  );
}

export function useAutoTag() {
  const ctx = useContext(AutoTagContext);
  if (!ctx) {
    throw new Error("useAutoTag must be used within an AutoTagProvider");
  }
  return ctx;
}
