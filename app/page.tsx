"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { isPdfFile, sanitizeBaseName, splitPdf, type SplitPage } from "@/lib/splitPdf";
import { exportZip, formatBytes } from "@/lib/zipExport";

type Stage = "idle" | "loading" | "ready" | "zipping";

export default function HomePage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [zipProgress, setZipProgress] = useState(0);
  const [pages, setPages] = useState<SplitPage[]>([]);
  const [batchName, setBatchName] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(
    () => pages.reduce((n, p) => n + p.size, 0),
    [pages]
  );

  const reset = useCallback(() => {
    setStage("idle");
    setError(null);
    setProgress({ done: 0, total: 0 });
    setZipProgress(0);
    setPages([]);
    setBatchName("");
    setOriginalName("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    const nameOk = file.name.toLowerCase().endsWith(".pdf");
    const typeOk = !file.type || file.type === "application/pdf";
    if (!nameOk || !typeOk) {
      setError("That doesn't look like a PDF. Please upload a .pdf file.");
      return;
    }
    if (!(await isPdfFile(file))) {
      setError("File failed PDF validation (missing %PDF header).");
      return;
    }
    setOriginalName(file.name);
    setBatchName(sanitizeBaseName(file.name));
    setStage("loading");
    setProgress({ done: 0, total: 0 });
    try {
      const result = await splitPdf(file, (done, total) =>
        setProgress({ done, total })
      );
      setPages(result.pages);
      setStage("ready");
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message.includes("encrypted")
            ? "This PDF is encrypted/password-protected. Please decrypt it first."
            : e.message
          : "Failed to split the PDF.";
      setError(msg);
      setStage("idle");
    }
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const removePage = (index: number) => {
    setPages((prev) => prev.filter((p) => p.index !== index));
  };

  const downloadOne = (p: SplitPage) => {
    const blob = new Blob([p.bytes], { type: "application/pdf" });
    saveAs(blob, p.name);
  };

  const handleExportZip = async () => {
    if (pages.length === 0) return;
    setStage("zipping");
    setZipProgress(0);
    try {
      const safeBatch = sanitizeBaseName(batchName || "batch");
      await exportZip(pages, safeBatch, (pct) => setZipProgress(pct));
      setStage("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build ZIP.");
      setStage("ready");
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          PDF Unstapler
        </h1>
        <p className="mt-1 text-slate-600">
          Upload a PDF, split every page into its own file, and export the batch as a ZIP.
          Everything runs in your browser — nothing is uploaded to a server.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-700 hover:text-red-900"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {stage === "idle" && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={[
            "rounded-2xl border-2 border-dashed bg-white p-12 text-center transition",
            dragOver
              ? "border-brand-500 bg-brand-50"
              : "border-slate-300 hover:border-slate-400",
          ].join(" ")}
        >
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-100 text-brand-600">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-lg font-medium">Drop a PDF here, or click to upload</p>
          <p className="mt-1 text-sm text-slate-500">One PDF at a time. Max size limited only by your browser.</p>
          <div className="mt-6">
            <button
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
            >
              Choose PDF
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={onInputChange}
              className="hidden"
            />
          </div>
        </div>
      )}

      {stage === "loading" && (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-brand-600" />
          <p className="text-lg font-medium">Splitting {originalName}…</p>
          <p className="mt-1 text-sm text-slate-500">
            {progress.total > 0
              ? `Page ${progress.done} of ${progress.total}`
              : "Reading PDF…"}
          </p>
          {progress.total > 0 && (
            <div className="mx-auto mt-4 h-2 w-full max-w-sm overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-brand-600 transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {(stage === "ready" || stage === "zipping") && (
        <section className="space-y-5">
          <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                Batch name
              </label>
              <input
                type="text"
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <p className="mt-1 text-xs text-slate-500">
                {pages.length} {pages.length === 1 ? "page" : "pages"} · {formatBytes(totalSize)} · from{" "}
                <span className="font-medium">{originalName}</span>
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={reset}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Reset
              </button>
              <button
                onClick={handleExportZip}
                disabled={stage === "zipping" || pages.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {stage === "zipping"
                  ? `Zipping… ${Math.round(zipProgress)}%`
                  : "Export ZIP"}
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 md:grid-cols-3">
              {pages.map((p) => (
                <div
                  key={p.index}
                  className="flex items-center gap-3 border-slate-100 p-4 sm:border-b md:border-r"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-red-50 text-red-600">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <path d="M14 2v6h6" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={p.name}>
                      {p.label ?? `Page ${p.index + 1}`}
                    </p>
                    <p className="truncate text-xs text-slate-500" title={p.name}>
                      {p.name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatBytes(p.size)}
                      {p.label ? " · sheet label detected" : " · no label in PDF"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => downloadOne(p)}
                      className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                      title="Download this page"
                      aria-label={`Download ${p.name}`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      onClick={() => removePage(p.index)}
                      className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                      title="Remove from batch"
                      aria-label={`Remove ${p.name}`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {pages.length === 0 && (
              <div className="p-8 text-center text-sm text-slate-500">
                No pages in this batch. Reset to start over.
              </div>
            )}
          </div>
        </section>
      )}

      <footer className="mt-12 text-center text-xs text-slate-400">
        Client-side only · pdf-lib + JSZip
      </footer>
    </main>
  );
}
