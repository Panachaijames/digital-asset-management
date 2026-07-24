"use client";

import { useEffect, useState } from "react";

// Three fixed color themes. "system" is the Claude-style mode: warm cream
// paper with coral/terracotta accents (the .claude class in globals.css).
type Mode = "light" | "dark" | "system";

const STORAGE_KEY = "dam-theme";
const DEFAULT_MODE: Mode = "dark"; // the app's original console look

function applyMode(mode: Mode) {
  const c = document.documentElement.classList;
  c.toggle("dark", mode === "dark");
  c.toggle("claude", mode === "system");
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path
        d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Starburst/asterisk for the Claude-colored "System" mode.
function StarburstIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={className}>
      <path
        d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Rail-style theme switcher: click cycles Light → Dark → System (Claude
// cream/coral colors). The inline script in app/layout.tsx applies the saved
// choice before first paint so there is no theme flash on load.
export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Mode | null;
    if (stored === "light" || stored === "dark" || stored === "system") {
      setMode(stored);
    }
  }, []);

  function cycle() {
    const next: Mode =
      mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyMode(next);
  }

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${mode === "system" ? "System (Claude colors)" : mode} — click to change`}
      className="flex w-full flex-col items-center gap-1 rounded-sm px-1 py-2 font-mono text-[9px] text-ink/40 transition-colors hover:bg-card hover:text-ink/80"
    >
      <span className="h-5 w-5">
        {mode === "light" ? <SunIcon /> : mode === "dark" ? <MoonIcon /> : <StarburstIcon />}
      </span>
      {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
    </button>
  );
}
