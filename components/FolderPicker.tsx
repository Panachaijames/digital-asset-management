"use client";

import { useEffect, useRef, useState } from "react";
import type { DriveFolder } from "@/lib/types";

interface FolderPickerProps {
  selected: DriveFolder | null;
  onSelect: (folder: DriveFolder) => void;
}

const RECENT_KEY = "dam-recent-destinations";
const RECENT_MAX = 5;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

// Destination picker: search across ALL folders, one-click recent
// destinations, drill-down browsing, "Upload here", and inline folder
// creation — so a deep project folder is reachable in one action instead of
// a click per level.
export default function FolderPicker({ selected, onSelect }: FolderPickerProps) {
  // Breadcrumb trail of folders drilled into so far; last item is current level.
  const [trail, setTrail] = useState<DriveFolder[]>([]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Search over every folder path (lazy-loaded from /api/paths on first use).
  const [search, setSearch] = useState("");
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const pathsRequested = useRef(false);

  // Path → Drive-id resolution while picking from search/recents.
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const [recents, setRecents] = useState<string[]>([]);
  useEffect(() => setRecents(readRecents()), []);

  // Inline "new folder here".
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const currentParent = trail[trail.length - 1];

  useEffect(() => {
    let cancelled = false;

    async function loadFolders() {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        if (currentParent) {
          params.set("driveId", currentParent.driveId);
          params.set("parentId", currentParent.id);
          params.set("parentPath", currentParent.path);
        }
        const res = await fetch(`/api/folders?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;
        setFolders(data.folders ?? []);
        if (data.error) setLoadError(data.error);
      } catch {
        if (!cancelled) setLoadError("Could not load folders.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadFolders();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentParent?.id]);

  const drillInto = (folder: DriveFolder) => setTrail([...trail, folder]);
  const drillTo = (index: number) => setTrail(trail.slice(0, index + 1));
  const goToRoot = () => setTrail([]);

  const ensurePathsLoaded = () => {
    if (pathsRequested.current) return;
    pathsRequested.current = true;
    fetch("/api/paths")
      .then((r) => r.json())
      .then((d) => setAllPaths(Array.isArray(d.paths) ? d.paths : []))
      .catch(() => setAllPaths([]));
  };

  const pushRecent = (path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable — recents just won't persist.
      }
      return next;
    });
  };

  const pick = (folder: DriveFolder) => {
    setPickError(null);
    onSelect(folder);
    pushRecent(folder.path);
  };

  // Select a folder by its human path (search result / recent chip). Resolved
  // to Drive ids at pick time so a renamed/deleted folder fails loudly here
  // rather than mid-upload.
  const pickByPath = async (path: string) => {
    setPickError(null);
    setResolvingPath(path);
    try {
      const res = await fetch(
        `/api/folders/resolve?path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (!res.ok || !data.folder) {
        throw new Error(data.error || "Folder not found.");
      }
      pick(data.folder as DriveFolder);
      setSearch("");
    } catch (e) {
      setPickError(e instanceof Error ? e.message : "Folder not found.");
    } finally {
      setResolvingPath(null);
    }
  };

  const createHere = async () => {
    const name = newName.trim();
    if (!name || !currentParent || createBusy) return;
    setCreateBusy(true);
    setPickError(null);
    try {
      const res = await fetch("/api/folders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentParent.path, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.folder) {
        throw new Error(data.error || "Could not create the folder.");
      }
      const folder: DriveFolder = {
        id: data.folder.id,
        name: data.folder.name,
        path: data.folder.path,
        driveId: data.folder.driveId,
      };
      // Show it in the current listing (find-or-create may return an existing
      // one) and select it as the destination in one step.
      setFolders((prev) =>
        prev.some((f) => f.id === folder.id)
          ? prev
          : [...prev, folder].sort((a, b) => a.name.localeCompare(b.name))
      );
      pick(folder);
      setCreatingOpen(false);
      setNewName("");
    } catch (e) {
      setPickError(
        e instanceof Error ? e.message : "Could not create the folder."
      );
    } finally {
      setCreateBusy(false);
    }
  };

  const query = search.trim().toLowerCase();
  const matches =
    query && allPaths
      ? allPaths.filter((p) => p.toLowerCase().includes(query)).slice(0, 12)
      : [];

  return (
    <div>
      <label className="block text-sm font-medium text-ink/70 mb-2">
        Destination folder
      </label>

      {/* Search any folder by name — fastest path to a deep folder */}
      <input
        type="text"
        value={search}
        onFocus={ensurePathsLoaded}
        onChange={(e) => {
          setSearch(e.target.value);
          ensurePathsLoaded();
        }}
        placeholder="Search all folders… (e.g. ProjectX)"
        className="mb-2 w-full rounded-sm border border-line bg-card px-3 py-2 text-sm outline-none placeholder:text-ink/30 focus:border-blueprint-400"
      />

      {search.trim() ? (
        <div className="mb-2 max-h-48 overflow-y-auto rounded-sm border border-line bg-card">
          {!allPaths && (
            <p className="px-3 py-2.5 text-sm text-ink/40">Loading folder list…</p>
          )}
          {allPaths && matches.length === 0 && (
            <p className="px-3 py-2.5 text-sm text-ink/40">
              No folders match &quot;{search.trim()}&quot;.
            </p>
          )}
          {matches.map((p) => {
            const segs = p.split("/");
            const leaf = segs[segs.length - 1];
            const parent = segs.slice(0, -1).join(" / ");
            return (
              <button
                key={p}
                type="button"
                onClick={() => void pickByPath(p)}
                disabled={resolvingPath !== null}
                title={p}
                className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-paper disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="text-ink">{leaf}</span>
                  {parent && <span className="text-ink/40"> — {parent}</span>}
                </span>
                {resolvingPath === p && (
                  <span className="shrink-0 font-mono text-[10px] text-blueprint-400">
                    selecting…
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {/* Recent destinations */}
          {recents.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-ink/40">Recent:</span>
              {recents.map((p) => (
                <button
                  key={p}
                  type="button"
                  title={p}
                  onClick={() => void pickByPath(p)}
                  disabled={resolvingPath !== null}
                  className="max-w-[180px] truncate rounded-sm border border-line bg-card px-2 py-0.5 font-mono text-[11px] text-ink/60 hover:border-blueprint-400 hover:text-ink disabled:opacity-50"
                >
                  {resolvingPath === p ? "selecting…" : p.split("/").pop()}
                </button>
              ))}
            </div>
          )}

          {/* Selected folder */}
          {selected && (
            <div className="mb-2 flex items-center gap-2 rounded-sm border border-blueprint-200 bg-blueprint-50 px-3 py-2">
              <span className="font-mono text-xs text-blueprint-700">
                Uploading to: {selected.path}
              </span>
            </div>
          )}

          {/* Breadcrumbs + actions for the level being browsed */}
          <div className="mb-2 flex flex-wrap items-center gap-1 font-mono text-xs text-ink/50">
            <button
              type="button"
              onClick={goToRoot}
              className="hover:text-blueprint-600 hover:underline"
            >
              Shared drives
            </button>
            {trail.map((f, i) => (
              <span key={f.id} className="flex items-center gap-1">
                <span>/</span>
                <button
                  type="button"
                  onClick={() => drillTo(i)}
                  className="hover:text-blueprint-600 hover:underline"
                >
                  {f.name}
                </button>
              </span>
            ))}
            {currentParent && (
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => pick(currentParent)}
                  className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-ink/70 hover:border-blueprint-400 hover:text-ink"
                >
                  Upload here
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreatingOpen((v) => !v);
                    setNewName("");
                  }}
                  className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-ink/70 hover:border-blueprint-400 hover:text-ink"
                >
                  + New folder
                </button>
              </span>
            )}
          </div>

          {/* Inline create-and-select */}
          {creatingOpen && currentParent && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createHere();
                  if (e.key === "Escape") setCreatingOpen(false);
                }}
                placeholder={`New folder in ${currentParent.name}…`}
                className="w-56 rounded-sm border border-line bg-card px-2.5 py-1 text-sm outline-none focus:border-blueprint-400"
              />
              <button
                type="button"
                onClick={() => void createHere()}
                disabled={createBusy || !newName.trim()}
                className="rounded-sm bg-blueprint-600 px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {createBusy ? "Creating…" : "Create & select"}
              </button>
            </div>
          )}

          {/* Folder list */}
          <div className="max-h-48 overflow-y-auto rounded-sm border border-line bg-card">
            {loading && (
              <p className="px-3 py-2.5 text-sm text-ink/40">Loading folders…</p>
            )}
            {!loading && loadError && (
              <p className="px-3 py-2.5 text-sm text-red-400">{loadError}</p>
            )}
            {!loading && !loadError && folders.length === 0 && (
              <p className="px-3 py-2.5 text-sm text-ink/40">
                {trail.length === 0
                  ? "No Shared Drives found — add the service account as a member of a Shared Drive."
                  : "No subfolders here — use “Upload here” above to upload into this folder."}
              </p>
            )}
            {!loading &&
              folders.map((folder) => {
                const isSelected = selected?.id === folder.id;
                return (
                  <div
                    key={folder.id}
                    className={`flex items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0 ${
                      isSelected ? "bg-blueprint-50" : "hover:bg-paper"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => pick(folder)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none ${
                          isSelected
                            ? "border-blueprint-600 bg-blueprint-600 text-white"
                            : "border-line text-transparent"
                        }`}
                        aria-hidden
                      >
                        ✓
                      </span>
                      <span
                        className={`truncate text-sm ${
                          isSelected
                            ? "font-medium text-blueprint-700"
                            : "text-ink"
                        }`}
                      >
                        {folder.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => drillInto(folder)}
                      className="shrink-0 text-xs text-ink/40 hover:text-blueprint-600"
                      aria-label={`Open ${folder.name}`}
                    >
                      Open →
                    </button>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {pickError && <p className="mt-1.5 text-xs text-red-400">{pickError}</p>}
      <p className="mt-1.5 text-xs text-ink/40">
        Search above, click a recent chip, or browse: click a folder to select
        it · &quot;Open →&quot; goes inside · &quot;Upload here&quot; picks the
        folder you&apos;re viewing.
      </p>
    </div>
  );
}
