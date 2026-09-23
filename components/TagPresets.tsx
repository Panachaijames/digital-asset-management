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
    <div className="mt-2 rounded border border-border bg-surface">
      <label className="flex cursor-pointer select-none items-center gap-2 px-4 py-3">
        <input
          type="checkbox"
          checked={open}
          onChange={() => setOpen((v) => !v)}
          className="h-4 w-4 accent-accent"
        />
        <span className="text-sm font-medium text-text">Tag Presets</span>
        <span className="text-xs text-muted">
          Click to toggle batch tags for every image in this queue
        </span>
      </label>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {!groups ? (
            <p className="text-xs text-muted">Loading presets</p>
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
