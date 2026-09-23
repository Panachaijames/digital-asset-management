"use client";

import { useEffect, useRef, useState } from "react";
import type { DriveFolder } from "@/lib/types";
import {
  applyRecentFolderChanges,
  noteCreatedPath,
} from "@/lib/clientFolderChanges";

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
      .then((d) =>
        // Patched with folders this tab just created/deleted: the response may
        // be a browser-cached copy from up to a minute ago.
        setAllPaths(
          Array.isArray(d.paths) ? applyRecentFolderChanges(d.paths) : []
        )
      )
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
      // Searchable right away too — here and in the /browse tree.
      noteCreatedPath(folder.path);
      setAllPaths((prev) => (prev ? applyRecentFolderChanges(prev) : prev));
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
      <label className="mb-2 block text-xs font-medium text-muted">
        Destination folder in Google Drive
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
        placeholder="Search all folders (e.g. ProjectX)"
        className="mb-2 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition-colors placeholder:text-muted focus:border-text"
      />

      {search.trim() ? (
        <div className="mb-3 max-h-48 overflow-y-auto rounded border border-border bg-surface">
          {!allPaths && (
            <p className="px-3 py-2 text-sm text-muted">Loading folder list</p>
          )}
          {allPaths && matches.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted">
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
                className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium text-text">{leaf}</span>
                  {parent && <span className="text-muted"> — {parent}</span>}
                </span>
                {resolvingPath === p && (
                  <span className="shrink-0 text-xs font-medium text-accent">
                    Selecting
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
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted">Recent:</span>
              {recents.map((p) => (
                <button
                  key={p}
                  type="button"
                  title={p}
                  onClick={() => void pickByPath(p)}
                  disabled={resolvingPath !== null}
                  className="max-w-[180px] truncate rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-50"
                >
                  {resolvingPath === p ? "Selecting" : p.split("/").pop()}
                </button>
              ))}
            </div>
          )}

          {/* Selected folder */}
          {selected && (
            <div className="mb-3 flex items-center gap-2 rounded border border-accent/25 bg-accent/5 px-3 py-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
              <span className="text-xs font-medium text-text">
                Destination: {selected.path}
              </span>
            </div>
          )}

          {/* Breadcrumbs + actions for the level being browsed */}
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted">
            <button
              type="button"
              onClick={goToRoot}
              className="transition-colors hover:text-text"
            >
              Shared drives
            </button>
            {trail.map((f, i) => (
              <span key={f.id} className="flex items-center gap-1">
                <span>/</span>
                <button
                  type="button"
                  onClick={() => drillTo(i)}
                  className="transition-colors hover:text-text"
                >
                  {f.name}
                </button>
              </span>
            ))}
            {currentParent && (
              <span className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => pick(currentParent)}
                  className="rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-bg"
                >
                  Upload here
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreatingOpen((v) => !v);
                    setNewName("");
                  }}
                  className="rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-bg"
                >
                  Add folder
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
                placeholder={`New folder in ${currentParent.name}`}
                className="w-56 rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition-colors placeholder:text-muted focus:border-text"
              />
              <button
                type="button"
                onClick={() => void createHere()}
                disabled={createBusy || !newName.trim()}
                className="rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
              >
                {createBusy ? "Creating" : "Create folder"}
              </button>
            </div>
          )}

          {/* Folder list */}
          <div className="max-h-48 overflow-y-auto rounded border border-border bg-surface p-1">
            {loading && (
              <p className="px-2 py-2 text-sm text-muted">Loading folders</p>
            )}
            {!loading && loadError && (
              <p className="px-2 py-2 text-sm text-danger">{loadError}</p>
            )}
            {!loading && !loadError && folders.length === 0 && (
              <p className="px-2 py-2 text-sm text-muted">
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
                    className={`flex items-center justify-between gap-2 rounded px-2 py-2 transition-colors ${
                      isSelected ? "bg-accent/5" : "hover:bg-bg"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => pick(folder)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-xs leading-none ${
                          isSelected
                            ? "border-accent bg-accent text-on-accent"
                            : "border-border text-transparent"
                        }`}
                        aria-hidden
                      >
                        ✓
                      </span>
                      <span
                        className={`truncate text-sm ${
                          isSelected ? "font-medium text-accent" : "text-text"
                        }`}
                      >
                        {folder.name}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => drillInto(folder)}
                      className="shrink-0 text-xs font-medium text-muted transition-colors hover:text-text"
                      aria-label={`Open ${folder.name}`}
                    >
                      Open
                    </button>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {pickError && <p className="mt-2 text-xs text-danger">{pickError}</p>}
      <p className="mt-2 text-xs text-muted">
        Search above, pick a recent folder, or browse: click a folder to select
        it, Open goes inside it, and Upload here picks the folder you are
        viewing.
      </p>
    </div>
  );
}
