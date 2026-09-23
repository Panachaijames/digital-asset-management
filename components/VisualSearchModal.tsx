"use client";

import { useState, useRef, useEffect, useCallback, type DragEvent } from "react";
import type { VisualSearchResponse } from "@/lib/types";

interface VisualSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSearchComplete: (
    response: VisualSearchResponse,
    queryPreviewUrl: string
  ) => void;
}

export default function VisualSearchModal({
  isOpen,
  onClose,
  onSearchComplete,
}: VisualSearchModalProps) {
  const [dragOver, setDragOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<
    "idle" | "analyzing" | "searching"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state on modal open/close
  useEffect(() => {
    if (!isOpen) {
      setPreviewUrl(null);
      setSelectedFile(null);
      setLoading(false);
      setLoadingPhase("idle");
      setError(null);
    }
  }, [isOpen]);

  // Handle file selection
  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Please select a valid image file (JPG, PNG, WebP, etc.)");
      return;
    }
    setError(null);
    setSelectedFile(file);
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
  }, []);

  // Global paste handler when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) {
            handleFile(file);
            e.preventDefault();
            break;
          }
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [isOpen, handleFile]);

  // Esc key closes modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, loading, onClose]);

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFile(files[0]);
    }
  };

  const runVisualSearch = async () => {
    if (!selectedFile || loading) return;

    setLoading(true);
    setError(null);
    setLoadingPhase("analyzing");

    try {
      const formData = new FormData();
      formData.append("image", selectedFile);

      // Transition phase after 1s for better UX feedback
      const phaseTimer = setTimeout(() => {
        setLoadingPhase("searching");
      }, 1200);

      const res = await fetch("/api/visual-search", {
        method: "POST",
        body: formData,
      });

      clearTimeout(phaseTimer);

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Visual search failed.");
      }

      onSearchComplete(data as VisualSearchResponse, previewUrl || "");
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to execute visual search."
      );
    } finally {
      setLoading(false);
      setLoadingPhase("idle");
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search by image"
      className="fixed inset-0 z-50 flex items-center justify-center bg-text/40 p-4"
      onClick={() => {
        if (!loading) onClose();
      }}
    >
      <div
        className="relative w-full max-w-lg rounded border border-border bg-surface p-4 shadow-menu"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-bg text-muted">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-4 w-4"
              >
                <path
                  d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-medium text-text">
                Search by image
              </h2>
              <p className="mt-1 text-xs text-muted">
                Find visually similar images across the library
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded p-1 text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-50"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-4 w-4"
            >
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="mt-4 space-y-4">
          {!previewUrl ? (
            /* Dropzone */
            <div
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded border border-dashed p-8 text-center transition-colors ${
                dragOver
                  ? "border-accent bg-accent/5"
                  : "border-border bg-bg hover:border-text"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/tiff"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-muted">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <path
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="mt-3 text-sm font-medium text-text">
                Drag and drop an image here, or{" "}
                <span className="text-accent underline">browse</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                You can also paste an image from your clipboard (Ctrl+V)
              </p>
              <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                <span className="rounded-full border border-border px-2 py-0.5 font-medium">
                  JPG
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 font-medium">
                  PNG
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 font-medium">
                  WebP
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 font-medium">
                  HEIC
                </span>
              </div>
            </div>
          ) : (
            /* Selected Image Preview */
            <div className="space-y-4">
              <div className="relative flex items-center gap-4 rounded border border-border bg-bg p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl}
                  alt="Query image"
                  className="h-24 w-24 shrink-0 rounded border border-border object-cover"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium text-text">
                    {selectedFile?.name || "Uploaded image"}
                  </p>
                  <p className="text-xs text-muted">
                    {selectedFile
                      ? `${(selectedFile.size / 1024).toFixed(0)} KB`
                      : ""}
                  </p>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewUrl(null);
                        setSelectedFile(null);
                        setError(null);
                      }}
                      disabled={loading}
                      className="text-xs font-medium text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-50"
                    >
                      Change image
                    </button>
                  </div>
                </div>
              </div>

              {/* Loading Status Indicator */}
              {loading && (
                <div className="flex items-center gap-3 rounded border border-accent/25 bg-accent/5 p-4 text-sm text-text">
                  <div className="h-4 w-4 shrink-0 animate-spin rounded-full border border-accent border-t-transparent" />
                  <div>
                    <p className="font-medium">
                      {loadingPhase === "analyzing"
                        ? "Analysing visual features and space typology"
                        : "Searching the image library"}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Extracting architectural elements, lighting and materials,
                      then matching the catalogue
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded border border-danger/25 bg-danger/5 p-3 text-xs text-danger">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="inline-flex items-center rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:pointer-events-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={runVisualSearch}
            disabled={!selectedFile || loading}
            className="inline-flex items-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border border-on-accent border-t-transparent" />
                <span>Searching</span>
              </>
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-4 w-4"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" strokeLinecap="round" />
                </svg>
                <span>Find similar images</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
