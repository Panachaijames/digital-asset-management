"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import SessionExpiryGuard from "@/components/SessionExpiryGuard";
import { useSession } from "@/components/useSession";
import { useAutoTag } from "@/components/AutoTagContext";

/* The shell, per the dwp.intelligence UI Standard
   (docs/dwp_Intelligence_UI_Consistency_Review.md 5.3-5.4):

     - sidebar 240px, --dwp-surface, one hairline right rule. No dark chrome.
     - wordmark top-left, the app name beneath it at 16px weight 500.
     - top bar 56px: the sub-app name first, then Feedback and the user photo
       with a status dot at the far right (v1.3).
     - the sidebar is text-only: no nav glyphs, labels alone (user, 2026-09-22).
     - one outline icon set at 1.5px stroke, 16px elsewhere in the body (gap 11).
     - 6px radius, one hairline instead of elevation, weights 400 and 500.

   The app is named "Digital Assets" in one place and one way. It used to read
   DAM, dwp.dam, Digital Asset Manager and Digital Asset Management on the same
   screen, which is the four-spellings deviation the review flags against Help
   Desk and HR. */

const APP_NAME = "Digital Assets";

/* message-square - the Feedback glyph the standard settles on (gap 4). */
function MessageSquareIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path d="M7 17L17 7M7 7h10v10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <path
        d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* External feedback form (App Manager) - opens in a new tab. */
const FEEDBACK_URL =
  "https://appmanager-s2r2rmdlzq-eu.a.run.app/project/app-1784521573651?mode=USER";

interface NavItemProps {
  href: string;
  label: string;
  active?: boolean;
  isExternal?: boolean;
  badge?: string;
  disabled?: boolean;
}

/** Sidebar entry - 6px radius, 14px, active is the accent at 5%. */
function NavItem({
  href,
  label,
  active,
  isExternal,
  badge,
  disabled,
}: NavItemProps) {
  let baseClass =
    "group flex items-center justify-between gap-2 rounded px-2 py-2 text-sm transition-colors";

  if (active) {
    baseClass += " bg-accent/5 font-medium text-accent";
  } else if (disabled) {
    baseClass += " cursor-not-allowed text-muted opacity-60";
  } else {
    baseClass += " text-text hover:bg-bg";
  }

  const content = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      {isExternal && <ExternalLinkIcon className="h-4 w-4 shrink-0 text-muted" />}
      {badge && (
        <span className="shrink-0 rounded-full border border-accent/25 bg-accent/5 px-2 py-0.5 text-xs font-medium text-text">
          {badge}
        </span>
      )}
    </>
  );

  if (disabled) {
    return <div className={baseClass}>{content}</div>;
  }

  if (isExternal) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={baseClass}>
        {content}
      </a>
    );
  }

  return (
    <Link href={href} className={baseClass}>
      {content}
    </Link>
  );
}

/** Sidebar group label - 12px weight 500, muted. */
function NavGroupLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-2 text-xs font-medium text-muted">{children}</p>;
}

function GlobalAutoTagFloatingPill() {
  const { job, isRunning, isPaused, pauseAutoTag, resumeAutoTag } = useAutoTag();
  const pathname = usePathname();
  const onImport = pathname?.startsWith("/import") ?? false;
  const [minimized, setMinimized] = useState(false);

  if (!job || (!isRunning && !isPaused)) return null;

  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        title={`Auto-tagging ${job.targetName}: ${pct}% done. Click to expand.`}
        className="fixed bottom-6 right-6 z-50 flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-menu transition-opacity hover:opacity-90"
      >
        <SparkIcon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <aside
      aria-label="Background auto-tagging progress"
      /* A floating overlay is the one place the standard allows a shadow. */
      className="fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-2 rounded border border-border bg-surface p-4 shadow-menu"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/5 text-accent">
            <SparkIcon className="h-4 w-4" />
          </span>
          <p className="truncate text-xs font-medium text-text">
            Auto-tagging {job.targetName || "the Drive"}
            {isPaused && <span className="text-muted"> - paused</span>}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isRunning ? (
            <button
              type="button"
              onClick={() => pauseAutoTag()}
              title="Pause auto-tagging (saves progress)"
              className="rounded px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => resumeAutoTag()}
              title="Resume auto-tagging"
              className="rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent transition-opacity hover:opacity-90"
            >
              Resume
            </button>
          )}

          {!onImport && (
            <Link
              href="/import"
              title="Open Import"
              className="rounded px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Open
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMinimized(true)}
            title="Minimise"
            className="rounded p-1 text-muted transition-colors hover:text-text"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M18 12H6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Progress - a hairline track in the border token, fill in the accent. */}
      <div className="w-full">
        <div className="h-1 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          <span>
            {job.done.toLocaleString()} / {job.total.toLocaleString()} ({pct}%)
          </span>
          <span>
            {job.tagged.toLocaleString()} tagged
            {job.failed > 0 && <> - {job.failed} failed</>}
          </span>
        </div>
      </div>
    </aside>
  );
}

