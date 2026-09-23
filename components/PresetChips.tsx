"use client";

import { useEffect, useState } from "react";
import type { TagPresetGroup } from "@/lib/tagPresets";
import {
  TAXONOMY,
  rowsToTree,
  type MacroPortfolio,
  type TaxonomyRow,
} from "@/lib/taxonomy";

// Shared taxonomy plumbing for every client surface that renders the tag
// vocabulary: the upload page's preset chips (batch panel + per-image cards)
// and the browse page's taxonomy filter. The vocabulary is the user-editable
// taxonomy from Settings → Tag Settings, fetched once per page load.

// Offline/error fallback: the built-in sector taxonomy as rows.
function fallbackRows(): TaxonomyRow[] {
  return TAXONOMY.flatMap((m) =>
    m.coreSectors.map((c) => ({
      macro: m.name,
      core: c.name,
      tags: [...c.subSectors],
    }))
  );
}

// One /api/taxonomy fetch per page load, shared by every consumer — a folder
// drop renders one picker per image and must not fire a request per card.
let cachedRows: TaxonomyRow[] | null = null;
let inflight: Promise<TaxonomyRow[]> | null = null;

function loadTaxonomyRows(): Promise<TaxonomyRow[]> {
  if (cachedRows) return Promise.resolve(cachedRows);
  if (!inflight) {
    inflight = fetch("/api/taxonomy")
      .then((r) => r.json())
      .then((d) =>
        Array.isArray(d.rows) && d.rows.length
          ? (d.rows as TaxonomyRow[])
          : fallbackRows()
      )
      .catch(() => fallbackRows())
      .then((rows) => {
        cachedRows = rows;
        return rows;
      });
  }
  return inflight;
}

// Lets the Tag Settings page push its saved rows into this cache so the rest
// of the app picks up edits without a full reload.
export function primeTaxonomyRowsCache(rows: TaxonomyRow[]) {
  cachedRows = rows;
  inflight = null;
}

export function useTaxonomyRows(): TaxonomyRow[] | null {
  const [rows, setRows] = useState<TaxonomyRow[] | null>(cachedRows);

  useEffect(() => {
    let alive = true;
    loadTaxonomyRows().then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  return rows;
}

// The taxonomy as a tree, for the hierarchical picker (browse filters).
// Null while the first fetch is in flight.
export function useTaxonomyTree(): MacroPortfolio[] | null {
  const rows = useTaxonomyRows();
  return rows ? rowsToTree(rows) : null;
}

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
};

// The whole vocabulary in clickable chip-group form: two meta groups (all
// Macro Portfolios, all Core Sectors) followed by one group per taxonomy row.
// Null while the first fetch is still in flight.
export function useAllPresetGroups(): TagPresetGroup[] | null {
  const rows = useTaxonomyRows();
  if (!rows) return null;
  return [
    { group: "Macro Portfolio", tags: unique(rows.map((r) => r.macro)) },
    { group: "Core Sector", tags: unique(rows.map((r) => r.core)) },
    ...rows
      // A row whose only tag repeats its core name adds nothing beyond the
      // Core Sector chip above — hide it to keep the panel scannable.
      .filter(
        (r) =>
          r.tags.length > 1 ||
          (r.tags.length === 1 &&
            r.tags[0].toLowerCase() !== r.core.toLowerCase())
      )
      .map((r) => ({ group: `${r.macro} · ${r.core}`, tags: r.tags })),
  ];
}

// The grouped chip grid — clicking a Macro Portfolio filters and displays its
// Core Sectors and Sub-Sector typology tags below, allowing fast selection.
export function PresetGroupChips({
  groups: fallbackGroups,
  selected,
  onToggle,
  disabled,
}: {
  groups?: TagPresetGroup[];
  selected: string[];
  onToggle: (tag: string) => void;
  disabled?: boolean;
}) {
  const rows = useTaxonomyRows();
  const [selectedMacro, setSelectedMacro] = useState<string | null>(null);

  const isActive = (tag: string) =>
    selected.some((t) => t.toLowerCase() === tag.toLowerCase());

  const macros = rows ? unique(rows.map((r) => r.macro)) : [];

  useEffect(() => {
    if (!selectedMacro && selected.length > 0 && macros.length > 0) {
      const activeMacroTag = macros.find((m) => isActive(m));
      if (activeMacroTag) {
        setSelectedMacro(activeMacroTag);
      }
    }
  }, [selected, macros, selectedMacro]);

  if (!rows) {
    return (
      <div className="space-y-3">
        {(fallbackGroups || []).map((g) => (
          <div key={g.group}>
            <p className="mb-2 text-xs font-medium text-muted">
              {g.group}
            </p>
            <div className="flex flex-wrap gap-2">
              {g.tags.map((t) => {
                const active = isActive(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onToggle(t)}
                    disabled={disabled}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                      active
                        ? "bg-text text-surface"
                        : "border border-border text-muted hover:text-text"
                    }`}
                  >
                    {active ? "✓ " : ""}{t}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const activeMacro = selectedMacro && macros.includes(selectedMacro) ? selectedMacro : null;
  const filteredRows = activeMacro
    ? rows.filter((r) => r.macro.toLowerCase() === activeMacro.toLowerCase())
    : rows;

  return (
    <div className="space-y-3">
      {/* 1. Macro Portfolio Selection Chips */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-muted">
            Macro Portfolio
          </p>
          {activeMacro && (
            <button
              type="button"
              onClick={() => setSelectedMacro(null)}
              className="text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Show all categories
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {macros.map((m) => {
            const isSelected = activeMacro === m;
            const active = isActive(m);
            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  onToggle(m);
                  setSelectedMacro(m);
                }}
                disabled={disabled}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                  isSelected || active
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
              >
                {active ? "✓ " : ""}{m}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Core Sectors & Sub-Sector Typology Tags for the selected Macro Portfolio */}
      <div className="space-y-2 border-t border-border pt-2">
        {filteredRows.map((r) => (
          <div key={`${r.macro}-${r.core}`} className="rounded border border-border bg-bg p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium text-muted">
                {!activeMacro ? `${r.macro} · ` : ""}Core Sector:
              </span>
              <button
                type="button"
                onClick={() => onToggle(r.core)}
                disabled={disabled}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                  isActive(r.core)
                    ? "bg-text text-surface"
                    : "border border-border text-muted hover:text-text"
                }`}
              >
                {isActive(r.core) ? "✓ " : ""}{r.core}
              </button>
            </div>

            {r.tags && r.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 pl-1">
                {r.tags.map((t) => {
                  const active = isActive(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => onToggle(t)}
                      disabled={disabled}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                        active
                          ? "bg-text text-surface"
                          : "border border-border text-muted hover:text-text"
                      }`}
                    >
                      {active ? "✓ " : ""}{t}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
