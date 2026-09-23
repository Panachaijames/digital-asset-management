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
            ? "mb-1 block text-xs font-medium text-muted"
            : "mb-2 block text-xs font-medium text-muted"
        }
      >
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-2 transition-colors focus-within:border-text">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/5 px-2 py-0.5 text-xs font-medium text-text"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
              className="text-muted transition-colors hover:text-text"
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
          placeholder={tags.length ? "Add tag" : "e.g. site-photos, bangkok, exterior"}
          className="min-w-[140px] flex-1 border-none bg-transparent py-0.5 text-sm text-text outline-none placeholder:text-muted"
        />
      </div>
      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </div>
  );
}
