import { PDFDocument } from "pdf-lib";
import { extractPageNames } from "./pageNames";

export interface SplitPage {
  index: number;         // 0-based original page index
  name: string;          // filename (without folder)
  label: string | null;  // sheet name / bookmark label if the source PDF had one
  bytes: Uint8Array;     // the one-page PDF
  size: number;          // bytes
}

export interface SplitResult {
  baseName: string;      // sanitized original name without extension
  pages: SplitPage[];
}

const INVALID_FS_CHARS = /[\\/:*?"<>|\x00-\x1F]/g;

export function sanitizeBaseName(name: string): string {
  const withoutExt = name.replace(/\.pdf$/i, "");
  const cleaned = withoutExt
    .replace(INVALID_FS_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "document";
}

/** Sanitize a sheet label for use inside a filename. */
export function sanitizeLabel(label: string): string {
  return label
    .replace(INVALID_FS_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Ensure every output filename is unique within the batch. */
function dedupeNames<T extends { name: string }>(items: T[]): void {
  const seen = new Map<string, number>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      const dot = item.name.lastIndexOf(".");
      const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
      const ext = dot > 0 ? item.name.slice(dot) : "";
      item.name = `${stem} (${count + 1})${ext}`;
    }
    seen.set(key, count + 1);
  }
}

export function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

/** Verify the file starts with the PDF magic bytes `%PDF-`. */
export async function isPdfFile(file: File): Promise<boolean> {
  if (file.size < 5) return false;
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return (
    head[0] === 0x25 && // %
    head[1] === 0x50 && // P
    head[2] === 0x44 && // D
    head[3] === 0x46 && // F
    head[4] === 0x2d    // -
  );
}

/**
 * Split a PDF into one single-page PDF per page, preserving page order.
 * onProgress reports pages completed / total.
 */
export async function splitPdf(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<SplitResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageCount = source.getPageCount();
  if (pageCount === 0) throw new Error("PDF contains no pages.");

  const baseName = sanitizeBaseName(file.name);
  const width = Math.max(3, String(pageCount).length);
  const pageNames = extractPageNames(source, pageCount);
  const pages: SplitPage[] = [];

  const now = new Date();
  for (let i = 0; i < pageCount; i++) {
    const label = pageNames[i];
    const cleanLabel = label ? sanitizeLabel(label) : null;
    // Keep a zero-padded prefix so files sort in page order; append the sheet
    // label if we found one ("01 - A-101.pdf"), otherwise fall back to
    // "page-NNN" so every page still has a deterministic filename.
    const stem = cleanLabel
      ? `${pad(i + 1, width)} - ${cleanLabel}`
      : `page-${pad(i + 1, width)}`;
    const titleMeta = cleanLabel ?? `${baseName}-page-${pad(i + 1, width)}`;

    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(source, [i]);
    out.addPage(copied);
    // Give each split file a unique Title/Subject so tools like OST that
    // label by PDF metadata (not just filename) show the correct page name.
    out.setTitle(titleMeta);
    out.setSubject(`Page ${i + 1} of ${pageCount} from ${baseName}`);
    out.setAuthor(source.getAuthor() ?? "");
    out.setKeywords([baseName, `page-${pad(i + 1, width)}`, ...(cleanLabel ? [cleanLabel] : [])]);
    out.setProducer("PDF Unstapler");
    out.setCreator("PDF Unstapler");
    out.setCreationDate(now);
    out.setModificationDate(now);
    const pageBytes = await out.save({ useObjectStreams: true });
    pages.push({
      index: i,
      name: `${stem}.pdf`,
      label: cleanLabel,
      bytes: pageBytes,
      size: pageBytes.byteLength,
    });
    onProgress?.(i + 1, pageCount);
    // Yield to the event loop so the UI can update on large docs.
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }

  dedupeNames(pages);
  return { baseName, pages };
}
