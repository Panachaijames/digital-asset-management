"use client";

// The embeddable gallery: a read-only asset grid with no sidebar, no top bar
// and no editing, built to sit in an <iframe> on another dwp site.
//
// Three things make it different from /browse, and all three are deliberate:
//
//  1. It NEVER navigates on a 401. /browse gets that for free from
//     SessionExpiryGuard, which AppShell mounts; here the same behaviour would
//     send the host page's iframe to /login, where Google Sign-In cannot run
//     (it is a nested cross-site frame). Instead a 401 renders the sign-in card
//     below, which offers the Storage Access prompt and a real tab to sign in.
//  2. It pages. /browse shows the newest 60 and says so; an embed is often the
//     only view someone has of a folder, so it carries a "Show more".
//  3. Everything it needs comes from the query string, because the embedder
//     writes the URL and never touches this file. See docs/DAM-EMBED-GUIDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DamAsset } from "@/lib/types";
import {
  continueInFrame,
  signInViaPopup,
  type SignInOutcome,
} from "@/components/framedSignIn";

export interface EmbedConfig {
  // Filters forwarded verbatim to GET /api/assets.
  query: Record<string, string>;
  controls: { search: boolean; tags: boolean; sort: boolean };
  columns: "auto" | "1" | "2" | "3" | "4" | "6";
  title: string | null;
  description: string | null;
  open: "lightbox" | "tab" | "none";
  // Post the content height to the host page so it can size the iframe.
  autoHeight: boolean;
  pageSize: number;
}

interface TagCount {
  tag: string;
  count: number;
}

// Literal strings, not interpolation: Tailwind generates classes by scanning
// this file's source, so a computed `grid-cols-${n}` would produce no CSS.
const COLUMN_CLASS: Record<EmbedConfig["columns"], string> = {
  auto: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4",
  "1": "grid-cols-1",
  "2": "grid-cols-2",
  "3": "grid-cols-2 sm:grid-cols-3",
  "4": "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4",
  "6": "grid-cols-2 sm:grid-cols-4 xl:grid-cols-6",
};

// How many of the library's tags to offer as chips. /api/tags returns every
// tag in use, count-descending, which is hundreds of them.
const TAG_CHIP_LIMIT = 12;

