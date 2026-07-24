"use client";

import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import TaxonomyPicker from "@/components/TaxonomyPicker";
import type { DamAsset, TaxonomySelection } from "@/lib/types";

interface TagCount {
  tag: string;
  count: number;
}

interface TreeNode {
  name: string;
  path: string; // full folder_path, "" for root
  children: TreeNode[];
}

const EMPTY_FILTER: TaxonomySelection = {
  macro_portfolio: null,
  core_sector: null,
  sub_sectors: [],
};

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "Home", path: "", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const p of paths) {
    if (!p) continue;
    const segs = p.split("/");
    let acc = "";
    let parent = root;
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let node = byPath.get(acc);
      if (!node) {
        node = { name: seg, path: acc, children: [] };
        byPath.set(acc, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function findNode(root: TreeNode, path: string): TreeNode | null {
  if (!path) return root;
  let node: TreeNode | null = root;
  for (const seg of path.split("/")) {
    node = node?.children.find((c) => c.name === seg) ?? null;
    if (!node) return null;
  }
  return node;
}

function formatBytes(n: number) {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2a1.5 1.5 0 0 1 1.2.6l1.2 1.6H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.2H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" strokeLinejoin="round" />
    </svg>
  );
}

function Tree({
  node,
  depth,
  current,
  expanded,
  onSelect,
  onToggle,
  filter,
}: {
  node: TreeNode;
  depth: number;
  current: string;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  filter: string;
}) {
  const visible = filter
    ? node.name.toLowerCase().includes(filter.toLowerCase()) ||
      hasVisibleDescendant(node, filter)
    : true;
  if (!visible && depth > 0) return null;

  const isOpen = expanded.has(node.path) || depth === 0 || !!filter;
  const isActive = current === node.path;

  return (
    <div>
      <div
        className={`flex cursor-pointer items-center gap-1 rounded-sm py-1 pr-2 text-sm ${
          isActive ? "bg-blueprint-50 text-ink" : "text-ink/70 hover:bg-card"
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onSelect(node.path)}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-ink/40 hover:text-ink"
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
            >
              <path d="M6 3.5 11 8l-5 4.5v-9Z" />
            </svg>
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <span className={`h-4 w-4 shrink-0 ${isActive ? "text-blueprint-400" : "text-ink/40"}`}>
          {depth === 0 ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
              <path d="M6.5 17a4.5 4.5 0 1 1 .9-8.9 6 6 0 0 1 11.5 1.7A3.6 3.6 0 0 1 18 17H6.5Z" strokeLinejoin="round" />
            </svg>
          ) : (
            <FolderGlyph className="h-4 w-4" />
          )}
        </span>
        <span className="truncate">{node.name}</span>
      </div>
      {isOpen &&
        node.children.map((c) => (
          <Tree
            key={c.path}
            node={c}
            depth={depth + 1}
            current={current}
            expanded={expanded}
            onSelect={onSelect}
            onToggle={onToggle}
            filter={filter}
          />
        ))}
    </div>
  );
}

function hasVisibleDescendant(node: TreeNode, filter: string): boolean {
  return node.children.some(
    (c) =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      hasVisibleDescendant(c, filter)
  );
}

export default function BrowsePage() {
  const [assets, setAssets] = useState<DamAsset[]>([]);
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [taxonomy, setTaxonomy] = useState<TaxonomySelection>(EMPTY_FILTER);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [paths, setPaths] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeFilter, setTreeFilter] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pathsError, setPathsError] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagStatus, setAutoTagStatus] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(paths), [paths]);
  const currentNode = useMemo(
    () => findNode(tree, currentPath),
    [tree, currentPath]
  );
  const childFolders = currentNode?.children ?? [];

  const hasTaxonomyFilter =
    !!taxonomy.macro_portfolio ||
    !!taxonomy.core_sector ||
    taxonomy.sub_sectors.length > 0;
  const filtersActive =
    hasTaxonomyFilter || activeTags.length > 0 || !!search.trim() || untaggedOnly;

  // Folder paths for the tree. On a transient Drive failure, keep the
  // last-good tree (don't clobber to empty) and flag it for a retry banner.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/paths")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error || !Array.isArray(data.paths)) {
          setPathsError(true);
        } else {
          setPathsError(false);
          setPaths(data.paths);
        }
      })
      .catch(() => {
        if (!cancelled) setPathsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Tag chips.
  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then((data) => setAllTags(data.tags ?? []))
      .catch(() => setAllTags([]));
  }, [refreshKey]);

  // Assets. Default: current folder only. With search/filters: whole subtree.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams();
    if (activeTags.length) params.set("tags", activeTags.join(","));
    if (search.trim()) params.set("q", search.trim());
    if (taxonomy.macro_portfolio) params.set("macro", taxonomy.macro_portfolio);
    if (taxonomy.core_sector) params.set("core", taxonomy.core_sector);
    if (taxonomy.sub_sectors.length)
      params.set("sub", taxonomy.sub_sectors.join(","));
    params.set("sort", sort);
    if (!filtersActive) {
      if (currentPath) params.set("path", currentPath);
      else params.set("path", ""); // root: show everything below via no filter
    } else if (currentPath) {
      params.set("pathPrefix", currentPath);
    }
    if (!filtersActive && !currentPath) params.delete("path");

    const timeout = setTimeout(() => {
      fetch(`/api/assets?${params.toString()}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          let rows: DamAsset[] = data.assets ?? [];
          // Refine prefix matches: "ProjectX" must not match "ProjectXtra".
          if (filtersActive && currentPath) {
            rows = rows.filter(
              (a) =>
                a.folder_path === currentPath ||
                a.folder_path.startsWith(`${currentPath}/`)
            );
          }
          if (untaggedOnly) {
            rows = rows.filter(
              (a) =>
                !a.tags ||
                a.tags.length === 0 ||
                !a.macro_portfolio ||
                !a.core_sector
            );
          }
          setAssets(rows);
        })
        .catch(() => {
          if (!cancelled) setAssets([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [
    activeTags,
    search,
    taxonomy.macro_portfolio,
    taxonomy.core_sector,
    taxonomy.sub_sectors,
    currentPath,
    sort,
    filtersActive,
    untaggedOnly,
    refreshKey,
  ]);

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const selectPath = (path: string) => {
    setCurrentPath(path);
    setSelectedId(null);
    setSelectedIds(new Set());
    if (path) {
      // Auto-expand ancestors so the selection is visible.
      setExpanded((prev) => {
        const next = new Set(prev);
        const segs = path.split("/");
        let acc = "";
        for (const s of segs) {
          acc = acc ? `${acc}/${s}` : s;
          next.add(acc);
        }
        return next;
      });
    }
  };

  const toggleNode = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bulk delete for Select mode: each file goes to the Drive trash and its
  // metadata row is removed (same semantics as the external API's delete).
  const deleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length || deleting) return;
    if (
      !window.confirm(
        `Delete ${ids.length} image${ids.length === 1 ? "" : "s"}?\n\nFiles go to the Drive trash (recoverable there for ~30 days) but their tags/metadata are removed.`
      )
    )
      return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed.");
      const gone = new Set<string>(data.deleted ?? []);
      setAssets((prev) => prev.filter((a) => !gone.has(a.id)));
      if (selectedId && gone.has(selectedId)) setSelectedId(null);
      setSelectedIds(new Set());
      if (data.failures?.length) {
        setDeleteError(
          `${data.failures.length} image${
            data.failures.length === 1 ? "" : "s"
          } could not be deleted.`
        );
      } else {
        setSelectMode(false);
      }
      setRefreshKey((k) => k + 1); // refresh tag counts
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };

  const autoTagSelected = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length || autoTagging) return;
    setAutoTagging(true);
    setAutoTagStatus(null);
    setDeleteError(null);
    try {
      const res = await fetch("/api/autotag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds: ids, forceAll: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Auto-tagging failed.");
      setAutoTagStatus(
        `Auto-tagged ${data.tagged} image${data.tagged === 1 ? "" : "s"}.`
      );
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setDeleteError(
        e instanceof Error ? e.message : "Auto-tagging failed."
      );
    } finally {
      setAutoTagging(false);
    }
  };

  // Delete the folder currently being viewed: its whole subtree goes to the
  // Drive trash and every asset record under it is removed from the DAM.
  const deleteCurrentFolder = async () => {
    const segs = currentPath ? currentPath.split("/") : [];
    if (segs.length < 2 || folderBusy) return;
    const leaf = segs[segs.length - 1];
    if (
      !window.confirm(
        `Delete the folder "${leaf}" and EVERYTHING inside it (all subfolders and images)?\n\nThe folder goes to the Drive trash (recoverable there for ~30 days), but all its image records and tags are removed from the DAM.`
      )
    )
      return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const res = await fetch("/api/folders/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: currentPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete the folder.");
      selectPath(segs.slice(0, -1).join("/")); // go up to the parent
      setRefreshKey((k) => k + 1); // reload tree + assets + tag counts
    } catch (e) {
      setFolderError(
        e instanceof Error ? e.message : "Could not delete the folder."
      );
    } finally {
      setFolderBusy(false);
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !currentPath || creating) return;
    // Cheap client-side pre-check against the folders we already know about.
    if (childFolders.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      setCreateError(`A folder named "${name}" already exists here.`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/folders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.folder) {
        throw new Error(data.error || "Could not create the folder.");
      }
      if (data.folder.created === false) {
        // Drive already had a folder with this name — don't pretend we made it.
        setCreateError(`A folder named "${name}" already exists here.`);
        return;
      }
      setCreatingFolder(false);
      setNewFolderName("");
      setRefreshKey((k) => k + 1); // reload the Drive tree
      selectPath(data.folder.path as string); // navigate into it
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create folder.");
    } finally {
      setCreating(false);
    }
  };

  const selected = assets.find((a) => a.id === selectedId) ?? null;
  const crumbSegs = currentPath ? currentPath.split("/") : [];
  const filterCount =
    (taxonomy.macro_portfolio ? 1 : 0) +
    (taxonomy.core_sector ? 1 : 0) +
    taxonomy.sub_sectors.length +
    activeTags.length;

  return (
    <AppShell
      crumb="Assets"
      topRight={
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search assets…"
          className="w-56 rounded-sm border border-line bg-card px-3 py-1.5 text-sm outline-none placeholder:text-ink/30 focus:border-blueprint-400"
        />
      }
    >
      <div className="flex h-full">
        {/* Folder tree */}
        <div className="hidden w-64 shrink-0 flex-col border-r border-line/60 bg-panel lg:flex">
          <div className="p-2">
            <input
              type="text"
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              placeholder="Type to filter"
              className="w-full rounded-sm border border-line bg-card px-2.5 py-1.5 text-xs outline-none placeholder:text-ink/30 focus:border-blueprint-400"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {pathsError && tree.children.length === 0 ? (
              <div className="px-2 py-3 text-xs text-ink/50">
                Couldn&apos;t load folders.{" "}
                <button
                  type="button"
                  onClick={() => setRefreshKey((k) => k + 1)}
                  className="text-blueprint-400 hover:underline"
                >
                  Retry
                </button>
              </div>
            ) : (
              <>
                {pathsError && (
                  <div className="mb-1 px-2 py-1 text-[11px] text-ink/40">
                    Folder list may be out of date.{" "}
                    <button
                      type="button"
                      onClick={() => setRefreshKey((k) => k + 1)}
                      className="text-blueprint-400 hover:underline"
                    >
                      Retry
                    </button>
                  </div>
                )}
                <Tree
                  node={tree}
                  depth={0}
                  current={currentPath}
                  expanded={expanded}
                  onSelect={selectPath}
                  onToggle={toggleNode}
                  filter={treeFilter}
                />
              </>
            )}
          </div>
        </div>

        {/* Grid pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/60 px-4 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRefreshKey((k) => k + 1)}
                aria-label="Refresh"
                className="flex h-7 w-7 items-center justify-center rounded-sm text-ink/50 hover:bg-card hover:text-ink"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
                  <path d="M4 12a8 8 0 0 1 13.6-5.7L20 8.5M20 12a8 8 0 0 1-13.6 5.7L4 15.5" strokeLinecap="round" />
                  <path d="M20 4v4.5h-4.5M4 20v-4.5h4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${
                  showFilters || filterCount
                    ? "bg-blueprint-50 text-blueprint-700"
                    : "text-ink/60 hover:bg-card hover:text-ink"
                }`}
              >
                Filters{filterCount ? ` (${filterCount})` : ""}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelectedIds(new Set());
                  setDeleteError(null);
                }}
                className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${
                  selectMode
                    ? "bg-blueprint-50 text-blueprint-700"
                    : "text-ink/60 hover:bg-card hover:text-ink"
                }`}
              >
                {selectMode ? "Cancel" : "Select"}
              </button>
              {selectMode && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedIds(new Set(assets.map((a) => a.id)))
                    }
                    className="text-xs text-blueprint-400 hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-xs text-ink/40">
                    {selectedIds.size} selected
                  </span>
                  <button
                    type="button"
                    onClick={() => void autoTagSelected()}
                    disabled={!selectedIds.size || autoTagging || deleting}
                    className="rounded-sm bg-blueprint-600 px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {autoTagging
                      ? "Auto-Tagging…"
                      : `Auto-Tag AI${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSelected()}
                    disabled={!selectedIds.size || deleting || autoTagging}
                    className="rounded-sm bg-red-600 px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {deleting
                      ? "Deleting…"
                      : `Delete${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
                  </button>
                  {autoTagStatus && (
                    <span className="text-xs text-emerald-600">{autoTagStatus}</span>
                  )}
                  {deleteError && (
                    <span className="text-xs text-red-400">{deleteError}</span>
                  )}
                </>
              )}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
              className="rounded-sm border border-line bg-card px-2 py-1 text-xs text-ink/70 outline-none focus:border-blueprint-400"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>

          {/* Filters */}
          {showFilters && (
            <div className="shrink-0 space-y-3 border-b border-line/60 bg-panel/60 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink/40">
                    Filter by sector
                  </span>
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink/70">
                    <input
                      type="checkbox"
                      checked={untaggedOnly}
                      onChange={(e) => setUntaggedOnly(e.target.checked)}
                      className="rounded-sm border-line text-blueprint-600 focus:ring-blueprint-500"
                    />
                    Untagged images only
                  </label>
                </div>
                {filterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setTaxonomy(EMPTY_FILTER);
                      setActiveTags([]);
                      setUntaggedOnly(false);
                    }}
                    className="text-xs text-blueprint-400 hover:underline"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <TaxonomyPicker value={taxonomy} onChange={setTaxonomy} compact />
              {allTags.length > 0 && (
                <div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink/40">
                    Tags
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {allTags.map(({ tag, count }) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        className={`rounded-sm px-2 py-0.5 font-mono text-[11px] transition-colors ${
                          activeTags.includes(tag)
                            ? "bg-blueprint-600 text-white"
                            : "border border-line bg-card text-ink/60 hover:border-blueprint-400"
                        }`}
                      >
                        {tag} <span className="opacity-50">{count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Path breadcrumb + counts */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-1 pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
              <button
                type="button"
                onClick={() => selectPath("")}
                className={`hover:text-blueprint-400 ${
                  currentPath ? "text-ink/50" : "font-medium text-ink"
                }`}
              >
                Home
              </button>
              {crumbSegs.map((seg, i) => {
                const p = crumbSegs.slice(0, i + 1).join("/");
                const last = i === crumbSegs.length - 1;
                return (
                  <span key={p} className="flex items-center gap-1">
                    <span className="text-ink/25">/</span>
                    <button
                      type="button"
                      onClick={() => selectPath(p)}
                      className={
                        last
                          ? "font-medium text-ink"
                          : "text-ink/50 hover:text-blueprint-400"
                      }
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-xs text-ink/40">
                Showing {childFolders.length} folder
                {childFolders.length === 1 ? "" : "s"} and {assets.length} asset
                {assets.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setCreatingFolder((v) => !v);
                  setNewFolderName("");
                  setCreateError(null);
                }}
                disabled={!currentPath}
                title={
                  currentPath
                    ? "Create a folder here"
                    : "Open a Shared Drive or folder first"
                }
                className="flex items-center gap-1 rounded-sm border border-line px-2 py-1 text-xs text-ink/70 transition-colors hover:border-blueprint-400 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="text-sm leading-none">+</span> New folder
              </button>
              <button
                type="button"
                onClick={() => void deleteCurrentFolder()}
                disabled={crumbSegs.length < 2 || folderBusy}
                title={
                  crumbSegs.length < 2
                    ? "Open a folder inside a Shared Drive first (a drive itself can't be deleted)"
                    : `Delete "${crumbSegs[crumbSegs.length - 1]}" and everything inside it`
                }
                className="flex items-center gap-1 rounded-sm border border-line px-2 py-1 text-xs text-ink/70 transition-colors hover:border-red-500 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {folderBusy ? "Deleting…" : "Delete folder"}
              </button>
              {folderError && (
                <span className="text-xs text-red-400">{folderError}</span>
              )}
            </div>
          </div>

          {/* Inline create-folder form */}
          {creatingFolder && currentPath && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line/60 bg-panel/60 px-4 py-2">
              <span className="text-xs text-ink/40">
                New folder in{" "}
                <span className="font-mono text-ink/70">
                  {crumbSegs[crumbSegs.length - 1] ?? "Home"}
                </span>
                :
              </span>
              <input
                autoFocus
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") setCreatingFolder(false);
                }}
                placeholder="Folder name…"
                className="w-56 rounded-sm border border-line bg-card px-2.5 py-1 text-sm outline-none focus:border-blueprint-400"
              />
              <button
                type="button"
                onClick={() => void createFolder()}
                disabled={creating || !newFolderName.trim()}
                className="rounded-sm bg-blueprint-600 px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {creating ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setCreatingFolder(false)}
                className="text-xs text-ink/50 hover:text-ink"
              >
                Cancel
              </button>
              {createError && (
                <span className="text-xs text-red-400">{createError}</span>
              )}
            </div>
          )}

          {/* Grid */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2">
            {childFolders.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {childFolders.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => selectPath(f.path)}
                    className="flex items-center gap-2 rounded-sm border border-line bg-card px-3 py-2.5 text-left text-sm text-ink/80 transition-colors hover:border-blueprint-400 hover:text-ink"
                  >
                    <span className="h-4 w-4 shrink-0 text-ink/40">
                      <FolderGlyph className="h-4 w-4" />
                    </span>
                    <span className="truncate">{f.name}</span>
                  </button>
                ))}
              </div>
            )}

            {loading && <p className="text-sm text-ink/40">Loading…</p>}
            {!loading && assets.length === 0 && childFolders.length === 0 && (
              <p className="text-sm text-ink/40">
                No assets here{filtersActive ? " matching these filters" : ""}.
              </p>
            )}
            {!loading && assets.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {assets.map((asset) => {
                  const isSel = selectedId === asset.id;
                  const checked = selectedIds.has(asset.id);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() =>
                        selectMode
                          ? toggleSelected(asset.id)
                          : setSelectedId(isSel ? null : asset.id)
                      }
                      className={`group relative block overflow-hidden rounded-sm border text-left transition-colors ${
                        (selectMode ? checked : isSel)
                          ? "border-blueprint-600 bg-blueprint-50"
                          : "border-line bg-card hover:border-blueprint-400"
                      }`}
                    >
                      {selectMode && (
                        <span
                          className={`absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                            checked
                              ? "border-blueprint-600 bg-blueprint-600 text-white"
                              : "border-line bg-paper/80 text-transparent"
                          }`}
                        >
                          ✓
                        </span>
                      )}
                      <div className="relative aspect-square bg-panel">
                        <div className="absolute inset-0 flex items-center justify-center text-xs text-ink/30">
                          No preview
                        </div>
                        {/* Served via /api/thumbnail — Drive's stored links
                            expire after a few hours, the proxy re-signs them. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/thumbnail?id=${asset.drive_file_id}`}
                          alt={asset.name}
                          loading="lazy"
                          onError={(e) =>
                            (e.currentTarget.style.visibility = "hidden")
                          }
                          className="relative h-full w-full object-cover"
                        />
                      </div>
                      <div className="p-2">
                        <p className="truncate text-xs font-medium text-ink">
                          {asset.name}
                        </p>
                        {(asset.core_sector || asset.macro_portfolio) && (
                          <p className="mt-1 truncate font-mono text-[10px] text-blueprint-700">
                            {[asset.macro_portfolio, asset.core_sector]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Preview pane */}
        <div className="hidden w-80 shrink-0 flex-col border-l border-line/60 bg-panel xl:flex">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-line/60 px-4">
            <span className="text-sm text-ink/70">Preview</span>
            {selected && (
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Close preview"
                className="text-ink/40 hover:text-ink"
              >
                ×
              </button>
            )}
          </div>
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="h-10 w-10 text-ink/20">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-10 w-10">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="9" cy="10" r="1.7" />
                  <path d="m5 17 4.5-4L13 16l3-2.5L21 17" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="text-sm text-ink/40">
                Select an item in the grid to preview it
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="overflow-hidden rounded-sm border border-line bg-card">
                <div className="relative aspect-square bg-paper">
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-ink/30">
                    No preview
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/thumbnail?id=${selected.drive_file_id}`}
                    alt={selected.name}
                    onError={(e) =>
                      (e.currentTarget.style.visibility = "hidden")
                    }
                    className="relative h-full w-full object-contain"
                  />
                </div>
              </div>
              <p className="mt-3 break-all font-mono text-xs text-ink">
                {selected.name}
              </p>

              <dl className="mt-3 space-y-2.5 text-xs">
                {selected.macro_portfolio && (
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-wider text-ink/35">
                      Classification
                    </dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {[selected.macro_portfolio, selected.core_sector]
                        .filter(Boolean)
                        .map((v) => (
                          <span
                            key={v as string}
                            className="rounded-sm bg-blueprint-50 px-1.5 py-0.5 font-mono text-[10px] text-blueprint-700"
                          >
                            {v}
                          </span>
                        ))}
                      {selected.sub_sectors?.map((s) => (
                        <span
                          key={s}
                          className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink/60"
                        >
                          {s}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {selected.tags.length > 0 && (
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-wider text-ink/35">
                      Tags
                    </dt>
                    <dd className="mt-1 font-mono text-[11px] text-ink/60">
                      #{selected.tags.join(" #")}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-wider text-ink/35">
                    Folder
                  </dt>
                  <dd className="mt-1 break-all text-ink/70">
                    {selected.folder_path || "—"}
                  </dd>
                </div>
                <div className="flex gap-6">
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-wider text-ink/35">
                      Size
                    </dt>
                    <dd className="mt-1 text-ink/70">
                      {formatBytes(selected.size_bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-wider text-ink/35">
                      Uploaded
                    </dt>
                    <dd className="mt-1 text-ink/70">
                      {new Date(selected.created_at).toLocaleDateString()}
                    </dd>
                  </div>
                </div>
              </dl>

              <a
                href={selected.web_view_link}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block rounded-sm bg-blueprint-600 px-3 py-2 text-center text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Open in Drive
              </a>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