export default function AppShell({
  crumb,
  topRight,
  children,
}: {
  crumb: string;
  topRight?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const onBrowse = pathname?.startsWith("/browse") ?? false;
  const onSettings = pathname?.startsWith("/settings") ?? false;
  const onImport = pathname?.startsWith("/import") ?? false;
  const onUpload = !onBrowse && !onSettings && !onImport;

  /* The signed-in user, read from GET /api/session (the cookie is httpOnly, so
     client JS cannot decode it directly). Renders as initials until it
     resolves. */
  const { user, signOut } = useSession();
  const { isRunning: isAutoTagging, isPaused: isAutoTagPaused } = useAutoTag();

  return (
    <div className="flex h-screen overflow-hidden bg-bg font-sans text-text">
      <SessionExpiryGuard />

      {/* Sidebar - 240px, surface, one hairline. */}
      <aside className="flex w-sidebar shrink-0 select-none flex-col border-r border-border bg-surface">
        {/* Wordmark, then the app name. */}
        <div className="px-4 pb-3 pt-4">
          <div className="text-base font-medium text-text">dwp.</div>
          <div className="mt-2 truncate text-base font-medium text-text">{APP_NAME}</div>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-2 py-2">
          <div>
            <NavGroupLabel>Explorer</NavGroupLabel>
            <div className="space-y-1">
              <NavItem href="/browse" label="Assets" active={onBrowse} />
              <NavItem href="/" label="Upload" active={onUpload} />
              <NavItem
                href="/import"
                label="Import"
                active={onImport}
                badge={isAutoTagging ? "Tagging" : isAutoTagPaused ? "Paused" : undefined}
              />
            </div>
          </div>

          <div>
            <NavGroupLabel>Administration</NavGroupLabel>
            <div className="space-y-1">
              <NavItem href="/settings" label="Taxonomy" active={onSettings} />
              <NavItem href="#" label="Collections" disabled badge="Soon" />
              <NavItem href="#" label="Moderation" disabled badge="Soon" />
            </div>
          </div>
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        {/* Top bar - 56px. The sub-app name first; Feedback and the user photo
            with a status dot at the far right (v1.3). */}
        <header className="flex h-topbar shrink-0 items-center gap-6 border-b border-border bg-surface px-8">
          <div className="min-w-0 truncate text-base font-medium text-text">{crumb}</div>

          <div className="ml-auto flex shrink-0 items-center gap-4">
            {topRight}

            <ThemeToggle />

            <a
              href={FEEDBACK_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
            >
              <MessageSquareIcon className="h-4 w-4" />
              Feedback
            </a>

            {/* The user photo, with a status dot. Clicking signs out. Falls
                back to initials: Workspace ID tokens frequently omit the
                picture claim, so the photo is best-effort
                (lib/profileCache.ts). */}
            <button
              type="button"
              onClick={signOut}
              disabled={!user}
              title={user ? `${user.email} (${user.role}) - sign out` : "Loading"}
              aria-label={user ? `Sign out ${user.email}` : "Loading account"}
              className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border bg-bg text-xs font-medium text-text transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {user?.picture ? (
                // eslint-disable-next-line @next/next/no-img-element -- a remote
                // avatar that may 404; next/image would add no benefit here.
                <img
                  src={user.picture}
                  alt=""
                  width={32}
                  height={32}
                  /* lh3.googleusercontent.com intermittently 403s hot-linked
                     photos when a Referer is sent. */
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              ) : (
                user?.initials ?? "."
              )}
              <i
                aria-label={user ? "Status: available" : "Status: offline"}
                className={
                  user
                    ? "absolute -bottom-px -right-px h-2 w-2 rounded-full bg-accent ring-2 ring-surface"
                    : "absolute -bottom-px -right-px h-2 w-2 rounded-full bg-border ring-2 ring-surface"
                }
              />
            </button>
          </div>
        </header>

        {/* Content area. The pages own their own scrolling and padding - the
            asset browser is a full-height view with its own scroll regions, so
            the shell deliberately does not impose the standard 32px main
            padding here. */}
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>

      <GlobalAutoTagFloatingPill />
    </div>
  );
}