function formatBytes(n: number) {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Always pass &folder: it lets lib/driveThumbnails.ts warm every sibling link
// with one Drive call instead of one per tile (~0.5s each otherwise).
function thumbUrl(asset: DamAsset, size?: number) {
  const p = new URLSearchParams({
    id: asset.drive_file_id,
    folder: asset.folder_id ?? "",
  });
  if (size) p.set("size", String(size));
  return `/api/thumbnail?${p.toString()}`;
}

function isPdf(asset: DamAsset) {
  return (
    asset.mime_type === "application/pdf" ||
    asset.name.toLowerCase().endsWith(".pdf")
  );
}

function isVideo(asset: DamAsset) {
  return (
    asset.mime_type.startsWith("video/") ||
    /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(asset.name)
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export default function EmbedGallery({ config }: { config: EmbedConfig }) {
  const [rows, setRows] = useState<DamAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<
    "loading" | "ready" | "signed-out" | "error"
  >("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  const [search, setSearch] = useState(config.query.q ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(config.query.q ?? "");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<TagCount[]>([]);
  const [sort, setSort] = useState(
    config.query.sort === "oldest" ? "oldest" : "newest"
  );

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [outcome, setOutcome] = useState<SignInOutcome | null>(null);

  // Tags fixed by the embed URL. They are ANDed with whatever the viewer picks
  // (/api/assets `contains` means "has ALL of these"), so a chip can only ever
  // narrow an embed, never widen it past what the embedder chose.
  const pinnedTags = useMemo(
    () => dedupe((config.query.tags ?? "").split(",").map((t) => t.trim())),
    [config.query.tags]
  );

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams(config.query);
    const tags = dedupe([...pinnedTags, ...activeTags]);
    if (tags.length) p.set("tags", tags.join(","));
    else p.delete("tags");
    if (debouncedSearch) p.set("q", debouncedSearch);
    else p.delete("q");
    p.set("sort", sort);
    p.set("limit", String(config.pageSize));
    return p.toString();
  }, [config.query, config.pageSize, pinnedTags, activeTags, debouncedSearch, sort]);

  // The in-flight request's query, so a slow first page cannot overwrite a
  // faster later one after the viewer has typed.
  const latest = useRef(0);
  // What is on screen right now. `load` is memoised on the query string, so
  // reading `rows` inside it would read whatever it was when that query was
  // built — one page behind from the second page onwards.
  const rowsRef = useRef<DamAsset[]>([]);

  const load = useCallback(
    async (offset: number): Promise<boolean> => {
      const ticket = ++latest.current;
      if (offset === 0) setStatus("loading");
      else setLoadingMore(true);

      try {
        const res = await fetch(`/api/assets?${queryString}&offset=${offset}`, {
          cache: "no-store",
        });

        if (res.status === 401) {
          if (ticket === latest.current) setStatus("signed-out");
          return false;
        }
        if (!res.ok) {
          if (ticket === latest.current) setStatus("error");
          return false;
        }

        const data = await res.json();
        if (ticket !== latest.current) return true;

        const page: DamAsset[] = data.assets ?? [];
        const next = offset === 0 ? page : [...rowsRef.current, ...page];
        rowsRef.current = next;
        setRows(next);

        // An empty page past offset 0 means rows went away since the count was
        // taken. Believe what we actually hold, rather than a total that would
        // keep offering "Show more" for rows that are not coming.
        const serverTotal =
          typeof data.total === "number" ? data.total : next.length;
        setTotal(offset > 0 && page.length === 0 ? next.length : serverTotal);
        setStatus("ready");
        return true;
      } catch {
        if (ticket === latest.current) setStatus("error");
        return false;
      } finally {
        if (ticket === latest.current) setLoadingMore(false);
      }
    },
    [queryString]
  );

  useEffect(() => {
    setLightboxIndex(null);
    void load(0);
  }, [load]);

  useEffect(() => {
    if (!config.controls.tags) return;
    let cancelled = false;
    fetch("/api/tags", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.tags) return;
        setTagOptions(data.tags as TagCount[]);
      })
      .catch(() => {
        // Chips are an enhancement; a failure here just means no chips.
      });
    return () => {
      cancelled = true;
    };
  }, [config.controls.tags]);

  // Tell the host page how tall the content is, so it can size the iframe.
  // targetOrigin is "*" deliberately: we do not know which of the allowed
  // parents is framing us, and a pixel height is not worth a handshake to keep
  // private. The message is namespaced so a host can ignore everything else.
  useEffect(() => {
    if (!config.autoHeight) return;
    if (typeof window === "undefined" || window.parent === window) return;

    const post = () => {
      const height = Math.ceil(
        document.documentElement.getBoundingClientRect().height
      );
      window.parent.postMessage(
        { type: "dwp-dam-embed:height", height },
        "*"
      );
    };

    const observer = new ResizeObserver(post);
    observer.observe(document.documentElement);
    post();
    return () => observer.disconnect();
  }, [config.autoHeight, rows.length, status]);

  // Esc and the arrow keys, for the lightbox only.
  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIndex(null);
      if (e.key === "ArrowRight")
        setLightboxIndex((i) => (i === null ? i : Math.min(rows.length - 1, i + 1)));
      if (e.key === "ArrowLeft")
        setLightboxIndex((i) => (i === null ? i : Math.max(0, i - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, rows.length]);

  // Sign in without leaving the host page. Google Sign-In cannot render in a
  // nested cross-site frame, so this opens a popup — a top-level window on our
  // own origin, where it works normally — and the frame exchanges the
  // credential itself so the cookie lands in a jar this frame can read. See
  // components/framedSignIn.ts.
  //
  // window.open must happen straight from the click; everything asynchronous
  // is inside signInViaPopup.
  async function popupSignIn() {
    setAccessBusy(true);
    setOutcome(null);
    const result = await signInViaPopup();
    setOutcome(result === "signed-in" ? null : result);
    setAccessBusy(false);
    if (result === "signed-in") await load(0);
  }

  // The follow-up click, for a browser that would not keep a cookie written
  // from inside a frame. Storage Access needs a gesture of its own.
  async function continueHere() {
    setAccessBusy(true);
    setOutcome(null);
    const ok = await continueInFrame();
    setAccessBusy(false);
    if (ok) await load(0);
    else setOutcome("needs-continue");
  }

  function toggleTag(tag: string) {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  function openAsset(index: number) {
    const asset = rows[index];
    if (!asset) return;
    if (config.open === "none") return;
    if (config.open === "tab") {
      window.open(asset.web_view_link, "_blank", "noopener,noreferrer");
      return;
    }
    setLightboxIndex(index);
  }

  const chips = useMemo(
    () =>
      tagOptions
        .filter((t) => !pinnedTags.includes(t.tag))
        .slice(0, TAG_CHIP_LIMIT),
    [tagOptions, pinnedTags]
  );

  const showControls =
    config.controls.search || config.controls.tags || config.controls.sort;
  const hasMore = rows.length > 0 && rows.length < total;
  const lightboxAsset = lightboxIndex === null ? null : rows[lightboxIndex] ?? null;

  if (status === "signed-out") {
    return (
      <div className="flex min-h-[220px] items-center justify-center p-6">
        <div className="w-full max-w-sm rounded border border-border bg-surface p-6 text-center">
          <h2 className="text-base font-medium text-text">
            Sign in to view these assets
          </h2>
          <p className="mt-2 text-sm text-muted">
            This gallery shows dwp digital assets to signed-in staff. Sign in
            to see them without leaving this page.
          </p>
          <button
            type="button"
            onClick={popupSignIn}
            disabled={accessBusy}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            {accessBusy ? "Waiting for sign-in" : "Sign in with Google"}
          </button>
          <p className="mt-2 text-xs text-muted">
            Opens a small Google window. This page stays where it is.
          </p>

          {outcome === "needs-continue" && (
            <>
              <p className="mt-4 text-sm text-muted">
                Signed in. This browser needs one more permission before an
                embedded page can use the session.
              </p>
              <button
                type="button"
                onClick={continueHere}
                disabled={accessBusy}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
              >
                {accessBusy ? "Checking" : "Show my assets"}
              </button>
            </>
          )}

          {outcome === "blocked" && (
            <>
              <p className="mt-4 text-sm text-muted">
                Your browser blocked the sign-in window. Allow popups for this
                page, or use a new tab.
              </p>
              <a
                href="/login?next=%2Fbrowse"
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
              >
                Sign in in a new tab
              </a>
            </>
          )}

          {outcome === "failed" && (
            <p className="mt-4 text-sm text-muted">
              Sign-in did not complete. Try again, or open Digital Assets in its
              own tab.
            </p>
          )}
        </div>
      </div>
    );
  }

  // height=auto lets the content set the page height and reports it to the host
  // (the ResizeObserver above); height=fill makes the gallery fill the iframe
  // and scroll internally. The two need opposite box models, so the classes
  // differ rather than one shape trying to do both.
  const rootClass = config.autoHeight
    ? "relative flex flex-col"
    : "relative flex h-full min-h-0 flex-col";
  const scrollClass = config.autoHeight
    ? "px-6 pb-8 pt-4"
    : "min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-4";

  return (
    <div className={rootClass}>
      {(config.title || config.description) && (
        <div className="shrink-0 border-b border-border px-6 pb-4 pt-5">
          {config.title && (
            <h1 className="text-lg font-medium text-text">{config.title}</h1>
          )}
          {config.description && (
            <p className="mt-1 text-sm text-muted">{config.description}</p>
          )}
        </div>
      )}

      {showControls && (
        <div className="shrink-0 px-6 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-surface px-4 py-2 focus-within:border-text">
            {config.controls.search && (
              <div className="flex min-w-[220px] flex-1 items-center gap-2 text-muted">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4 shrink-0 text-muted"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by asset name"
                  aria-label="Search by asset name"
                  className="w-full bg-transparent text-sm text-text outline-none placeholder:text-muted"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="flex h-4 w-4 shrink-0 items-center justify-center text-muted transition-colors hover:text-text"
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
              </div>
            )}

            {config.controls.sort && (
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                aria-label="Sort order"
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition-colors focus:border-text"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            )}
          </div>

          {config.controls.tags && chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {chips.map(({ tag, count }) => (
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
                  <span className={activeTags.includes(tag) ? "" : "text-muted"}>
                    {count}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={scrollClass}>
        {status === "loading" && (
          <div className={`grid gap-4 ${COLUMN_CLASS[config.columns]}`}>
            {Array.from({ length: 8 }).map((_, i) => (
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

        {status === "error" && (
          <div className="rounded border border-border bg-surface p-6 text-center">
            <p className="text-sm text-muted">
              These assets could not be loaded.
            </p>
            <button
              type="button"
              onClick={() => void load(0)}
              className="mt-3 inline-flex items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
            >
              Try again
            </button>
          </div>
        )}

        {status === "ready" && rows.length === 0 && (
          <p className="text-sm text-muted">No assets match these filters.</p>
        )}

        {status === "ready" && rows.length > 0 && (
          <>
            <div className={`grid gap-4 ${COLUMN_CLASS[config.columns]}`}>
              {rows.map((asset, index) => (
                <EmbedTile
                  key={asset.id}
                  asset={asset}
                  clickable={config.open !== "none"}
                  onOpen={() => openAsset(index)}
                />
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted">
                Showing {rows.length} of {total.toLocaleString("en-GB")} assets
              </p>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void load(rows.length)}
                  disabled={loadingMore}
                  className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
                >
                  {loadingMore ? "Loading" : "Show more"}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {lightboxAsset && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightboxAsset.name}
          className="fixed inset-0 z-50 flex flex-col bg-bg"
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-surface px-6 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text">
                {lightboxAsset.name}
              </p>
              <p className="truncate text-xs text-muted">
                {lightboxAsset.folder_path} · {formatBytes(lightboxAsset.size_bytes)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLightboxIndex(null)}
              className="inline-flex shrink-0 items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
            >
              Close
            </button>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={lightboxAsset.id}
              src={thumbUrl(lightboxAsset, 1600)}
              alt={lightboxAsset.name}
              className="max-h-full max-w-full rounded object-contain"
            />
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setLightboxIndex((i) => (i === null ? i : Math.max(0, i - 1)))
                }
                disabled={lightboxIndex === 0}
                className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  setLightboxIndex((i) =>
                    i === null ? i : Math.min(rows.length - 1, i + 1)
                  )
                }
                disabled={lightboxIndex === rows.length - 1}
                className="inline-flex items-center justify-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
              >
                Next
              </button>
            </div>
            <a
              href={lightboxAsset.web_view_link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90"
            >
              Open in Drive
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// The /browse card, minus everything that writes: no selection checkbox, no
// find-similar button, no similarity score.
function EmbedTile({
  asset,
  clickable,
  onOpen,
}: {
  asset: DamAsset;
  clickable: boolean;
  onOpen: () => void;
}) {
  const pdf = isPdf(asset);

  const body = (
    <>
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

      <div className="relative aspect-square overflow-hidden bg-bg">
        {/* Sits UNDER the image. On a Drive 404 the image is hidden with
            visibility, not display, so this shows through without reflow. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center p-2 text-center text-xs text-muted">
          {pdf ? (
            <div className="flex flex-col items-center justify-center text-muted">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="mb-1 h-8 w-8"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-xs font-medium text-muted">PDF document</span>
            </div>
          ) : (
            "No preview"
          )}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbUrl(asset)}
          alt={asset.name}
          loading="lazy"
          decoding="async"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          className="relative h-full w-full object-cover"
        />
        {pdf && (
          <span className="absolute bottom-2 left-2 z-10 rounded border border-border bg-surface px-2 py-0.5 text-xs font-medium text-muted">
            PDF
          </span>
        )}
        {isVideo(asset) && (
          <span className="absolute bottom-2 left-2 z-10 rounded border border-border bg-surface px-2 py-0.5 text-xs font-medium text-muted">
            Video
          </span>
        )}
      </div>

      <div className="p-3">
        <p className="truncate text-xs font-medium text-text">{asset.name}</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs text-muted">
          {asset.core_sector || asset.macro_portfolio ? (
            <span className="badge-status badge-management max-w-[130px] truncate">
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
              {[asset.macro_portfolio, asset.core_sector]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : (
            <span className="badge-status truncate border border-border bg-bg text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full bg-muted" />
              General
            </span>
          )}
          <span className="shrink-0 text-xs font-medium text-muted">
            {formatBytes(asset.size_bytes)}
          </span>
        </div>
      </div>
    </>
  );

  if (!clickable) {
    return (
      <div className="relative block overflow-hidden rounded border border-border bg-surface text-left">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative block overflow-hidden rounded border border-border bg-surface text-left transition-colors duration-150 hover:border-text"
    >
      {body}
    </button>
  );
}
