"use client";

import { TAXONOMY, coreSectorsFor, subSectorsFor } from "@/lib/taxonomy";
import { useTaxonomyTree } from "@/components/PresetChips";
import type { TaxonomySelection } from "@/lib/types";

interface TaxonomyPickerProps {
  value: TaxonomySelection;
  onChange: (value: TaxonomySelection) => void;
  disabled?: boolean;
  compact?: boolean;
}

function Chip({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        active
          ? "border-text bg-text text-surface"
          : "border-border text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

export default function TaxonomyPicker({
  value,
  onChange,
  disabled,
  compact,
}: TaxonomyPickerProps) {
  // The user-editable taxonomy; built-in defaults until the fetch lands.
  const taxonomy = useTaxonomyTree() ?? TAXONOMY;
  const cores = coreSectorsFor(value.macro_portfolio, taxonomy);
  const subs = subSectorsFor(value.macro_portfolio, value.core_sector, taxonomy);

  const pickMacro = (macro: string) => {
    if (macro === value.macro_portfolio) return;
    // Switching macro resets the levels below it.
    onChange({ macro_portfolio: macro, core_sector: null, sub_sectors: [] });
  };

  const pickCore = (core: string) => {
    if (core === value.core_sector) return;
    onChange({ ...value, core_sector: core, sub_sectors: [] });
  };

  const toggleSub = (sub: string) => {
    const next = value.sub_sectors.includes(sub)
      ? value.sub_sectors.filter((s) => s !== sub)
      : [...value.sub_sectors, sub];
    onChange({ ...value, sub_sectors: next });
  };

  const labelCls = compact
    ? "text-xs font-medium text-muted"
    : "mb-1 block text-xs font-medium text-muted";

  return (
    <div className="space-y-3">
      <div>
        <span className={labelCls}>Portfolio</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {taxonomy.map((m) => (
            <Chip
              key={m.name}
              label={m.name}
              active={value.macro_portfolio === m.name}
              onClick={() => pickMacro(m.name)}
              disabled={disabled}
            />
          ))}
        </div>
      </div>

      {cores.length > 0 && (
        <div>
          <span className={labelCls}>Sector</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {cores.map((c) => (
              <Chip
                key={c.name}
                label={c.name}
                active={value.core_sector === c.name}
                onClick={() => pickCore(c.name)}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      )}

      {subs.length > 0 && (
        <div>
          <span className={labelCls}>Typology</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {subs.map((s) => (
              <Chip
                key={s}
                label={s}
                active={value.sub_sectors.includes(s)}
                onClick={() => toggleSub(s)}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
