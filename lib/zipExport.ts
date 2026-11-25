import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { SplitPage } from "./splitPdf";

export async function exportZip(
  pages: SplitPage[],
  batchName: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  const zip = new JSZip();
  const folder = zip.folder(batchName) ?? zip;
  for (const p of pages) {
    folder.file(p.name, p.bytes);
  }
  let blob: Blob;
  try {
    blob = await zip.generateAsync(
      {
        type: "blob",
        // PDFs are already compressed internally; STORE avoids burning CPU and
        // a second in-memory copy of every file for ~0% size savings.
        compression: "STORE",
        streamFiles: true,
      },
      (meta) => onProgress?.(meta.percent)
    );
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error(
        "This batch is too large for the browser to zip in memory. Try removing some pages, or download pages individually."
      );
    }
    throw e;
  }
  saveAs(blob, `${batchName}.zip`);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
