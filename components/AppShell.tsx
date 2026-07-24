"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import ThemeToggle from "@/components/ThemeToggle";

// Cloudinary-style console shell: far-left icon rail, product sidebar, top bar
// with breadcrumb + actions, and a full-height content area (children manage
// their own scrolling).

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" strokeLinecap="round" />
      <path d="M9.5 21v-6h5v6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AssetsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" strokeLinecap="round" />
    </svg>
  );
}

function ImportIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path d="M12 4v9m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V13" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2a1.5 1.5 0 0 1 1.2.6l1.2 1.6H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.2H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2.1-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.7 7.7 0 0 0-2.6 1.5l-2.4-1-2 3.4 2.1 1.6a7.6 7.6 0 0 0 0 3l-2.1 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.4-2.1-1.6Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FeedbackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5v-8Z"
        strokeLinejoin="round"
      />
      <path d="M8.5 9h7M8.5 12h4.5" strokeLinecap="round" />
    </svg>
  );
}

// External feedback form (App Manager) — opens in a new tab.
const FEEDBACK_URL =
  "https://appmanager-4w57ydlk6q-uc.a.run.app/project/app-1784521573651?mode=USER";

function RailItem({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  const cls = `flex w-full flex-col items-center gap-1 rounded-sm px-1 py-2 text-[9px] font-mono transition-colors ${
    active
      ? "bg-blueprint-50 text-blueprint-400"
      : "text-ink/40 hover:bg-card hover:text-ink/80"
  }`;
  if (href.startsWith("http")) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        <span className="h-5 w-5">{children}</span>
        {label}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      <span className="h-5 w-5">{children}</span>
      {label}
    </Link>
  );
}

function SideItem({
  href,
  label,
  active,
  disabled,
  icon,
}: {
  href?: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const cls = `flex items-center gap-2.5 rounded-sm px-3 py-2 text-sm transition-colors ${
    active
      ? "bg-blueprint-50 text-ink"
      : disabled
      ? "cursor-default text-ink/25"
      : "text-ink/70 hover:bg-card hover:text-ink"
  }`;
  if (disabled || !href) {
    return (
      <span className={cls}>
        {icon && <span className="h-4 w-4 shrink-0">{icon}</span>}
        {label}
      </span>
    );
  }
  if (href.startsWith("http")) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {icon && <span className="h-4 w-4 shrink-0">{icon}</span>}
        {label}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {icon && <span className="h-4 w-4 shrink-0">{icon}</span>}
      {label}
    </Link>
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

  return (
    <div className="flex h-screen overflow-hidden bg-paper text-ink">
      {/* Icon rail */}
      <aside className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-line/60 bg-rail px-1.5 py-3">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-sm bg-blueprint-600 font-display text-sm italic text-white">
          d.
        </div>
        <RailItem href="/" label="Upload" active={onUpload}>
          <UploadIcon />
        </RailItem>
        <RailItem href="/browse" label="Assets" active={onBrowse}>
          <AssetsIcon />
        </RailItem>
        <div className="mt-auto w-full space-y-1">
          <ThemeToggle />
          <RailItem href={FEEDBACK_URL} label="Feedback" active={false}>
            <FeedbackIcon />
          </RailItem>
          <RailItem href="/settings" label="Settings" active={onSettings}>
            <GearIcon />
          </RailItem>
        </div>
      </aside>

      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line/60 bg-panel md:flex">
        <div className="border-b border-line/60 px-4 py-3.5">
          <p className="font-mono text-xs uppercase tracking-wider text-blueprint-400">
            dwp.dam
          </p>
          <p className="mt-0.5 text-[11px] text-ink/40">Digital Asset Manager</p>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          <p className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-ink/35">
            Media Library
          </p>
          <SideItem href="/browse" label="Assets" active={onBrowse} icon={<AssetsIcon />} />
          <SideItem href="/browse" label="Folders" icon={<FolderIcon />} />
          <SideItem href="/" label="Upload" active={onUpload} icon={<UploadIcon />} />
          <SideItem
            href="/import"
            label="Import from Drive"
            active={onImport}
            icon={<ImportIcon />}
          />
          <p className="px-3 pb-1 pt-4 font-mono text-[10px] uppercase tracking-wider text-ink/35">
            System
          </p>
          <SideItem href="/settings" label="Settings" active={onSettings} icon={<GearIcon />} />
          <SideItem href={FEEDBACK_URL} label="Feedback" icon={<FeedbackIcon />} />
          <p className="px-3 pb-1 pt-4 font-mono text-[10px] uppercase tracking-wider text-ink/35">
            Coming soon
          </p>
          <SideItem label="Collections" disabled icon={<HomeIcon />} />
          <SideItem label="Moderation" disabled icon={<HomeIcon />} />
        </nav>
        <div className="border-t border-line/60 px-4 py-3 text-[11px] text-ink/30">
          Drive-backed · Supabase-indexed
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line/60 bg-panel px-4">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-ink/40">Media Library</span>
            <span className="text-ink/25">›</span>
            <span className="truncate font-medium text-ink">{crumb}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {topRight}
            {(onBrowse || onSettings) && (
              <Link
                href="/"
                className="flex items-center gap-1.5 rounded-sm bg-blueprint-600 px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                <span className="h-4 w-4">
                  <UploadIcon />
                </span>
                Upload
              </Link>
            )}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
