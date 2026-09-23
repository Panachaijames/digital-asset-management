"use client";

import { useEffect, useState } from "react";

/* Appearance: Light, Dark or System.
   Light is :root and Dark is `.dark` — the two palettes the dwp.intelligence
   standard defines. System is `.claude`, the warm cream/coral palette, kept
   as a deliberate local exception (user decision 2026-08-07, reaffirmed
   2026-09-07): the standard would have System follow the operating system,
   but that reads as a dead control on a light-set machine because it just
   mirrors Light. All three modes define the same eight tokens, so switching
   is a re-colouring and nothing else. */
type Mode = "light" | "dark" | "system";

const STORAGE_KEY = "dam-theme";
const DEFAULT_MODE: Mode = "light";

function applyMode(mode: Mode) {
  const c = document.documentElement.classList;
  c.toggle("dark", mode === "dark");
  c.toggle("claude", mode === "system");
}

const OPTIONS: { mode: Mode; label: string; title: string; path: string }[] = [
  {
    mode: "light",
    label: "Light",
    title: "Light appearance",
    path: "M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5",
  },
  {
    mode: "dark",
    label: "Dark",
    title: "Dark appearance",
    path: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z",
  },
  {
    mode: "system",
    label: "System",
    title: "System appearance - warm cream",
    path: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9",
  },
];

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);

  useEffect(() => {
    let stored: Mode = DEFAULT_MODE;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      /* storage unavailable - fall back to the default */
    }
    setMode(stored);
    applyMode(stored);
  }, []);

  function selectMode(m: Mode) {
    setMode(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* storage unavailable - the choice just will not persist */
    }
    applyMode(m);
  }

  return (
    <div role="group" aria-label="Appearance" className="flex items-center gap-1">
      {OPTIONS.map((option) => {
        const active = mode === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            onClick={() => selectMode(option.mode)}
            title={option.title}
            aria-pressed={active}
            className={
              active
                ? "flex items-center gap-2 rounded-full bg-text px-3 py-1 text-xs font-medium text-surface transition-colors"
                : "flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:text-text"
            }
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-4 w-4 shrink-0"
            >
              {option.mode === "light" && <circle cx="12" cy="12" r="4" />}
              <path d={option.path} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
