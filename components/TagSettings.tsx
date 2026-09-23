"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { primeTaxonomyRowsCache } from "@/components/PresetChips";
import type { TaxonomyRow } from "@/lib/taxonomy";

// Settings, Taxonomy. The whole tag vocabulary as one editable table:
// Macro Portfolio → Core Sector → Sub-Sector tags (one row per Core Sector,
// tags comma-separated). Edits auto-save (debounced whole-set replace via
// /api/taxonomy); Reset restores the built-in defaults. Tags already applied
// to assets are never touched by edits here.

interface EditRow {
  key: string; // stable local key for React
  macro: string;
  core: string;
  tagsText: string; // comma-separated while editing
}

let nextKey = 0;
const makeKey = () => `row-${nextKey++}`;

const toEditRows = (rows: TaxonomyRow[]): EditRow[] =>
  rows.map((r) => ({
    key: makeKey(),
    macro: r.macro,
    core: r.core,
    tagsText: r.tags.join(", "),
  }));

const toApiRows = (rows: EditRow[]): TaxonomyRow[] =>
  rows.map((r) => ({
    macro: r.macro.trim(),
    core: r.core.trim(),
    tags: r.tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  }));

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export default function TagSettings() {
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  // The latest rows, readable from the debounced save without re-arming it.
  const rowsRef = useRef<EditRow[] | null>(null);
  rowsRef.current = rows;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/taxonomy")
      .then((r) => r.json())
      .then((d) => setRows(toEditRows(Array.isArray(d.rows) ? d.rows : [])))
      .catch(() => setError("Could not load the taxonomy."));
  }, []);

  const save = useCallback(async () => {
    const current = rowsRef.current;
    if (!current) return;
    setSaveState("saving");
    setError("");
    try {
      const res = await fetch("/api/taxonomy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: toApiRows(current) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed.");
      // Other pages (upload chips, browse filters) read this module cache.
      primeTaxonomyRowsCache(data.rows);
      // Only mark saved if nothing changed while the request was in flight.
      setSaveState(rowsRef.current === current ? "saved" : "dirty");
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : "Save failed.");
    }
  }, []);

  // Debounced auto-save: any edit re-arms an 800 ms timer.
  const scheduleSave = useCallback(() => {
    setSaveState("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), 800);
  }, [save]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  // Warn before leaving with unsaved edits still in the debounce window.
  useEffect(() => {
    const dirty = saveState === "dirty" || saveState === "saving";
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

  const updateRow = (key: string, patch: Partial<EditRow>) => {
    setRows((prev) =>
      prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev
    );
    scheduleSave();
  };

  const deleteRow = (row: EditRow) => {
    if (
      !window.confirm(
        `Delete the "${row.macro} / ${row.core}" row?\n\nImages already tagged with these keep their tags.`
      )
    )
      return;
    setRows((prev) => (prev ? prev.filter((r) => r.key !== row.key) : prev));
    scheduleSave();
  };

  const addRow = () => {
    setRows((prev) =>
      prev
        ? [...prev, { key: makeKey(), macro: "", core: "", tagsText: "" }]
        : prev
    );
    // A blank row isn't saveable yet — no scheduleSave until it's filled in.
  };

  const reset = async () => {
    if (
      !window.confirm(
        "Reset the taxonomy to the built-in defaults?\n\nEvery edit in this table will be discarded. Tags already applied to images are not affected."
      )
    )
      return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveState("saving");
    setError("");
    try {
      const res = await fetch("/api/taxonomy/reset", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reset failed.");
      setRows(toEditRows(data.rows));
      primeTaxonomyRowsCache(data.rows);
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : "Reset failed.");
    }
  };

  const inputCls =
    "w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:border-text outline-none transition-colors";

  const saveLabel =
    saveState === "saving"
      ? "Saving"
      : saveState === "dirty"
      ? "Unsaved changes"
      : saveState === "saved"
      ? "All changes saved"
      : saveState === "error"
      ? "Save failed"
      : "";

  return (
    <div>
      {/* Page header — title, one-line description, one action (§5.5). */}
      <header className="mb-6 flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-medium text-text">Taxonomy</h1>
          <p className="mt-1 text-sm text-muted">
            Portfolios, sectors and the tags they offer. Edits save
            automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="inline-flex shrink-0 items-center gap-2 rounded border border-border bg-transparent px-3 py-2 text-sm font-medium text-danger transition-colors hover:border-danger"
        >
          Reset taxonomy
        </button>
      </header>

      {/* Save state — a status badge, so it sits below the header, not in it. */}
      {saveLabel && (
        <div className="mb-4 flex justify-end">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
              saveState === "error"
                ? "border-danger/25 bg-danger/5 text-danger"
                : "border-accent/25 bg-accent/5 text-text"
            }`}
          >
            {saveLabel}
          </span>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {!rows && !error && (
        <p className="mt-4 text-sm text-muted">Loading taxonomy</p>
      )}

      {rows && (
        <div className="mt-4 overflow-x-auto rounded border border-border bg-surface p-4">
          <div className="min-w-[720px]">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_1fr_2.4fr_2rem] gap-2 rounded border-b border-border bg-bg px-1 py-2">
              <span className="px-3 text-xs font-medium text-muted">
                Macro Portfolio
              </span>
              <span className="px-3 text-xs font-medium text-muted">
                Core Sector
              </span>
              <span className="px-3 text-xs font-medium text-muted">
                Sub-Sector Tags / Typologies
              </span>
              <span />
            </div>

            {/* Rows */}
            <div className="mt-2 space-y-2">
              {rows.map((r) => (
                <div
                  key={r.key}
                  className="grid grid-cols-[1fr_1fr_2.4fr_2rem] items-center gap-2 px-1"
                >
                  <input
                    className={inputCls}
                    value={r.macro}
                    placeholder="Macro Portfolio"
                    onChange={(e) => updateRow(r.key, { macro: e.target.value })}
                  />
                  <input
                    className={inputCls}
                    value={r.core}
                    placeholder="Core Sector"
                    onChange={(e) => updateRow(r.key, { core: e.target.value })}
                  />
                  <input
                    className={inputCls}
                    value={r.tagsText}
                    placeholder="Tags, comma, separated"
                    onChange={(e) =>
                      updateRow(r.key, { tagsText: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    title="Delete row"
                    aria-label={`Delete ${r.macro} / ${r.core}`}
                    onClick={() => deleteRow(r)}
                    className="justify-self-center text-muted transition-colors hover:text-danger"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-4 w-4"
                    >
                      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-3 px-1">
              <button
                type="button"
                onClick={addRow}
                className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                </svg>
                Add row
              </button>
              <span className="text-xs text-muted">
                A row needs both a Macro Portfolio and a Core Sector to be
                saved.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
