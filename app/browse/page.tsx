"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import TaxonomyPicker from "@/components/TaxonomyPicker";
import VisualSearchModal from "@/components/VisualSearchModal";
import ImageUploader from "@/components/ImageUploader";
import LibrarySourceToggle, {
  type LibrarySource,
} from "@/components/LibrarySourceToggle";
import {
  applyRecentFolderChanges,
  noteCreatedPath,
  noteDeletedPath,
} from "@/lib/clientFolderChanges";
import {
  studioById,
  studioForPath,
  studioOptionLabel,
  studiosPresentIn,
} from "@/lib/studios";
import type {
  DamAsset,
  PublishPermission,
  SlideLayout,
  SlidesExport,
  TaxonomySelection,
  VisualSearchResponse,
  VisualSearchResult,
  VisualSearchSummary,
} from "@/lib/types";

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

// Module scope, so they outlive the page component: leaving /browse and coming
// back (or clicking a folder you've already visited) repaints from these
// instantly and revalidates in the background, instead of showing an empty
// shell while the network catches up.
let pathsCache: string[] | null = null;
let tagsCache: TagCount[] | null = null;
// `total` is how many rows the query matched in total; `rows` is the first
// page of them, so the grid can say "the first 60 of 13,028" instead of
// implying 60 is all there is.
const assetCache = new Map<string, { rows: DamAsset[]; total: number }>();
const ASSET_CACHE_MAX = 60;

// How many rows one /browse query asks for. Sent explicitly rather than left
// to the route's default, so the "did this get truncated?" test below is
// comparing against the number we actually requested.
const ASSET_PAGE_SIZE = 60;

function rememberAssets(key: string, rows: DamAsset[], total: number) {
  assetCache.delete(key);
  assetCache.set(key, { rows, total });
  while (assetCache.size > ASSET_CACHE_MAX) {
    const oldest = assetCache.keys().next().value;
    if (oldest === undefined) break;
    assetCache.delete(oldest);
  }
}

// The server's DAM_V2_BROWSE switch, as GET /api/v2/status reports it. "off"
// means the current library only and no toggle; "optin" starts on the current
// library; "on" starts on the project library.
type V2Mode = "off" | "optin" | "on";

// Module scope like the caches above, so coming back to /browse starts on the
// right library at once. Still re-read on every mount, because the switch can
// change under an open tab. null = not known yet, which behaves as "off".
let v2ModeCache: V2Mode | null = null;
// The library last picked with the toggle in this tab. It outranks ?source=
// and the server default, and is dropped whenever v2 reads as off.
let librarySourceChoice: LibrarySource | null = null;

function parseV2Mode(data: unknown): V2Mode {
  const status = data as { enabled?: unknown; mode?: unknown } | null;
  if (status?.enabled === true && (status.mode === "optin" || status.mode === "on")) {
    return status.mode;
  }
  return "off";
}

function pickSource(mode: V2Mode, override: string | null): LibrarySource {
  if (mode === "off") return "v1";
  if (librarySourceChoice) return librarySourceChoice;
  if (override === "v1" || override === "v2") return override;
  return mode === "on" ? "v2" : "v1";
}

// A failed project-library request. Thrown instead of being read as an empty
// page (which is what /api/assets errors turn into), so the page can say why.
// `userMessage` is the route's own { error: { message } } copy (lib/v2/errors.ts
// writes it for people and never passes database text through).
class V2LoadError extends Error {
  status: number;
  userMessage: string | null;
  constructor(status: number, userMessage: string | null) {
    super(`Project library request failed (${status}).`);
    this.status = status;
    this.userMessage = userMessage;
  }
}

function v2ErrorMessage(err: V2LoadError): string {
  return err.userMessage ?? "Could not load the project library.";
}

