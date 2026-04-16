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
  const blob = await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    },
    (meta) => onProgress?.(meta.percent)
  );
  saveAs(blob, `${batchName}.zip`);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
