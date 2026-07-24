"use client";

import { useState } from "react";
import { PresetGroupChips, useAllPresetGroups } from "@/components/PresetChips";

interface TagPresetsProps {
  selected: string[];
  onToggle: (tag: string) => void;
  disabled?: boolean;
}

// Grouped preset tag library (taxonomy + Supabase common_dam_presets via the
// shared loader in PresetChips.tsx). Clicking a chip toggles that tag into
// the BATCH tags — every image in the queue gets these on upload.
export default function TagPresets({
  selected,
  onToggle,
  disabled,
}: TagPresetsProps) {
  const [open, setOpen] = useState(true);
  const groups = useAllPresetGroups();

  return (
    <div className="mt-2 rounded-sm border border-line bg-panel/60">
      <label className="flex cursor-pointer select-none items-center gap-2 px-3 py-2">
        <input
          type="checkbox"
          checked={open}
          onChange={() => setOpen((v) => !v)}
          className="h-3.5 w-3.5 accent-blueprint-600"
        />
        <span className="text-xs font-medium text-blueprint-400">Presets</span>
        <span className="text-[11px] text-ink/30">
          click to toggle · added to every image · use an image&apos;s own
          “add from presets” for just that image
        </span>
      </label>

      {open && (
        <div className="border-t border-line/60 px-3 py-3">
          {!groups ? (
            <p className="text-xs text-ink/40">Loading presets…</p>
          ) : (
            <PresetGroupChips
              groups={groups}
              selected={selected}
              onToggle={onToggle}
              disabled={disabled}
            />
          )}
        </div>
      )}
    </div>
  );
}