// The grid's page from the project library, in the /api/assets envelope. Its
// rows carry v2 ids, so no v1 write route can ever act on them.
async function fetchV2Assets(
  query: string
): Promise<{ assets?: DamAsset[]; total?: number }> {
  const res = await fetch(`/api/v2/compat/assets?${query}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !Array.isArray(data.assets)) {
    const message = data?.error?.message;
    throw new V2LoadError(
      res.status,
      typeof message === "string" && message.trim() ? message.trim().slice(0, 200) : null
    );
  }
  return data;
}

// A project-library row has a v2 id, which the v1 lookup in
// /api/assets/download can never match, so it downloads by Drive file id: with
// no `id` the route skips that lookup and streams `driveId` from Drive.
function downloadHref(asset: DamAsset, byDriveId: boolean): string {
  return byDriveId
    ? `/api/assets/download?driveId=${encodeURIComponent(asset.drive_file_id)}&name=${encodeURIComponent(asset.name)}`
    : `/api/assets/download?id=${asset.id}`;
}

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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2a1.5 1.5 0 0 1 1.2.6l1.2 1.6H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.2H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" strokeLinejoin="round" />
    </svg>
  );
}

function SlidesGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="3" y="4.5" width="18" height="13" rx="1.5" />
      <path d="M7.5 8.5h9v5h-9z" strokeLinejoin="round" />
      <path d="M12 17.5v2" strokeLinecap="round" />
    </svg>
  );
}

// memo'd because the tree is ~1800 nodes deep in this library and it is a
// sibling of the search / filter inputs — without this, every keystroke in the
// top-bar search box re-rendered the whole tree.
const Tree = memo(function Tree({
  node,
  depth,
  current,
  expanded,
  onSelect,
  onToggle,
  filter,
  selectMode,
  selectedFolderPaths,
  onToggleFolderSelect,
}: {
  node: TreeNode;
  depth: number;
  current: string;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  filter: string;
  selectMode?: boolean;
  selectedFolderPaths?: Set<string>;
  onToggleFolderSelect?: (path: string) => void;
}) {
  const visible = filter
    ? node.name.toLowerCase().includes(filter.toLowerCase()) ||
      hasVisibleDescendant(node, filter)
    : true;
  if (!visible && depth > 0) return null;

  const isOpen = expanded.has(node.path) || depth === 0 || !!filter;
  const isActive = current === node.path;
  const isFolderSelected = Boolean(
    node.path && selectedFolderPaths?.has(node.path)
  );

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-1 rounded py-1 pr-2 text-xs transition-colors ${
          isFolderSelected
            ? "bg-accent/5 text-accent font-medium"
            : isActive
            ? "bg-bg font-medium text-text"
            : "text-muted hover:bg-bg"
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
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted hover:text-text"
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
            >
              <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}

        {selectMode && node.path && (
          <input
            type="checkbox"
            checked={isFolderSelected}
            onChange={(e) => {
              e.stopPropagation();
              onToggleFolderSelect?.(node.path);
            }}
            onClick={(e) => e.stopPropagation()}
            title={`Select all files in ${node.name} and subfolders`}
            className="h-4 w-4 rounded border-border text-accent accent-accent shrink-0 cursor-pointer"
          />
        )}

        <span
          className={`h-4 w-4 shrink-0 ${
            isFolderSelected
              ? "text-accent"
              : isActive
              ? "text-text"
              : "text-muted"
          }`}
        >
          {depth === 0 ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M6.5 17a4.5 4.5 0 1 1 .9-8.9 6 6 0 0 1 11.5 1.7A3.6 3.6 0 0 1 18 17H6.5Z" strokeLinejoin="round" />
            </svg>
          ) : (
            <FolderGlyph className="h-4 w-4" />
          )}
        </span>
        <span className="truncate flex-1">{node.name}</span>
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
            selectMode={selectMode}
            selectedFolderPaths={selectedFolderPaths}
            onToggleFolderSelect={onToggleFolderSelect}
          />
        ))}
    </div>
  );
});

function hasVisibleDescendant(node: TreeNode, filter: string): boolean {
  return node.children.some(
    (c) =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      hasVisibleDescendant(c, filter)
  );
}

const AssetTile = memo(function AssetTile({
  asset,
  active,
  selectMode,
  onPick,
  onFindSimilar,
  isSearchingSimilar,
}: {
  asset: DamAsset;
  active: boolean;
  selectMode?: boolean;
  onPick: (id: string) => void;
  onFindSimilar?: (asset: DamAsset) => void;
  isSearchingSimilar?: boolean;
}) {
  const similarityScore = (asset as VisualSearchResult).similarityScore;

  return (
    <button
      type="button"
      onClick={() => onPick(asset.id)}
      className={`group relative block overflow-hidden rounded border text-left transition-colors duration-150 ${
        active
          ? "border-accent bg-accent/5"
          : "border-border bg-surface hover:border-text"
      }`}
    >
      {selectMode && (
        <span
          className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border text-xs font-medium ${
            active
              ? "border-accent bg-accent text-on-accent"
              : "border-border bg-surface/90 text-transparent"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
            <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}

      {/* Publishing Permission Badge */}
      {!selectMode && (
        <div className="absolute left-2 top-2 z-10">
          {asset.publish_permission === "granted" ? (
            <span
              className="flex h-5 items-center rounded-full border border-accent/25 bg-surface px-2 text-xs font-medium text-text"
              title="Permission granted — approved for marketing and publishing"
            >
              Granted
            </span>
          ) : asset.publish_permission === "restricted" ? (
            <span
              className="flex h-5 items-center rounded-full border border-danger/25 bg-surface px-2 text-xs font-medium text-danger"
              title="Internal only — strictly confidential, do not publish"
            >
              Internal
            </span>
          ) : (
            <span
              className="flex h-5 items-center rounded-full border border-border bg-surface px-2 text-xs font-medium text-muted"
              title="Pending permission — awaiting clearance"
            >
              Pending
            </span>
          )}
        </div>
      )}

      {/* Quick Find Similar on hover */}
      {!selectMode && onFindSimilar && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onFindSimilar(asset);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              onFindSimilar(asset);
            }
          }}
          title="Find similar images"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface/95 text-muted opacity-0 transition-colors hover:border-text hover:text-text group-hover:opacity-100"
        >
          {isSearchingSimilar ? (
            <div className="h-4 w-4 animate-spin rounded-full border border-accent border-t-transparent" />
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-4 w-4"
            >
              <path
                d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="13" r="4" />
            </svg>
          )}
        </span>
      )}

      <div className="relative aspect-square bg-bg overflow-hidden">
        <div className="absolute inset-0 flex flex-col items-center justify-center text-xs text-muted p-2 text-center">
          {asset.mime_type === "application/pdf" || asset.name.toLowerCase().endsWith(".pdf") ? (
            <div className="flex flex-col items-center justify-center text-muted">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 mb-1">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-xs font-medium text-muted">PDF document</span>
            </div>
          ) : (
            "No preview"
          )}
        </div>
        {/* Served via /api/thumbnail */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/thumbnail?id=${asset.drive_file_id}&folder=${asset.folder_id}`}
          alt={asset.name}
          loading="lazy"
          decoding="async"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          className="relative h-full w-full object-cover"
        />
        {(asset.mime_type === "application/pdf" || asset.name.toLowerCase().endsWith(".pdf")) && (
          <span className="absolute bottom-2 left-2 z-10 rounded border border-border bg-surface px-2 py-0.5 text-xs font-medium text-muted">
            PDF
          </span>
        )}
        {(asset.mime_type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(asset.name)) && (
          <span className="absolute bottom-2 left-2 z-10 rounded border border-border bg-surface px-2 py-0.5 text-xs font-medium text-muted">
            Video
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-1">
          <p className="truncate text-xs font-medium text-text flex-1">{asset.name}</p>
          {similarityScore !== undefined && (
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium shrink-0 leading-none ${
                similarityScore >= 100
                  ? "border-accent bg-accent/5 text-text"
                  : similarityScore >= 85
                  ? "border-accent/25 bg-accent/5 text-text"
                  : "border-border bg-bg text-muted"
              }`}
            >
              {similarityScore >= 100 ? "100% exact" : `${similarityScore}%`}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs text-muted">
          {asset.core_sector || asset.macro_portfolio ? (
            <span className="badge-status badge-management truncate max-w-[130px]">
              <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
              {[asset.macro_portfolio, asset.core_sector]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : (
            <span className="badge-status bg-bg border border-border text-muted truncate">
              <span className="h-2 w-2 rounded-full bg-muted shrink-0" />
              General
            </span>
          )}
          <span className="text-xs text-muted shrink-0 font-medium">
            {formatBytes(asset.size_bytes)}
          </span>
        </div>
      </div>
    </button>
  );
});

// Name, classification, tags, folder, size/date and the Drive link for one
// asset — rendered identically in the right-hand preview pane and in the
// full-screen overlay's details panel.
function AssetDetails({
  asset,
  onFindSimilar,
  isSearchingSimilar,
  onPermissionChange,
  readOnly,
}: {
  asset: DamAsset;
  onFindSimilar?: (asset: DamAsset) => void;
  isSearchingSimilar?: boolean;
  onPermissionChange?: (assetId: string, permission: PublishPermission) => Promise<void>;
  // The project library preview: the permission is shown as text, and the
  // links that only resolve v1 ids (Open PDF, download by id) are swapped out.
  readOnly?: boolean;
}) {
  const [updatingPermission, setUpdatingPermission] = useState(false);
  const simAsset = asset as VisualSearchResult;

  const handlePermissionSelect = async (perm: PublishPermission) => {
    if (perm === asset.publish_permission || updatingPermission) return;
    setUpdatingPermission(true);
    try {
      if (onPermissionChange) {
        await onPermissionChange(asset.id, perm);
      }
    } finally {
      setUpdatingPermission(false);
    }
  };

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="break-all text-sm font-medium text-text flex-1">{asset.name}</p>
        {simAsset.similarityScore !== undefined && (
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium shrink-0 ${
              simAsset.similarityScore >= 100
                ? "border-accent bg-accent/5 text-text"
                : simAsset.similarityScore >= 85
                ? "border-accent/25 bg-accent/5 text-text"
                : "border-border bg-bg text-muted"
            }`}
          >
            {simAsset.similarityScore >= 100
              ? "100% exact match"
              : `${simAsset.similarityScore}% match`}
          </span>
        )}
      </div>

      {simAsset.matchReasons && simAsset.matchReasons.length > 0 && (
        <div className="mt-4 rounded border border-border bg-surface p-4 text-sm text-text">
          <p className="mb-3 text-sm font-medium text-text">
            Visual similarity
          </p>
          <ul className="space-y-1 text-sm text-muted">
            {simAsset.matchReasons.map((r, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="h-1 w-1 rounded-full bg-accent shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Interactive Publishing Permission Control */}
      <div className="mt-4 rounded border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">
            Publishing permission
          </span>
          {updatingPermission && (
            <span className="text-xs font-medium text-muted">
              Saving
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          Legal and client clearance to publish externally.
        </p>
        {readOnly ? (
          <p className="mt-3 text-sm text-text">
            {asset.publish_permission === "granted"
              ? "Granted"
              : asset.publish_permission === "restricted"
              ? "Internal only"
              : "Pending"}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={updatingPermission}
              onClick={() => void handlePermissionSelect("granted")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                asset.publish_permission === "granted"
                  ? "bg-text text-surface"
                  : "border border-border text-muted hover:text-text"
              }`}
              title="Permission granted — approved for marketing, website, social and PR"
            >
              Granted
            </button>
            <button
              type="button"
              disabled={updatingPermission}
              onClick={() => void handlePermissionSelect("pending")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                asset.publish_permission === "pending" || !asset.publish_permission
                  ? "bg-text text-surface"
                  : "border border-border text-muted hover:text-text"
              }`}
              title="Pending permission — awaiting release or confirmation"
            >
              Pending
            </button>
            <button
              type="button"
              disabled={updatingPermission}
              onClick={() => void handlePermissionSelect("restricted")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                asset.publish_permission === "restricted"
                  ? "bg-text text-surface"
                  : "border border-border text-muted hover:text-text"
              }`}
              title="Internal only — strictly confidential, do not publish"
            >
              Internal only
            </button>
          </div>
        )}
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        {asset.macro_portfolio && (
          <div>
            <dt className="text-xs font-medium text-muted">
              Classification
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {[asset.macro_portfolio, asset.core_sector]
                .filter(Boolean)
                .map((v) => (
                  <span
                    key={v as string}
                    className="rounded-full border border-accent/25 bg-accent/5 px-2 py-0.5 text-xs font-medium text-text"
                  >
                    {v}
                  </span>
                ))}
              {asset.sub_sectors?.map((s) => (
                <span
                  key={s}
                  className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted"
                >
                  {s}
                </span>
              ))}
            </dd>
          </div>
        )}
        {asset.tags.length > 0 && (
          <div>
            <dt className="text-xs font-medium text-muted">
              Tags
            </dt>
            <dd className="mt-1 text-sm text-muted">
              #{asset.tags.join(" #")}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs font-medium text-muted">
            Folder
          </dt>
          <dd className="mt-1 break-all text-muted">
            {asset.folder_path || "—"}
          </dd>
        </div>
        <div className="flex gap-6">
          <div>
            <dt className="text-xs font-medium text-muted">
              Size
            </dt>
            <dd className="mt-1 text-muted">{formatBytes(asset.size_bytes)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted">
              Uploaded
            </dt>
            <dd className="mt-1 text-muted">
              {new Date(asset.created_at).toLocaleDateString()}
            </dd>
          </div>
        </div>
      </dl>

      <div className="mt-4 space-y-2">
        {onFindSimilar && (
          <button
            type="button"
            onClick={() => onFindSimilar(asset)}
            disabled={isSearchingSimilar}
            className="flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:opacity-50 disabled:pointer-events-none"
          >
            {isSearchingSimilar ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border border-accent border-t-transparent" />
                <span>Searching similar images</span>
              </>
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <path
                    d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span>Find similar images</span>
              </>
            )}
          </button>
        )}

        {!readOnly && (asset.mime_type === "application/pdf" || asset.name.toLowerCase().endsWith(".pdf")) && (
          <a
            href={`/api/v1/assets/${asset.id}/image`}
            target="_blank"
            rel="noreferrer"
            className="flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>Open PDF in new tab</span>
          </a>
        )}

        <a
          href={downloadHref(asset, !!readOnly)}
          download={asset.name}
          className="flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-4 w-4 text-muted"
          >
            <path
              d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points="7 10 12 15 17 10"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="12"
              y1="15"
              x2="12"
              y2="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Download original</span>
        </a>

        {/* A project-library asset stored outside Drive has no Drive link. */}
        {(!readOnly || asset.web_view_link) && (
          <a
            href={asset.web_view_link}
            target="_blank"
            rel="noreferrer"
            className="block rounded border border-border bg-surface px-3 py-2 text-center text-sm font-medium text-text transition-colors hover:bg-bg"
          >
            Open in Drive
          </a>
        )}
      </div>
    </>
  );
}

export default function BrowsePage() {
  // Raw server rows for the current query; the displayed list is derived from
  // them below so client-side toggles don't need a refetch.
  const [rawAssets, setRawAssets] = useState<DamAsset[]>([]);
  // How many assets the current query matches in total, which is more than
  // rawAssets whenever the match is bigger than one page.
  const [rawTotal, setRawTotal] = useState(0);
  const [allTags, setAllTags] = useState<TagCount[]>(() => tagsCache ?? []);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [taxonomy, setTaxonomy] = useState<TaxonomySelection>(EMPTY_FILTER);
  const [search, setSearch] = useState("");
  // Typing shouldn't fire a request per keystroke — but a folder click should
  // fire immediately, which is why the debounce lives on the search text only.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // loading = nothing to show yet. revalidating = showing something while a
  // fresher answer is on the way (the grid dims instead of going blank).
  const [loading, setLoading] = useState(true);
  const [revalidating, setRevalidating] = useState(false);
  const [paths, setPaths] = useState<string[]>(() => pathsCache ?? []);
  const [currentPath, setCurrentPath] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeFilter, setTreeFilter] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [permissionFilter, setPermissionFilter] = useState<string>("");
  const [mediaTypeFilter, setMediaTypeFilter] = useState<string>("");
  // A studio id from lib/studios.ts, or "" for every studio. Applied on the
  // SERVER (see assetQuery): the location folders hold thousands of assets
  // each and the query is capped at `limit`, so filtering the returned page
  // client-side would only ever search inside the newest 60 rows.
  const [studioFilter, setStudioFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // When Home is open, users can choose which Shared Drive receives the new
  // folder instead of having to drill into that drive before the action works.
  const [newFolderParentPath, setNewFolderParentPath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // The folder the inline form just made, for the "Created X · Open" note.
  const [justCreated, setJustCreated] = useState<{
    name: string;
    path: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [pathsError, setPathsError] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedFolderPaths, setSelectedFolderPaths] = useState<Set<string>>(new Set());
  const [loadingFolderSelection, setLoadingFolderSelection] = useState(false);
  const folderAssetMapRef = useRef<Map<string, string[]>>(new Map());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [batchUpdatingPermission, setBatchUpdatingPermission] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagStatus, setAutoTagStatus] = useState<string | null>(null);
  const autoTagCancelRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const [slidesName, setSlidesName] = useState("");
  const [slidesLayout, setSlidesLayout] = useState<SlideLayout>("contain");
  const [slidesCaptions, setSlidesCaptions] = useState(true);
  const [slidesBusy, setSlidesBusy] = useState(false);
  const [slidesError, setSlidesError] = useState<string | null>(null);
  const [slidesResult, setSlidesResult] = useState<SlidesExport | null>(null);
  // Which library the grid reads (see the /api/v2/status effect below). Every
  // change goes through switchSource, which keeps sourceRef in step.
  const [v2Mode, setV2Mode] = useState<V2Mode>(() => v2ModeCache ?? "off");
  const [source, setSource] = useState<LibrarySource>(() =>
    pickSource(v2ModeCache ?? "off", null)
  );
  const sourceRef = useRef<LibrarySource>(source);
  const [v2Error, setV2Error] = useState<string | null>(null);
  // The project library is a read-only preview: every control that writes,
  // deletes, uploads or looks a v1 id up is hidden while it is shown.
  const readOnly = source === "v2";

  // Update publishing permission for a single asset (optimistic + persistent)
  const handleUpdateAssetPermission = useCallback(
    async (assetId: string, permission: PublishPermission) => {
      setRawAssets((prev) =>
        prev.map((a) =>
          a.id === assetId ? { ...a, publish_permission: permission } : a
        )
      );
      setVisualResults((prev) =>
        prev.map((a) =>
          a.id === assetId ? { ...a, publish_permission: permission } : a
        )
      );

      try {
        const res = await fetch("/api/assets/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: assetId, publishPermission: permission }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || "Failed to update permission.");
        }
      } catch (err) {
        console.error("Failed to update asset permission:", err);
        setRefreshKey((k) => k + 1);
      }
    },
    []
  );

  // Update publishing permission for all selected assets in batch
  const handleBatchUpdatePermission = useCallback(
    async (permission: PublishPermission) => {
      if (selectedIds.size === 0 || batchUpdatingPermission) return;
      const ids = Array.from(selectedIds);
      setBatchUpdatingPermission(true);

      setRawAssets((prev) =>
        prev.map((a) =>
          selectedIds.has(a.id)
            ? { ...a, publish_permission: permission }
            : a
        )
      );
      setVisualResults((prev) =>
        prev.map((a) =>
          selectedIds.has(a.id)
            ? { ...a, publish_permission: permission }
            : a
        )
      );

      try {
        const res = await fetch("/api/assets/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, publishPermission: permission }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || "Failed to update batch permissions.");
        }
      } catch (err) {
        console.error("Batch permission update failed:", err);
        setRefreshKey((k) => k + 1);
      } finally {
        setBatchUpdatingPermission(false);
      }
    },
    [selectedIds, batchUpdatingPermission]
  );

  // Visual / Reverse Image Search state
  const [visualSearchModalOpen, setVisualSearchModalOpen] = useState(false);
  const [visualSearchActive, setVisualSearchActive] = useState(false);
  const [visualSummary, setVisualSummary] =
    useState<VisualSearchSummary | null>(null);
  const [visualQueryPreviewUrl, setVisualQueryPreviewUrl] = useState<
    string | null
  >(null);
  const [visualResults, setVisualResults] = useState<VisualSearchResult[]>([]);
  const [visualSearchingAssetId, setVisualSearchingAssetId] = useState<
    string | null
  >(null);
  const [visualSearchError, setVisualSearchError] = useState<string | null>(
    null
  );

  const handleVisualSearchComplete = useCallback(
    (response: VisualSearchResponse, queryPreviewUrl: string) => {
      setVisualSummary(response.querySummary);
      setVisualResults(response.results);
      setVisualQueryPreviewUrl(queryPreviewUrl);
      setVisualSearchActive(true);
      setSelectedId(null);
      setSelectedIds(new Set());
    },
    []
  );

  const handleFindSimilar = useCallback(async (asset: DamAsset) => {
    setVisualSearchingAssetId(asset.id);
    setVisualSearchError(null);
    setVisualQueryPreviewUrl(
      `/api/thumbnail?id=${asset.drive_file_id}&folder=${asset.folder_id}&size=800`
    );

    try {
      const res = await fetch("/api/visual-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: asset.id }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Could not find similar images.");
      }
      setVisualSummary(data.querySummary);
      setVisualResults(data.results);
      setVisualSearchActive(true);
      setSelectedId(null);
      setSelectedIds(new Set());
    } catch (err) {
      setVisualSearchError(
        err instanceof Error ? err.message : "Failed to find similar images."
      );
    } finally {
      setVisualSearchingAssetId(null);
    }
  }, []);

  const clearVisualSearch = useCallback(() => {
    setVisualSearchActive(false);
    setVisualSummary(null);
    setVisualResults([]);
    setVisualQueryPreviewUrl(null);
    setVisualSearchingAssetId(null);
    setVisualSearchError(null);
  }, []);

  // Direct folder upload state
  const [directUploadOpen, setDirectUploadOpen] = useState(false);
  const [droppedUploadFiles, setDroppedUploadFiles] = useState<File[] | null>(
    null
  );
  const [dragOverGrid, setDragOverGrid] = useState(false);

  // Changing library drops everything that holds the other library's ids or
  // belongs to a write flow, in the same render, so no bulk action or
  // selection survives into the read-only preview.
  const switchSource = useCallback(
    (next: LibrarySource) => {
      sourceRef.current = next;
      setSource(next);
      setV2Error(null);
      setSelectedId(null);
      setFullscreen(false);
      setSelectMode(false);
      setSelectedIds(new Set());
      setSelectedFolderPaths(new Set());
      setSlidesOpen(false);
      setCreatingFolder(false);
      setDragOverGrid(false);
      setVisualSearchModalOpen(false);
      clearVisualSearch();
    },
    [clearVisualSearch]
  );

  const chooseSource = useCallback(
    (next: LibrarySource) => {
      librarySourceChoice = next;
      switchSource(next);
    },
    [switchSource]
  );

  // Which library to show. /api/v2/status reports the server's DAM_V2_BROWSE
  // switch; "off", an error or no route at all means the current library and
  // no toggle, so with v2 off this page is unchanged apart from this request.
  // ?source=v1|v2 is read from window.location rather than useSearchParams,
  // which would need a Suspense boundary in this prerendered page.
  useEffect(() => {
    let cancelled = false;
    const override = new URLSearchParams(window.location.search).get("source");
    const apply = (mode: V2Mode) => {
      setV2Mode(mode);
      const next = pickSource(mode, override);
      if (next !== sourceRef.current) switchSource(next);
    };
    if (v2ModeCache) apply(v2ModeCache);
    fetch("/api/v2/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const mode = parseV2Mode(data);
        v2ModeCache = mode;
        if (mode === "off") librarySourceChoice = null;
        apply(mode);
      })
      .catch(() => undefined); // no answer: stay on the library already shown
    return () => {
      cancelled = true;
    };
  }, [switchSource]);

  const tree = useMemo(() => buildTree(paths), [paths]);
  const currentNode = useMemo(
    () => findNode(tree, currentPath),
    [tree, currentPath]
  );
  const childFolders = currentNode?.children ?? [];
  // The immediate children of Home are Shared Drive roots, because every
  // folder path starts with its Drive name.
  const sharedDrives = tree.children;

  const hasTaxonomyFilter =
    !!taxonomy.macro_portfolio ||
    !!taxonomy.core_sector ||
    taxonomy.sub_sectors.length > 0;
  // untaggedOnly is deliberately NOT here: it's applied client-side, so it must
  // not change which query we send (see the derived `assets` below).
  const filtersActive =
    hasTaxonomyFilter ||
    activeTags.length > 0 ||
    !!debouncedSearch ||
    !!permissionFilter ||
    !!mediaTypeFilter ||
    !!studioFilter;

  // Only the studios that actually have a folder in the tree, so picking one
  // can't come back empty. Falls back to the full list while the tree is
  // still loading or if /api/paths failed — which means the list can narrow
  // once the tree arrives, so whatever is selected is kept in it rather than
  // leaving the <select> showing a blank value.
  const studioOptions = useMemo(() => {
    const present = studiosPresentIn(paths);
    if (!studioFilter || present.some((s) => s.id === studioFilter)) {
      return present;
    }
    const selected = studioById(studioFilter);
    return selected ? [...present, selected] : present;
  }, [paths, studioFilter]);

  // Folder paths for the tree. On a transient Drive failure, keep the
  // last-good tree (don't clobber to empty) and flag it for a retry banner.
  useEffect(() => {
    let cancelled = false;
    // refreshKey busts the browser cache — the response is cacheable for a
    // minute so ordinary navigation reuses it, but an explicit Refresh (or a
    // folder create) must see the new tree.
    const url = refreshKey ? `/api/paths?r=${refreshKey}` : "/api/paths";
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error || !Array.isArray(data.paths)) {
          setPathsError(true);
        } else {
          setPathsError(false);
          // Patched with folders this tab just created/deleted: the response
          // may be a browser-cached copy, or from an instance that hasn't
          // polled Drive's change feed yet.
          const merged = applyRecentFolderChanges(data.paths as string[]);
          pathsCache = merged;
          setPaths(merged);
        }
      })
      .catch(() => {
        if (!cancelled) setPathsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Tag chips. These only exist inside the Filters panel, and counting them
  // reads the tags column of every asset in the library — so don't pay for it
  // until the panel is actually opened. Previously this ran on every mount and
  // added seconds to the first paint of /browse.
  // The counts are the current library's, so the project library skips them.
  useEffect(() => {
    if (!showFilters || source === "v2") return;
    let cancelled = false;
    fetch("/api/tags")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.tags)) return;
        tagsCache = data.tags;
        setAllTags(data.tags);
      })
      .catch(() => undefined); // keep whatever chips we already had
    return () => {
      cancelled = true;
    };
  }, [showFilters, refreshKey, source]);

  // Debounce the search box only. Folder clicks, sort changes and filter chips
  // used to be delayed by the same 200ms timer, which made every click feel
  // laggy for no reason.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // The exact /api/assets query for the current folder + filters. Memoised so
  // the fetch below re-runs when the QUERY changes, not whenever a render
  // recreates an array or a boolean.
  // Default: current folder only. With search/filters: the whole subtree.
  const assetQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (activeTags.length) params.set("tags", activeTags.join(","));
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (taxonomy.macro_portfolio) params.set("macro", taxonomy.macro_portfolio);
    if (taxonomy.core_sector) params.set("core", taxonomy.core_sector);
    if (taxonomy.sub_sectors.length)
      params.set("sub", taxonomy.sub_sectors.join(","));
    if (studioFilter) params.set("studio", studioFilter);
    params.set("sort", sort);
    params.set("limit", String(ASSET_PAGE_SIZE));
    // Root with no filters means "everything", i.e. no path param at all.
    if (currentPath) {
      params.set(filtersActive ? "pathPrefix" : "path", currentPath);
    }
    return params.toString();
  }, [
    activeTags,
    debouncedSearch,
    taxonomy.macro_portfolio,
    taxonomy.core_sector,
    taxonomy.sub_sectors,
    studioFilter,
    currentPath,
    sort,
    filtersActive,
  ]);

  // Assets, stale-while-revalidate: a query we've already answered paints from
  // the client cache on the same tick, so clicking back into a folder is
  // instant and the grid never blanks out while the refetch lands.
  useEffect(() => {
    let cancelled = false;
    // refreshKey participates in the key so an explicit Refresh invalidates
    // every cached page at once, while caching keeps working after it. The
    // source does too, so one library's rows are never painted for the other
    // (a v1 key is unchanged; no query string starts with "v2|").
    const queryKey = source === "v2" ? `v2|${assetQuery}` : assetQuery;
    const cacheKey = refreshKey ? `${refreshKey}|${queryKey}` : queryKey;
    const cached = assetCache.get(cacheKey);
    if (cached) {
      setRawAssets(cached.rows);
      setRawTotal(cached.total);
      setLoading(false);
    } else {
      setRawAssets([]);
      setRawTotal(0);
      setLoading(true);
    }
    setRevalidating(true);

    const request: Promise<{ assets?: DamAsset[]; total?: number }> =
      source === "v2"
        ? fetchV2Assets(assetQuery)
        : fetch(`/api/assets?${assetQuery}`).then((r) => r.json());
    request
      .then((data) => {
        if (cancelled) return;
        const rows: DamAsset[] = data.assets ?? [];
        // Older cached responses (and an error payload) carry no total —
        // fall back to the row count, which makes the grid say nothing about
        // truncation rather than something wrong.
        const total = typeof data.total === "number" ? data.total : rows.length;
        rememberAssets(cacheKey, rows, total);
        setRawAssets(rows);
        setRawTotal(total);
        if (source === "v2") setV2Error(null);
      })
      .catch((err) => {
        // Keep the cached rows on a transient failure rather than blanking.
        if (!cancelled && !cached) {
          setRawAssets([]);
          setRawTotal(0);
        }
        if (cancelled || !(err instanceof V2LoadError)) return;
        if (err.status === 404) {
          // v2 was switched off under this tab (the route answers 404 then),
          // or the route is missing: back to the current library, no toggle.
          v2ModeCache = "off";
          librarySourceChoice = null;
          setV2Mode("off");
          switchSource("v1");
        } else {
          setV2Error(v2ErrorMessage(err));
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRevalidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [assetQuery, refreshKey, source, switchSource]);

  // What the grid actually shows. Both refinements are pure client-side work on
  // the rows we already have, so toggling "untagged only" is instant instead of
  // being another round trip.
  const assets = useMemo(() => {
    if (visualSearchActive) {
      let rows: DamAsset[] = visualResults;
      if (taxonomy.macro_portfolio) {
        rows = rows.filter(
          (a) => a.macro_portfolio === taxonomy.macro_portfolio
        );
      }
      if (taxonomy.core_sector) {
        rows = rows.filter((a) => a.core_sector === taxonomy.core_sector);
      }
      // Visual-search hits come back from the image model, not from the SQL
      // query, so the studio filter has to be applied here too.
      // studioForPath mirrors the server's folder matching exactly.
      if (studioFilter) {
        rows = rows.filter(
          (a) => studioForPath(a.folder_path)?.id === studioFilter
        );
      }
      if (permissionFilter) {
        rows = rows.filter(
          (a) => (a.publish_permission || "pending") === permissionFilter
        );
      }
      if (mediaTypeFilter) {
        rows = rows.filter((a) => {
          const isPdf =
            a.mime_type === "application/pdf" ||
            a.name.toLowerCase().endsWith(".pdf");
          const isVideo =
            a.mime_type.startsWith("video/") ||
            /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name);
          if (mediaTypeFilter === "pdf") return isPdf;
          if (mediaTypeFilter === "video") return isVideo;
          if (mediaTypeFilter === "image") return !isPdf && !isVideo;
          return true;
        });
      }
      if (debouncedSearch) {
        const q = debouncedSearch.toLowerCase();
        rows = rows.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.tags.some((t) => t.toLowerCase().includes(q)) ||
            (a.folder_path && a.folder_path.toLowerCase().includes(q))
        );
      }
      return rows;
    }

    let rows = rawAssets;
    // Refine prefix matches: "ProjectX" must not match "ProjectXtra".
    if (filtersActive && currentPath) {
      rows = rows.filter(
        (a) =>
          a.folder_path === currentPath ||
          a.folder_path.startsWith(`${currentPath}/`)
      );
    }
    if (permissionFilter) {
      rows = rows.filter(
        (a) => (a.publish_permission || "pending") === permissionFilter
      );
    }
    if (mediaTypeFilter) {
      rows = rows.filter((a) => {
        const isPdf =
          a.mime_type === "application/pdf" ||
          a.name.toLowerCase().endsWith(".pdf");
        const isVideo =
          a.mime_type.startsWith("video/") ||
          /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(a.name);
        if (mediaTypeFilter === "pdf") return isPdf;
        if (mediaTypeFilter === "video") return isVideo;
        if (mediaTypeFilter === "image") return !isPdf && !isVideo;
        return true;
      });
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
    return rows;
  }, [
    visualSearchActive,
    visualResults,
    taxonomy.macro_portfolio,
    taxonomy.core_sector,
    permissionFilter,
    mediaTypeFilter,
    studioFilter,
    debouncedSearch,
    rawAssets,
    filtersActive,
    currentPath,
    untaggedOnly,
  ]);

  const currentIndex = useMemo(() => {
    if (!selectedId || assets.length === 0) return -1;
    return assets.findIndex((a) => a.id === selectedId);
  }, [selectedId, assets]);

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < assets.length - 1;

  const goToPrev = useCallback(() => {
    if (currentIndex > 0) {
      setSelectedId(assets[currentIndex - 1].id);
    }
  }, [currentIndex, assets]);

  const goToNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < assets.length - 1) {
      setSelectedId(assets[currentIndex + 1].id);
    }
  }, [currentIndex, assets]);

  // Full-screen and keyboard navigation: Esc to exit, ArrowLeft/ArrowRight to browse.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(false);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, goToPrev, goToNext]);

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const selectPath = useCallback((path: string) => {
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
  }, []);

  // useCallback so the memo'd Tree above isn't invalidated on every render.
  const toggleNode = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Toggle selection of an entire folder (and all its nested asset IDs)
  const toggleSelectFolder = useCallback(
    async (folderPath: string) => {
      if (!folderPath) return;

      if (selectedFolderPaths.has(folderPath)) {
        // Deselect folder: remove folderPath and remove any cached assets belonging to it
        const cachedIds = folderAssetMapRef.current.get(folderPath) || [];
        setSelectedFolderPaths((prev) => {
          const next = new Set(prev);
          next.delete(folderPath);
          return next;
        });
        if (cachedIds.length > 0) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            cachedIds.forEach((id) => next.delete(id));
            return next;
          });
        }
        return;
      }

      // Select folder: mark folder as selected, then fetch all nested assets
      setSelectedFolderPaths((prev) => new Set(prev).add(folderPath));
      setLoadingFolderSelection(true);
      try {
        let ids = folderAssetMapRef.current.get(folderPath);
        if (!ids) {
          const res = await fetch(
            `/api/folders/assets?path=${encodeURIComponent(folderPath)}&recursive=true`
          );
          const data = await res.json();
          if (res.ok && Array.isArray(data.assetIds)) {
            const fetchedIds: string[] = data.assetIds;
            ids = fetchedIds;
            folderAssetMapRef.current.set(folderPath, fetchedIds);
          }
        }

        if (ids && ids.length > 0) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            ids!.forEach((id) => next.add(id));
            return next;
          });
        }
      } catch (err) {
        console.error("Failed to resolve assets for folder selection:", err);
      } finally {
        setLoadingFolderSelection(false);
      }
    },
    [selectedFolderPaths]
  );

  // Select all assets in current folder and all its nested subfolders
  const handleSelectEntireHierarchy = useCallback(
    async (recursive = true) => {
      setLoadingFolderSelection(true);
      try {
        const url = currentPath
          ? `/api/folders/assets?path=${encodeURIComponent(currentPath)}&recursive=${recursive}`
          : `/api/folders/assets?all=1&limit=5000`;
        const res = await fetch(url);
        const data = await res.json();
        if (res.ok && Array.isArray(data.assetIds)) {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            data.assetIds.forEach((id: string) => next.add(id));
            return next;
          });
          if (currentPath) {
            setSelectedFolderPaths((prev) => new Set(prev).add(currentPath));
          }
        }
      } catch (err) {
        console.error("Failed to select all folder assets:", err);
      } finally {
        setLoadingFolderSelection(false);
      }
    },
    [currentPath]
  );

  const downloadSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    for (const id of ids.slice(0, 30)) {
      const link = document.createElement("a");
      link.href = `/api/assets/download?id=${encodeURIComponent(id)}`;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      await new Promise((r) => setTimeout(r, 250));
    }
  }, [selectedIds]);

  // What clicking a tile does, as one stable callback so the memo'd tiles
  // aren't invalidated on every render.
  const pickAsset = useCallback(
    (id: string) => {
      if (selectMode) toggleSelected(id);
      else setSelectedId((prev) => (prev === id ? null : id));
    },
    [selectMode, toggleSelected]
  );

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
      const CHUNK = 50;
      const allGone = new Set<string>();
      let failuresCount = 0;

      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const res = await fetch("/api/assets/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Delete failed.");
        (data.deleted ?? []).forEach((id: string) => allGone.add(id));
        if (data.failures?.length) {
          failuresCount += data.failures.length;
        }
      }

      setRawAssets((prev) => prev.filter((a) => !allGone.has(a.id)));
      assetCache.clear();
      if (selectedId && allGone.has(selectedId)) setSelectedId(null);
      setSelectedIds(new Set());
      setSelectedFolderPaths(new Set());

      if (failuresCount > 0) {
        setDeleteError(
          `${failuresCount} image${
            failuresCount === 1 ? "" : "s"
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
    autoTagCancelRef.current = false;
    setAutoTagging(true);
    setAutoTagStatus("Starting auto-tagging");
    setDeleteError(null);

    let queue = [...ids];
    const total = queue.length;
    let totalTagged = 0;
    let totalDone = 0;
    const BATCH_SIZE = 15;

    try {
      while (queue.length > 0) {
        if (autoTagCancelRef.current) break;

        const batchIds = queue.slice(0, BATCH_SIZE);
        const res = await fetch("/api/autotag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assetIds: batchIds,
            limit: batchIds.length,
            forceAll: true,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Auto-tagging batch failed.");
        }

        const results = Array.isArray(data.results) ? data.results : [];
        const processedIds = new Set(results.map((r: { id: string }) => r.id));

        if (processedIds.size === 0) {
          queue = queue.slice(batchIds.length);
          totalDone += batchIds.length;
        } else {
          queue = queue.filter((id) => !processedIds.has(id));
          totalDone += processedIds.size;
        }

        totalTagged += Number(data.tagged) || 0;

        const lastResult = results.length > 0 ? results[results.length - 1] : null;
        const currentDone = Math.min(totalDone, total);
        const pct = Math.round((currentDone / total) * 100);
        const locInfo = lastResult?.folderPath
          ? ` · ${lastResult.folderPath.split("/").slice(-2).join("/")} (${lastResult.name})`
          : "";
        setAutoTagStatus(
          `Auto-tagging ${currentDone} / ${total} (${pct}%) · ${totalTagged} tagged${locInfo}`
        );
      }

      if (autoTagCancelRef.current) {
        setAutoTagStatus(
          `Auto-tagging stopped: ${totalTagged} image${totalTagged === 1 ? "" : "s"} tagged.`
        );
      } else {
        setAutoTagStatus(
          `Auto-tagged ${totalTagged} of ${total} image${total === 1 ? "" : "s"}.`
        );
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      console.error("Auto-tagging error:", e);
      setDeleteError(
        e instanceof Error ? e.message : "Auto-tagging failed."
      );
    } finally {
      setAutoTagging(false);
      autoTagCancelRef.current = false;
    }
  };

  // Selected assets in the order the grid shows them — that's the slide order,
  // so what you see top-left to bottom-right is what the deck reads like.
  const selectedInGridOrder = () =>
    assets.filter((a) => selectedIds.has(a.id)).map((a) => a.id);

  const openSlidesPanel = () => {
    const leaf = currentPath ? currentPath.split("/").slice(-1)[0] : "";
    const stamp = new Date().toISOString().slice(0, 10);
    setSlidesName(leaf ? `${leaf} — ${stamp}` : `DAM export ${stamp}`);
    setSlidesResult(null);
    setSlidesError(null);
    setSlidesOpen(true);
  };

  // Builds a Google Slides deck with one slide per selected image and hands
  // back a link to it. The images are placed by Google itself, fetching each
  // one from this service, so this takes a couple of seconds per slide.
  const exportToSlides = async () => {
    const ids = selectedInGridOrder();
    if (!ids.length || slidesBusy) return;
    setSlidesBusy(true);
    setSlidesError(null);
    setSlidesResult(null);
    try {
      const res = await fetch("/api/slides/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids,
          name: slidesName.trim() || undefined,
          layout: slidesLayout,
          captions: slidesCaptions,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.presentation) {
        throw new Error(data.error || "Could not create the presentation.");
      }
      setSlidesResult(data.presentation as SlidesExport);
    } catch (e) {
      setSlidesError(
        e instanceof Error ? e.message : "Could not create the presentation."
      );
    } finally {
      setSlidesBusy(false);
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
    const deletedPath = currentPath;
    const goUp = () => {
      // Out of the tree right now, whatever the next /api/paths says.
      noteDeletedPath(deletedPath);
      setPaths((prev) => {
        const next = applyRecentFolderChanges(prev);
        pathsCache = next;
        return next;
      });
      selectPath(segs.slice(0, -1).join("/")); // go up to the parent
      setRefreshKey((k) => k + 1); // reload tree + assets + tag counts
    };
    setFolderBusy(true);
    setFolderError(null);
    try {
      const res = await fetch("/api/folders/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: deletedPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete the folder.");
      goUp();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not delete the folder.";
      setFolderError(message);
      // "No longer exists" means someone already deleted it: same outcome.
      if (/no longer exists/i.test(message)) goUp();
    } finally {
      setFolderBusy(false);
    }
  };

  const openCreateFolder = () => {
    // Make the common one-Shared-Drive case a single click; otherwise the
    // inline form asks the user which drive they mean.
    const parentPath =
      currentPath || (sharedDrives.length === 1 ? sharedDrives[0].path : "");
    setNewFolderParentPath(parentPath);
    setCreatingFolder(true);
    setNewFolderName("");
    setCreateError(null);
    setJustCreated(null);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    const parentPath = currentPath || newFolderParentPath;
    if (!name || !parentPath || creating) return;
    // Cheap client-side pre-check against the folders we already know about.
    const parentNode = findNode(tree, parentPath);
    if (parentNode?.children.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      setCreateError(`A folder named "${name}" already exists here.`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    setJustCreated(null);
    // Show the folder in the tree without waiting for the refetch below — it
    // may come from the browser cache or from an instance that hasn't polled
    // Drive's change feed yet. Always the server's path: Drive matches names
    // case-insensitively, so the real folder may be spelled differently.
    const showInTree = (path: string) => {
      noteCreatedPath(path);
      setPaths((prev) => {
        const next = applyRecentFolderChanges(prev);
        pathsCache = next;
        return next;
      });
      setExpanded((prev) => new Set(prev).add(parentPath));
    };
    try {
      const res = await fetch("/api/folders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.folder) {
        throw new Error(data.error || "Could not create the folder.");
      }
      const folderPath = String(data.folder.path);
      const folderName = String(data.folder.name ?? name);
      showInTree(folderPath);
      if (data.folder.created === false) {
        // Drive already had a folder with this name — don't pretend we made it.
        setCreateError(
          folderName === name
            ? `A folder named "${name}" already exists here.`
            : `A folder named "${folderName}" already exists here (names aren't case-sensitive).`
        );
        return;
      }
      // Stay in the parent — creating several sibling folders in a row is the
      // common case, and jumping into each new one made the next "New folder"
      // nest inside it. The form stays open for the next name.
      setJustCreated({ name: folderName, path: folderPath });
      setNewFolderName("");
      setRefreshKey((k) => k + 1); // reload the Drive tree
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not create folder.";
      setCreateError(message);
      if (/no longer exists/i.test(message)) {
        // The folder we're standing in is gone from Drive: drop it and go up.
        noteDeletedPath(parentPath);
        setPaths((prev) => {
          const next = applyRecentFolderChanges(prev);
          pathsCache = next;
          return next;
        });
        setRefreshKey((k) => k + 1);
        selectPath(parentPath.split("/").slice(0, -1).join("/"));
      }
    } finally {
      setCreating(false);
    }
  };

  const selected = assets.find((a) => a.id === selectedId) ?? null;
  const crumbSegs = currentPath ? currentPath.split("/") : [];

  // Permission, format and "untagged only" are applied to the page we already
  // fetched, not by the server, so once any of them is on, rawTotal counts
  // more rows than the grid is filtering — don't quote it.
  const clientOnlyFacetActive =
    !!permissionFilter || !!mediaTypeFilter || untaggedOnly;
  // A broad filter (any studio, a whole portfolio) matches far more than one
  // page. Saying "60 assets" there reads as "that's all of them", so say
  // which 60 these are.
  const assetsTruncated =
    !visualSearchActive &&
    !clientOnlyFacetActive &&
    rawAssets.length >= ASSET_PAGE_SIZE &&
    rawTotal > assets.length;
  const filterCount =
    (taxonomy.macro_portfolio ? 1 : 0) +
    (taxonomy.core_sector ? 1 : 0) +
    taxonomy.sub_sectors.length +
    activeTags.length +
    (permissionFilter ? 1 : 0) +
    (mediaTypeFilter ? 1 : 0) +
    (studioFilter ? 1 : 0);

  return (
    <AppShell crumb="Assets">
      <div className="flex h-full flex-col overflow-hidden">
        {/* Page header — title, description, one action */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-surface px-8 pb-4 pt-6">
          <div>
            <h1 className="text-lg font-medium text-text">Assets</h1>
            <p className="mt-1 text-sm text-muted">
              Search, filter and export digital media across the dwp studios.
            </p>
            {readOnly && (
              <p className="mt-1 text-xs text-muted">
                Project library preview. Read-only.
                {v2Error && <span className="text-danger"> {v2Error}</span>}
              </p>
            )}
          </div>
          {!readOnly && (
            <button
              type="button"
              onClick={() => {
                setDroppedUploadFiles(null);
                setDirectUploadOpen(true);
              }}
              className="inline-flex shrink-0 items-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              <span>
                {currentPath
                  ? `Upload to ${crumbSegs[crumbSegs.length - 1] || "folder"}`
                  : "Upload files"}
              </span>
            </button>
          )}
        </div>

        {/* Global Search & Filter Card */}
        <div className="shrink-0 border-b border-border bg-bg px-8 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-surface px-4 py-2 focus-within:border-text">
            <div className="flex min-w-[280px] flex-1 items-center gap-2 text-muted">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0 text-muted">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by asset name, tags, folder, taxonomy, dimensions"
                className="w-full bg-transparent text-sm text-text placeholder:text-muted outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-muted transition-colors hover:text-text"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              )}
              {/* Visual search looks up and returns current-library rows. */}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setVisualSearchModalOpen(true)}
                  title="Search by image"
                  aria-label="Search by image"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-4 w-4"
                  >
                    <path
                      d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={taxonomy.macro_portfolio ?? ""}
                onChange={(e) =>
                  setTaxonomy({
                    macro_portfolio: e.target.value || null,
                    core_sector: null,
                    sub_sectors: [],
                  })
                }
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text transition-colors"
              >
                <option value="">All portfolios</option>
                <option value="Architecture">Architecture</option>
                <option value="Interior Design">Interior Design</option>
                <option value="Masterplanning">Masterplanning</option>
              </select>

              <select
                value={taxonomy.core_sector ?? ""}
                onChange={(e) =>
                  setTaxonomy((prev) => ({
                    ...prev,
                    core_sector: e.target.value || null,
                    sub_sectors: [],
                  }))
                }
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text transition-colors"
              >
                <option value="">All sectors</option>
                <option value="Hospitality">Hospitality</option>
                <option value="Commercial">Commercial</option>
                <option value="Residential">Residential</option>
                <option value="Workplace">Workplace</option>
              </select>

              {/* Studio / project location, read off the location folder in
                  each asset's Drive path (see lib/studios.ts). */}
              <select
                value={studioFilter}
                onChange={(e) => setStudioFilter(e.target.value)}
                title="Filter by the dwp studio / project location"
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text transition-colors"
              >
                <option value="">All studios</option>
                {studioOptions.map((studio) => (
                  <option key={studio.id} value={studio.id}>
                    {studioOptionLabel(studio)}
                  </option>
                ))}
              </select>

              <select
                value={permissionFilter}
                onChange={(e) => setPermissionFilter(e.target.value)}
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text transition-colors"
              >
                <option value="">All permissions</option>
                <option value="granted">Permission granted</option>
                <option value="pending">Pending clearance</option>
                <option value="restricted">Internal only</option>
              </select>

              <select
                value={mediaTypeFilter}
                onChange={(e) => setMediaTypeFilter(e.target.value)}
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text transition-colors"
              >
                <option value="">All formats</option>
                <option value="image">Images</option>
                <option value="pdf">PDF documents</option>
                <option value="video">Videos</option>
              </select>

              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text transition-colors"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </div>
          </div>
        </div>

        {/* Workspace: Folder Tree & Grid Pane */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Folder tree */}
          <div className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">
            <div className="p-3 border-b border-border">
              <input
                type="text"
                value={treeFilter}
                onChange={(e) => setTreeFilter(e.target.value)}
                placeholder="Filter folders"
                className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-text transition-colors"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
              {pathsError && tree.children.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted">
                  Couldn&apos;t load folders.{" "}
                  <button
                    type="button"
                    onClick={() => setRefreshKey((k) => k + 1)}
                    className="font-medium text-muted transition-colors hover:text-text"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  {pathsError && (
                    <div className="mb-1 px-2 py-1 text-xs text-muted">
                      Folder list may be out of date.{" "}
                      <button
                        type="button"
                        onClick={() => setRefreshKey((k) => k + 1)}
                        className="font-medium text-muted transition-colors hover:text-text"
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
                    selectMode={selectMode}
                    selectedFolderPaths={selectedFolderPaths}
                    onToggleFolderSelect={toggleSelectFolder}
                  />
                </>
              )}
            </div>
          </div>

          {/* Grid pane */}
          <div className="flex min-w-0 flex-1 flex-col bg-bg">
            {/* Toolbar */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-8 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRefreshKey((k) => k + 1)}
                  aria-label="Refresh"
                  className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-bg hover:text-text transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M4 12a8 8 0 0 1 13.6-5.7L20 8.5M20 12a8 8 0 0 1-13.6 5.7L4 15.5" strokeLinecap="round" />
                    <path d="M20 4v4.5h-4.5M4 20v-4.5h4.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {v2Mode !== "off" && (
                  <LibrarySourceToggle value={source} onChange={chooseSource} />
                )}
                <button
                  type="button"
                  onClick={() => setShowFilters((v) => !v)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    showFilters || filterCount
                      ? "border-text bg-text text-surface"
                      : "border-border bg-surface text-muted hover:text-text"
                  }`}
                >
                  Filters{filterCount ? ` (${filterCount})` : ""}
                </button>
                {/* Select mode is all bulk actions on current-library ids. */}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectMode((v) => !v);
                      setSelectedIds(new Set());
                      setSelectedFolderPaths(new Set());
                      setDeleteError(null);
                      setSlidesOpen(false);
                      setSlidesResult(null);
                      setSlidesError(null);
                    }}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      selectMode
                        ? "border-text bg-text text-surface"
                        : "border-border bg-surface text-muted hover:text-text"
                    }`}
                  >
                    {selectMode ? "Cancel" : "Select"}
                  </button>
                )}
              {selectMode && !readOnly && (
                <>
                  <div className="flex items-center gap-2 rounded border border-border bg-bg px-2 py-1">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedIds(new Set(assets.map((a) => a.id)))
                      }
                      title="Select all images displayed on this page"
                      className="text-xs font-medium text-muted hover:text-text"
                    >
                      Select page ({assets.length})
                    </button>
                    <span className="text-border text-xs">•</span>
                    <button
                      type="button"
                      onClick={() => void handleSelectEntireHierarchy(true)}
                      disabled={loadingFolderSelection}
                      title="Select every file in this folder and all nested subfolders"
                      className="flex items-center gap-2 text-xs font-medium text-muted hover:text-text"
                    >
                      {loadingFolderSelection ? (
                        <span className="inline-block h-4 w-4 animate-spin rounded-full border border-accent border-t-transparent" />
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
                          <path d="m9 13 2 2 4-4" />
                        </svg>
                      )}
                      <span>Select all in folder and subfolders</span>
                    </button>
                  </div>

                  <span className="text-xs font-medium text-muted">
                    {selectedIds.size} file{selectedIds.size === 1 ? "" : "s"} selected
                    {selectedFolderPaths.size > 0 && (
                      <span className="text-muted font-normal">
                        {" "}
                        ({selectedFolderPaths.size} folder{selectedFolderPaths.size === 1 ? "" : "s"})
                      </span>
                    )}
                  </span>

                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedIds(new Set());
                        setSelectedFolderPaths(new Set());
                      }}
                      className="text-xs font-medium text-muted hover:text-text"
                    >
                      Deselect all
                    </button>
                  )}

                  {autoTagging ? (
                    <div className="flex items-center gap-2 rounded-full border border-accent/25 bg-accent/5 px-3 py-1 text-xs text-text">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border border-accent border-t-transparent shrink-0" />
                      <span className="font-medium">{autoTagStatus || "Auto-tagging"}</span>
                      <button
                        type="button"
                        onClick={() => {
                          autoTagCancelRef.current = true;
                        }}
                        title="Stop auto-tagging (all tagged photos are saved)"
                        className="rounded border border-border bg-transparent px-2 py-1 text-xs font-medium text-danger transition-colors hover:border-danger"
                      >
                        Stop
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void autoTagSelected()}
                      disabled={!selectedIds.size || deleting}
                      className="rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-bg disabled:opacity-50 disabled:pointer-events-none"
                    >
                      {`Auto-tag${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => void downloadSelected()}
                    disabled={!selectedIds.size || autoTagging}
                    title="Download selected original photos"
                    className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-bg disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>Download{selectedIds.size ? ` (${selectedIds.size})` : ""}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      slidesOpen ? setSlidesOpen(false) : openSlidesPanel()
                    }
                    disabled={!selectedIds.size || slidesBusy || autoTagging}
                    title="Create a Google Slides deck with one slide per selected image"
                    className={`flex items-center gap-2 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                      slidesOpen
                        ? "border border-accent bg-accent/5 text-text"
                        : "border border-border bg-surface text-text hover:bg-bg"
                    }`}
                  >
                    <SlidesGlyph className="h-4 w-4" />
                    {`Slides${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
                  </button>
                  {/* Batch Set Permission Dropdown */}
                  <div className="relative inline-block">
                    <select
                      disabled={
                        !selectedIds.size ||
                        batchUpdatingPermission ||
                        deleting ||
                        autoTagging
                      }
                      onChange={(e) => {
                        if (e.target.value) {
                          void handleBatchUpdatePermission(
                            e.target.value as PublishPermission
                          );
                          e.target.value = "";
                        }
                      }}
                      defaultValue=""
                      className="cursor-pointer rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text outline-none focus:border-text disabled:opacity-50 disabled:pointer-events-none"
                    >
                      <option value="" disabled>
                        {batchUpdatingPermission
                          ? "Updating permissions"
                          : `Set permission (${selectedIds.size})`}
                      </option>
                      <option value="granted">Set as granted</option>
                      <option value="pending">Set as pending</option>
                      <option value="restricted">Set as internal only</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => void deleteSelected()}
                    disabled={!selectedIds.size || deleting || autoTagging}
                    className="rounded border border-border bg-transparent px-2 py-1 text-xs font-medium text-danger transition-colors hover:border-danger disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {deleting
                      ? "Deleting"
                      : `Delete${selectedIds.size ? ` (${selectedIds.size})` : ""}`}
                  </button>
                  {autoTagStatus && !autoTagging && (
                    <span className="text-xs font-medium text-muted">{autoTagStatus}</span>
                  )}
                  {deleteError && (
                    <span className="text-xs text-danger font-medium">
                      {deleteError.replace(/<[^>]*>?/gm, "")}
                    </span>
                  )}
                </>
              )}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
              className="rounded border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-text"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>

          {/* Visual Search Active Banner */}
          {visualSearchActive && visualSummary && (
            <div className="shrink-0 border-b border-border bg-surface px-8 py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  {visualQueryPreviewUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={visualQueryPreviewUrl}
                      alt="Search query"
                      className="h-14 w-14 rounded object-cover border border-border shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium text-text">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                          <circle cx="11" cy="11" r="8" />
                          <path d="m21 21-4.3-4.3" strokeLinecap="round" />
                        </svg>
                        Reverse image search
                      </span>
                      <span className="text-sm text-muted">
                        • {assets.length} similar image{assets.length === 1 ? "" : "s"} found
                      </span>
                    </div>

                    <p className="mt-1 truncate text-sm text-muted">
                      {visualSummary.visualDescription || visualSummary.spaceType || "Visual match results"}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {visualSummary.macro_portfolio && visualSummary.core_sector && (
                        <span className="rounded-full border border-accent/25 bg-accent/5 px-2 py-0.5 text-xs font-medium text-text">
                          {visualSummary.macro_portfolio} · {visualSummary.core_sector}
                        </span>
                      )}
                      {visualSummary.sub_sectors.slice(0, 3).map((sub) => (
                        <span
                          key={sub}
                          className="rounded-full border border-accent/25 bg-accent/5 px-2 py-0.5 text-xs font-medium text-text"
                        >
                          {sub}
                        </span>
                      ))}
                      {visualSummary.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setVisualSearchModalOpen(true)}
                    className="rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                  >
                    Search by image
                  </button>
                  <button
                    type="button"
                    onClick={clearVisualSearch}
                    className="inline-flex items-center gap-2 rounded bg-transparent px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
                  >
                    <span>Clear visual search</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Google Slides export: one slide per selected image, saved to a
              Drive folder so anyone on the Shared Drive can open it. */}
          {selectMode && slidesOpen && !readOnly && (
            <div className="shrink-0 border-b border-border bg-surface px-8 py-4">
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    Presentation name
                  </span>
                  <input
                    autoFocus
                    type="text"
                    value={slidesName}
                    onChange={(e) => setSlidesName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void exportToSlides();
                      if (e.key === "Escape") setSlidesOpen(false);
                    }}
                    placeholder="Deck name"
                    className="w-64 rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-text"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    Layout
                  </span>
                  <select
                    value={slidesLayout}
                    onChange={(e) => setSlidesLayout(e.target.value as SlideLayout)}
                    className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text"
                  >
                    <option value="contain">Fit — whole image, margin</option>
                    <option value="cover">Fill — full bleed, edges cropped</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 pb-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={slidesCaptions}
                    onChange={(e) => setSlidesCaptions(e.target.checked)}
                    className="accent-accent"
                  />
                  File name as caption
                </label>
                <button
                  type="button"
                  onClick={() => void exportToSlides()}
                  disabled={!selectedIds.size || slidesBusy}
                  className="mb-1 inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:opacity-50 disabled:pointer-events-none"
                >
                  {slidesBusy
                    ? "Building deck"
                    : `Create ${selectedIds.size} slide${
                        selectedIds.size === 1 ? "" : "s"
                      }`}
                </button>
                <button
                  type="button"
                  onClick={() => setSlidesOpen(false)}
                  className="mb-2 inline-flex items-center rounded bg-transparent px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
                >
                  Close
                </button>
              </div>

              {slidesBusy && (
                <p className="mt-2 text-sm text-muted">
                  Google is fetching each image and laying out the deck — around
                  a second or two per slide.
                </p>
              )}
              {slidesError && (
                <p className="mt-2 max-w-3xl text-sm text-danger">{slidesError}</p>
              )}
              {slidesResult && (
                <>
                  <div className="mt-4 flex flex-wrap items-center gap-4 rounded border border-border bg-bg p-4">
                    <span className="text-sm text-muted">
                      <span className="font-medium text-text">
                        {slidesResult.name}
                      </span>{" "}
                      — {slidesResult.slides} slide
                      {slidesResult.slides === 1 ? "" : "s"}, saved in{" "}
                      <span className="text-muted">
                        {slidesResult.folderPath}
                      </span>
                    </span>
                    <a
                      href={slidesResult.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                    >
                      Open in Google Slides
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(slidesResult.url);
                      }}
                      className="bg-transparent text-sm font-medium text-muted transition-colors hover:text-text"
                    >
                      Copy link
                    </button>
                  </div>
                  {slidesResult.failures.length > 0 && (
                    <p className="mt-2 max-w-3xl text-sm text-muted">
                      {slidesResult.failures.length} image
                      {slidesResult.failures.length === 1 ? "" : "s"} couldn&apos;t
                      be placed:{" "}
                      {slidesResult.failures.map((f) => f.name).join(", ")}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Filters */}
          {showFilters && (
            <div className="shrink-0 space-y-4 border-b border-border bg-surface px-8 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-muted">
                    Filter by sector
                  </span>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={untaggedOnly}
                      onChange={(e) => setUntaggedOnly(e.target.checked)}
                      className="accent-accent"
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
                      setPermissionFilter("");
                      // Both of these count towards filterCount, so leaving
                      // them set made "Clear all" leave a filter behind.
                      setMediaTypeFilter("");
                      setStudioFilter("");
                    }}
                    className="bg-transparent text-sm font-medium text-muted transition-colors hover:text-text"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <TaxonomyPicker value={taxonomy} onChange={setTaxonomy} compact />

              {/* Publishing Permission Filter */}
              <div>
                <span className="text-xs font-medium text-muted">
                  Publishing permission
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setPermissionFilter("")}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      permissionFilter === ""
                        ? "bg-text text-surface"
                        : "border border-border text-muted hover:text-text"
                    }`}
                  >
                    All permissions
                  </button>
                  <button
                    type="button"
                    onClick={() => setPermissionFilter("granted")}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      permissionFilter === "granted"
                        ? "bg-text text-surface"
                        : "border border-border text-muted hover:text-text"
                    }`}
                  >
                    Granted
                  </button>
                  <button
                    type="button"
                    onClick={() => setPermissionFilter("pending")}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      permissionFilter === "pending"
                        ? "bg-text text-surface"
                        : "border border-border text-muted hover:text-text"
                    }`}
                  >
                    Pending
                  </button>
                  <button
                    type="button"
                    onClick={() => setPermissionFilter("restricted")}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      permissionFilter === "restricted"
                        ? "bg-text text-surface"
                        : "border border-border text-muted hover:text-text"
                    }`}
                  >
                    Internal only
                  </button>
                </div>
              </div>

              {/* Chip counts are the current library's (/api/tags). */}
              {!readOnly && allTags.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted">
                    Tags
                  </span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {allTags.map(({ tag, count }) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          activeTags.includes(tag)
                            ? "bg-text text-surface"
                            : "border border-border text-muted hover:text-text"
                        }`}
                      >
                        {tag}{" "}
                        <span
                          className={
                            activeTags.includes(tag) ? "" : "text-muted"
                          }
                        >
                          {count}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Path breadcrumb + counts */}
          {!visualSearchActive && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-8 pb-1 pt-3">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
                <button
                  type="button"
                  onClick={() => selectPath("")}
                  className={`hover:text-text ${
                    currentPath ? "text-muted" : "font-medium text-text"
                  }`}
                >
                  Home
                </button>
                {crumbSegs.map((seg, i) => {
                  const p = crumbSegs.slice(0, i + 1).join("/");
                  const last = i === crumbSegs.length - 1;
                  return (
                    <span key={p} className="flex items-center gap-1">
                      <span className="text-muted">/</span>
                      <button
                        type="button"
                        onClick={() => selectPath(p)}
                        className={
                          last
                            ? "font-medium text-text"
                            : "text-muted hover:text-text"
                        }
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted">
                  Showing {childFolders.length} folder
                  {childFolders.length === 1 ? "" : "s"} and{" "}
                  {assetsTruncated ? (
                    <>
                      the first {assets.length} of{" "}
                      <span className="text-text">
                        {rawTotal.toLocaleString()}
                      </span>{" "}
                      assets
                    </>
                  ) : (
                    <>
                      {assets.length} asset{assets.length === 1 ? "" : "s"}
                    </>
                  )}
                </span>
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setDroppedUploadFiles(null);
                        setDirectUploadOpen(true);
                      }}
                      disabled={!currentPath}
                      title={
                        currentPath
                          ? `Upload media directly into ${crumbSegs[crumbSegs.length - 1] || "this folder"}`
                          : "Open a Shared Drive or folder first"
                      }
                      className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="h-4 w-4"
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
                      <span>Upload here</span>
                    </button>
                    <button
                      type="button"
                      onClick={openCreateFolder}
                      disabled={sharedDrives.length === 0}
                      title={
                        sharedDrives.length === 0
                          ? "Loading Shared Drives"
                          : currentPath
                            ? "Create a folder here"
                            : "Create a folder in a Shared Drive"
                      }
                      className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                        <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                      </svg>
                      <span>New folder</span>
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
                      className="flex items-center gap-2 rounded border border-border bg-transparent px-2 py-1 text-xs font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {folderBusy ? "Deleting" : "Delete folder"}
                    </button>
                    {folderError && (
                      <span className="text-xs text-danger">{folderError}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Inline create-folder form */}
          {creatingFolder && !readOnly && (currentPath || sharedDrives.length > 0) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-8 py-3">
              <span className="text-sm text-muted">
                New folder in{" "}
                <span className="text-text">
                  {newFolderParentPath.split("/").slice(-1)[0] ?? "a Shared Drive"}
                </span>
                :
              </span>
              {!currentPath && sharedDrives.length > 1 && (
                <select
                  autoFocus
                  value={newFolderParentPath}
                  onChange={(e) => setNewFolderParentPath(e.target.value)}
                  className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text"
                >
                  <option value="" disabled>
                    Select Shared Drive
                  </option>
                  {sharedDrives.map((drive) => (
                    <option key={drive.path} value={drive.path}>
                      {drive.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                autoFocus={Boolean(currentPath) || sharedDrives.length === 1}
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") setCreatingFolder(false);
                }}
                placeholder="Folder name"
                className="w-56 rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-text"
              />
              <button
                type="button"
                onClick={() => void createFolder()}
                disabled={creating || !newFolderName.trim() || !newFolderParentPath}
                className="rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:opacity-50 disabled:pointer-events-none"
              >
                {creating ? "Creating" : "Create folder"}
              </button>
              <button
                type="button"
                onClick={() => setCreatingFolder(false)}
                className="rounded bg-transparent px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
              >
                Cancel
              </button>
              {createError && (
                <span className="text-sm text-danger">{createError}</span>
              )}
              {!createError &&
                justCreated &&
                justCreated.path === `${newFolderParentPath}/${justCreated.name}` && (
                  <span className="text-sm text-muted">
                    Created{" "}
                    <span className="text-text">{justCreated.name}</span>.{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setCreatingFolder(false);
                        selectPath(justCreated.path);
                      }}
                      className="font-medium text-muted transition-colors hover:text-text"
                    >
                      Open
                    </button>
                  </span>
                )}
            </div>
          )}

          {/* Grid */}
          <div
            onDragOver={(e) => {
              // Not cancelling dragover is what keeps a drop from reaching
              // onDrop, so the read-only preview never opens the uploader.
              if (currentPath && !readOnly) {
                e.preventDefault();
                setDragOverGrid(true);
              }
            }}
            onDragLeave={() => setDragOverGrid(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverGrid(false);
              const files = Array.from(e.dataTransfer.files).filter((f) =>
                f.type.startsWith("image/") ||
                f.type.startsWith("video/") ||
                f.type === "application/pdf" ||
                /\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|m4v|webm|avi|mkv|pdf)$/i.test(
                  f.name
                )
              );
              if (files.length > 0 && !readOnly) {
                setDroppedUploadFiles(files);
                setDirectUploadOpen(true);
              }
            }}
            className="relative min-h-0 flex-1 overflow-y-auto px-8 pb-12 pt-2"
          >
            {dragOverGrid && currentPath && !readOnly && (
              <div className="absolute inset-x-8 inset-y-2 z-30 flex flex-col items-center justify-center rounded border border-dashed border-accent bg-surface p-8 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border text-muted">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-6 w-6"
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
                </div>
                <h3 className="text-base font-medium text-text">
                  Drop to upload directly into{" "}
                  <span className="text-accent">
                    {crumbSegs[crumbSegs.length - 1]}
                  </span>
                </h3>
                <p className="mt-1 max-w-sm text-sm text-muted">
                  Images are classified automatically and organised into this
                  folder.
                </p>
              </div>
            )}

            {!visualSearchActive && childFolders.length > 0 && (
              <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {childFolders.map((f) => {
                  const isFolderSelected = selectedFolderPaths.has(f.path);
                  return (
                    <div
                      key={f.path}
                      onClick={() => {
                        if (selectMode) {
                          void toggleSelectFolder(f.path);
                        } else {
                          selectPath(f.path);
                        }
                      }}
                      className={`group relative flex cursor-pointer items-center justify-between gap-2 rounded border p-4 text-left text-sm transition-colors ${
                        isFolderSelected
                          ? "border-accent bg-accent/5 text-text"
                          : "border-border bg-surface text-text hover:bg-bg"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={isFolderSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              void toggleSelectFolder(f.path);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            title={`Select all files in ${f.name} and subfolders`}
                            className="h-4 w-4 rounded border-border text-accent accent-accent shrink-0 cursor-pointer"
                          />
                        )}
                        <span
                          className={`h-4 w-4 shrink-0 ${
                            isFolderSelected
                              ? "text-accent"
                              : "text-muted group-hover:text-text"
                          }`}
                        >
                          <FolderGlyph className="h-4 w-4" />
                        </span>
                        <span className="truncate font-medium">{f.name}</span>
                      </div>

                      {selectMode ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            selectPath(f.path);
                          }}
                          title="Open this folder"
                          className="shrink-0 rounded bg-transparent px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-text"
                        >
                          Open
                        </button>
                      ) : (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="h-4 w-4 shrink-0 text-muted"
                        >
                          <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* First load of a folder: placeholder tiles in the real grid
                geometry, so the layout doesn't jump when the rows land. */}
            {loading && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div
                    key={i}
                    className="overflow-hidden rounded border border-border bg-surface"
                  >
                    <div className="aspect-square bg-bg" />
                    <div className="p-4">
                      <div className="h-4 w-3/4 rounded bg-bg" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Nothing to show. Which of these is right depends on WHY the
                grid is empty: an empty folder invites an upload, but a folder
                that a filter emptied must not — picking a studio the open
                folder doesn't belong to used to say "This folder is empty" and
                offer to upload into a folder holding hundreds of assets. The
                filter case also has to survive childFolders > 0, which is the
                usual shape once a location folder is open. untaggedOnly is
                deliberately outside `filtersActive` (it never changes the
                query) but it is still a filter as far as this message goes. */}
            {!loading &&
              assets.length === 0 &&
              (visualSearchActive ? (
                <p className="text-sm text-muted">
                  No visually similar assets match these criteria.
                </p>
              ) : filtersActive || untaggedOnly ? (
                <p className="text-sm text-muted">
                  No assets{currentPath ? " in this folder" : ""} match these
                  filters.
                </p>
              ) : childFolders.length > 0 ? null : currentPath ? (
                <div className="my-8 flex flex-col items-center justify-center rounded border border-dashed border-border bg-surface p-12 text-center">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border text-muted">
                    <FolderGlyph className="h-6 w-6" />
                  </div>
                  <h3 className="text-base font-medium text-text">
                    This folder is empty
                  </h3>
                  <p className="mt-1 max-w-sm text-sm text-muted">
                    No digital media has been archived in{" "}
                    <span className="font-medium text-text">
                      {crumbSegs[crumbSegs.length - 1] ?? "this folder"}
                    </span>{" "}
                    yet.
                  </p>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        setDroppedUploadFiles(null);
                        setDirectUploadOpen(true);
                      }}
                      className="mt-4 inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                        <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                      </svg>
                      <span>Upload to this folder</span>
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">No assets here.</p>
              ))}
            {!loading && assets.length > 0 && (
              // Dimmed while a fresher answer is in flight — the previous
              // folder's tiles stay put instead of the grid going blank.
              <div
                className={`grid grid-cols-2 gap-4 transition-opacity duration-150 sm:grid-cols-3 xl:grid-cols-4 ${
                  revalidating ? "opacity-60" : "opacity-100"
                }`}
              >
                {assets.map((asset) => (
                  <AssetTile
                    key={asset.id}
                    asset={asset}
                    active={
                      selectMode
                        ? selectedIds.has(asset.id)
                        : selectedId === asset.id
                    }
                    selectMode={selectMode}
                    onPick={pickAsset}
                    onFindSimilar={readOnly ? undefined : handleFindSimilar}
                    isSearchingSimilar={visualSearchingAssetId === asset.id}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Preview pane */}
        <div className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface xl:flex">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text">Preview</span>
              {selected && currentIndex >= 0 && assets.length > 1 && (
                <span className="text-xs font-normal text-muted">
                  ({currentIndex + 1} of {assets.length})
                </span>
              )}
            </div>
            {selected && (
              <div className="flex items-center gap-1">
                {hasPrev && (
                  <button
                    type="button"
                    onClick={goToPrev}
                    aria-label="Previous image"
                    title="Previous image"
                    className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-4 w-4"
                    >
                      <path
                        d="m15 18-6-6 6-6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {hasNext && (
                  <button
                    type="button"
                    onClick={goToNext}
                    aria-label="Next image"
                    title="Next image"
                    className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-4 w-4"
                    >
                      <path
                        d="m9 18 6-6-6-6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                <a
                  href={downloadHref(selected, readOnly)}
                  download={selected.name}
                  aria-label="Download original image"
                  title="Download original image"
                  className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-4 w-4"
                  >
                    <path
                      d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <polyline
                      points="7 10 12 15 17 10"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <line
                      x1="12"
                      y1="15"
                      x2="12"
                      y2="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
                <button
                  type="button"
                  onClick={() => setFullscreen(true)}
                  aria-label="Full screen"
                  title="Full screen"
                  className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  aria-label="Close preview"
                  className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="h-10 w-10 text-border">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-10 w-10">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="9" cy="10" r="1.7" />
                  <path d="m5 17 4.5-4L13 16l3-2.5L21 17" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <p className="text-sm text-muted">
                Select an item in the grid to preview it
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                title="View full screen"
                className="block w-full cursor-zoom-in overflow-hidden rounded border border-border bg-surface"
              >
                <div className="relative aspect-square bg-bg">
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
                    No preview
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/thumbnail?id=${selected.drive_file_id}&folder=${selected.folder_id}`}
                    alt={selected.name}
                    onError={(e) =>
                      (e.currentTarget.style.visibility = "hidden")
                    }
                    className="relative h-full w-full object-contain"
                  />
                </div>
              </button>
              <div className="mt-4">
                <AssetDetails
                  asset={selected}
                  onFindSimilar={readOnly ? undefined : handleFindSimilar}
                  isSearchingSimilar={visualSearchingAssetId === selected.id}
                  onPermissionChange={readOnly ? undefined : handleUpdateAssetPermission}
                  readOnly={readOnly}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Full-screen preview */}
      {fullscreen && selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Full-screen preview of ${selected.name}`}
          className="fixed inset-0 z-50 flex bg-black/90"
        >
          <div
            className="relative flex min-w-0 flex-1 select-none items-center justify-center p-4 sm:p-8"
            onClick={() => setFullscreen(false)}
          >
            {/* Position indicator badge */}
            {currentIndex >= 0 && assets.length > 1 && (
              <div className="pointer-events-none absolute left-6 top-4 z-20 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-text shadow-menu">
                <span>
                  {currentIndex + 1} / {assets.length}
                </span>
                <span className="text-muted">•</span>
                <span className="max-w-xs truncate text-muted">
                  {selected.name}
                </span>
              </div>
            )}

            {/* Top-right Floating Action Bar: Download Image button */}
            <div className="absolute right-6 top-4 z-20 flex items-center gap-2">
              {!readOnly && (selected.mime_type === "application/pdf" ||
                selected.name.toLowerCase().endsWith(".pdf")) && (
                <a
                  href={`/api/v1/assets/${selected.id}/image`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={`Open ${selected.name} in new tab`}
                  aria-label={`Open ${selected.name} in new tab`}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm font-medium text-text shadow-menu transition-colors hover:bg-bg"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-4 w-4"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span>Open PDF</span>
                </a>
              )}
              <a
                href={downloadHref(selected, readOnly)}
                download={selected.name}
                onClick={(e) => e.stopPropagation()}
                title={`Download ${selected.name}`}
                aria-label={`Download ${selected.name}`}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm font-medium text-text shadow-menu transition-colors hover:bg-bg"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <path
                    d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <polyline
                    points="7 10 12 15 17 10"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <line
                    x1="12"
                    y1="15"
                    x2="12"
                    y2="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>Download</span>
              </a>
            </div>

            {/* Left / Previous button */}
            {hasPrev && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  goToPrev();
                }}
                title="Previous image (Left arrow)"
                aria-label="Previous image (Left arrow)"
                className="absolute left-4 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-text shadow-menu transition-colors hover:bg-bg"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <path
                    d="m15 18-6-6 6-6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}

            {/* Right / Next button */}
            {hasNext && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  goToNext();
                }}
                title="Next image (Right arrow)"
                aria-label="Next image (Right arrow)"
                className="absolute right-4 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-text shadow-menu transition-colors hover:bg-bg"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <path
                    d="m9 18 6-6-6-6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}

            {/* Large full size image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={selected.id}
              src={`/api/thumbnail?id=${selected.drive_file_id}&folder=${selected.folder_id}&size=1600`}
              alt={selected.name}
              onClick={(e) => e.stopPropagation()}
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              className="max-h-full max-w-full rounded object-contain"
            />
          </div>

          <div className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">Details</span>
                {currentIndex >= 0 && assets.length > 1 && (
                  <span className="text-xs text-muted">
                    ({currentIndex + 1} of {assets.length})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {hasPrev && (
                  <button
                    type="button"
                    onClick={goToPrev}
                    aria-label="Previous image"
                    title="Previous image"
                    className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-4 w-4"
                    >
                      <path
                        d="m15 18-6-6 6-6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {hasNext && (
                  <button
                    type="button"
                    onClick={goToNext}
                    aria-label="Next image"
                    title="Next image"
                    className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-4 w-4"
                    >
                      <path
                        d="m9 18 6-6-6-6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                <a
                  href={downloadHref(selected, readOnly)}
                  download={selected.name}
                  aria-label="Download original image"
                  title="Download original image"
                  className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-4 w-4"
                  >
                    <path
                      d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <polyline
                      points="7 10 12 15 17 10"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <line
                      x1="12"
                      y1="15"
                      x2="12"
                      y2="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
                <button
                  type="button"
                  onClick={() => setFullscreen(false)}
                  aria-label="Exit full screen (Esc)"
                  title="Exit full screen (Esc)"
                  className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-bg hover:text-text"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <AssetDetails
                asset={selected}
                onFindSimilar={readOnly ? undefined : handleFindSimilar}
                isSearchingSimilar={visualSearchingAssetId === selected.id}
                onPermissionChange={readOnly ? undefined : handleUpdateAssetPermission}
                readOnly={readOnly}
              />
            </div>
          </div>
        </div>
      )}

      {/* Visual Search Modal */}
      <VisualSearchModal
        isOpen={visualSearchModalOpen}
        onClose={() => setVisualSearchModalOpen(false)}
        onSearchComplete={handleVisualSearchComplete}
      />

      {/* Direct Folder Upload Modal */}
      {directUploadOpen && (
        <ImageUploader
          isModal
          initialFolderPath={currentPath}
          initialFiles={droppedUploadFiles}
          onClose={() => {
            setDirectUploadOpen(false);
            setDroppedUploadFiles(null);
            // A folder made in the modal's picker should be in the tree even
            // when nothing was uploaded.
            setPaths((prev) => {
              const next = applyRecentFolderChanges(prev);
              pathsCache = next;
              return next;
            });
          }}
          onUploadComplete={() => {
            setDirectUploadOpen(false);
            setDroppedUploadFiles(null);
            setPaths((prev) => {
              const next = applyRecentFolderChanges(prev);
              pathsCache = next;
              return next;
            });
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      </div>
    </AppShell>
  );
}
