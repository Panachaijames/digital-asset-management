"use client";

import { useState, type KeyboardEvent } from "react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  label?: string;
  hint?: string | null;
  compact?: boolean;
}

export default function TagInput({
  tags,
  onChange,
  label = "Tags",
  hint = "Press Enter or comma to add. These tags apply to every image in this batch.",
  compact = false,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    const value = draft.trim().replace(/,$/, "");
    if (value && !tags.includes(value)) {
      onChange([...tags, value]);
    }
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && draft === "" && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div>
      <label
        className={
          compact
            ? "block text-[10px] uppercase tracking-wider text-ink/40 mb-1"
            : "block text-sm font-medium text-ink/70 mb-2"
        }
      >
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2 rounded-sm border border-line bg-card px-3 py-2 focus-within:border-blueprint-400">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-sm bg-blueprint-50 px-2 py-1 font-mono text-xs text-blueprint-700"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
              className="text-blueprint-400 hover:text-blueprint-700"
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitDraft}
          placeholder={tags.length ? "+ add tag" : "e.g. site-photos, bangkok, exterior"}
          className="min-w-[140px] flex-1 border-none bg-transparent py-0.5 text-sm outline-none placeholder:text-ink/30"
        />
      </div>
      {hint && <p className="mt-1.5 text-xs text-ink/40">{hint}</p>}
    </div>
  );
}
