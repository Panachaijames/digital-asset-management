"use client";

/* Which library /browse reads: the current library (v1, the one every write
   control acts on) or the read-only preview of the project-based library (v2).
   Rendered only when the server's DAM_V2_BROWSE switch is not "off", as
   reported by GET /api/v2/status. A pill pair in the /browse toolbar-pill
   pattern: active is the text colour filled, idle is a hairline. */

export type LibrarySource = "v1" | "v2";

const OPTIONS: { value: LibrarySource; label: string }[] = [
  { value: "v1", label: "Current library" },
  { value: "v2", label: "Project library" },
];

export default function LibrarySourceToggle({
  value,
  onChange,
}: {
  value: LibrarySource;
  onChange: (next: LibrarySource) => void;
}) {
  return (
    <div role="group" aria-label="Library" className="flex items-center gap-1">
      {OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "border-text bg-text text-surface"
                : "border-border bg-surface text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
