import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";

/**
 * pdf-lib's copyPages() deep-copies everything a page references. Many
 * construction PDFs share ONE /Resources dictionary (every sheet's images and
 * fonts) across all pages, and carry hyperlinks to other sheets. Copying a
 * single page then drags in the whole document, so every split file ends up
 * nearly as large as the original.
 *
 * isolatePage() temporarily rewrites the source page so it references only
 * what it actually draws, runs `fn` (the copy), then restores the source.
 */
export async function withIsolatedPage<T>(
  source: PDFDocument,
  pageIndex: number,
  fn: () => Promise<T>
): Promise<T> {
  const leaf = source.getPage(pageIndex).node;
  const ctx = source.context;
  const restores: Array<() => void> = [];

  const setTemp = (dict: PDFDict, key: string, value: unknown | undefined) => {
    const name = PDFName.of(key);
    const had = dict.has(name);
    const prev = dict.get(name);
    if (value === undefined) dict.delete(name);
    else dict.set(name, value as never);
    restores.push(() => {
      if (had && prev !== undefined) dict.set(name, prev);
      else dict.delete(name);
    });
  };

  try {
    // 1. Prune the resource dictionary down to names the page content uses.
    const pruned = buildPrunedResources(source, leaf);
    if (pruned) setTemp(leaf, "Resources", pruned);

    // 2. Drop links to other pages and annotation back-pointers to the page,
    //    either of which would pull other pages (and their images) into the copy.
    const annots = lookup(source, leaf.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray) {
      const kept = ctx.obj([]) as PDFArray;
      for (let i = 0; i < annots.size(); i++) {
        const raw = annots.get(i);
        const annot = lookup(source, raw);
        if (!(annot instanceof PDFDict)) continue;
        if (pointsToAnotherPage(source, annot)) continue;
        if (annot.has(PDFName.of("P"))) setTemp(annot, "P", undefined);
        kept.push(raw);
      }
      setTemp(leaf, "Annots", kept.size() > 0 ? kept : undefined);
    }

    // 3. Article beads link into a document-wide thread structure.
    if (leaf.has(PDFName.of("B"))) setTemp(leaf, "B", undefined);

    return await fn();
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]();
  }
}

const PRUNABLE = [
  "XObject",
  "Font",
  "ExtGState",
  "Pattern",
  "Shading",
  "ColorSpace",
  "Properties",
];

function lookup(doc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

/** Decode a content stream (or array of streams) to a latin1 string. */
function decodeContent(doc: PDFDocument, contents: unknown): string | null {
  const resolved = lookup(doc, contents);
  const streams: unknown[] = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) streams.push(lookup(doc, resolved.get(i)));
  } else if (resolved !== undefined) {
    streams.push(resolved);
  }
  let out = "";
  for (const s of streams) {
    if (!(s instanceof PDFRawStream)) return null; // can't decode -> don't prune
    try {
      const bytes = decodePDFRawStream(s).decode();
      for (let i = 0; i < bytes.length; i += 0x8000) {
        out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      out += "\n";
    } catch {
      return null;
    }
  }
  return out;
}

const NAME_TOKEN = /\/[^\s/[\]()<>{}%]+/g;

function collectNames(content: string, into: Set<string>) {
  const matches = content.match(NAME_TOKEN);
  if (matches) for (const m of matches) into.add(m);
}

/**
 * Build a copy of the page's (possibly inherited) /Resources containing only
 * entries whose names appear in the page content. Returns null when the content
 * can't be decoded, in which case we leave the page untouched (correct, just big).
 */
function buildPrunedResources(doc: PDFDocument, leaf: PDFDict): PDFDict | null {
  const resources = lookup(doc, (leaf as unknown as { Resources(): unknown }).Resources());
  if (!(resources instanceof PDFDict)) return null;
  const content = decodeContent(doc, leaf.get(PDFName.of("Contents")));
  if (content === null) return null;

  const used = new Set<string>();
  collectNames(content, used);

  // Form XObjects without their own /Resources inherit the page's, so their
  // content counts as page usage too. Iterate until no new names appear.
  const xobjects = lookup(doc, resources.get(PDFName.of("XObject")));
  if (xobjects instanceof PDFDict) {
    const scanned = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [key, value] of xobjects.entries()) {
        const k = key.asString();
        if (!used.has(k) || scanned.has(k)) continue;
        scanned.add(k);
        const xo = lookup(doc, value);
        if (!(xo instanceof PDFStream)) continue;
        const subtype = xo.dict.get(PDFName.of("Subtype"));
        if (subtype !== PDFName.of("Form") || xo.dict.has(PDFName.of("Resources"))) continue;
        const sub = decodeContent(doc, xo);
        if (sub === null) return null;
        const before = used.size;
        collectNames(sub, used);
        if (used.size > before) grew = true;
      }
    }
  }

  const pruned = doc.context.obj({}) as PDFDict;
  for (const [key, value] of resources.entries()) {
    if (!PRUNABLE.includes(key.decodeText())) {
      pruned.set(key, value);
      continue;
    }
    const sub = lookup(doc, value);
    if (!(sub instanceof PDFDict)) {
      pruned.set(key, value);
      continue;
    }
    const keptSub = doc.context.obj({}) as PDFDict;
    for (const [name, ref] of sub.entries()) {
      if (used.has(name.asString())) keptSub.set(name, ref);
    }
    if (keptSub.keys().length > 0) pruned.set(key, keptSub);
  }
  return pruned;
}

/** True if a (link) annotation's destination targets a page object. */
function pointsToAnotherPage(doc: PDFDocument, annot: PDFDict): boolean {
  if (annot.has(PDFName.of("Dest"))) return true;
  const action = lookup(doc, annot.get(PDFName.of("A")));
  if (action instanceof PDFDict) {
    const s = action.get(PDFName.of("S"));
    if (s === PDFName.of("GoTo") || action.has(PDFName.of("D"))) return true;
  }
  return false;
}
