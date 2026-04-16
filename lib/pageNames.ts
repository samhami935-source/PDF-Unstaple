import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
  PDFArray,
  PDFString,
  PDFHexString,
  PDFNumber,
} from "pdf-lib";

/**
 * Extract a human-readable per-page name from a PDF, using (in priority order):
 *   1. Outline/bookmark titles whose destination points at a page.
 *   2. PDF page labels (/PageLabels number tree).
 *
 * Returns an array of length pageCount. Entries are null where no name exists.
 */
export function extractPageNames(
  doc: PDFDocument,
  pageCount: number
): (string | null)[] {
  const pageIndex = buildPageRefIndex(doc);
  const fromOutlines = readOutlineTitles(doc, pageIndex, pageCount);
  const fromLabels = readPageLabels(doc, pageCount);

  const out: (string | null)[] = new Array(pageCount).fill(null);
  for (let i = 0; i < pageCount; i++) {
    const v = fromOutlines[i] ?? fromLabels[i] ?? null;
    out[i] = v ? normalizeWhitespace(v) : null;
  }
  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function decodePdfString(obj: unknown): string | null {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText();
    } catch {
      return null;
    }
  }
  return null;
}

function refKey(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber}`;
}

/** Map each page's object ref to its 0-based index. */
function buildPageRefIndex(doc: PDFDocument): Map<string, number> {
  const map = new Map<string, number>();
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i].ref;
    if (ref) map.set(refKey(ref), i);
  }
  return map;
}

function lookup(doc: PDFDocument, value: unknown): unknown {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

// ---------- Outlines ----------

function readOutlineTitles(
  doc: PDFDocument,
  pageIndex: Map<string, number>,
  pageCount: number
): (string | null)[] {
  const out: (string | null)[] = new Array(pageCount).fill(null);
  const catalog = doc.catalog;
  const outlinesObj = lookup(doc, catalog.get(PDFName.of("Outlines")));
  if (!(outlinesObj instanceof PDFDict)) return out;

  const namedDests = buildNamedDestMap(doc);

  // Track depth so the DEEPEST bookmark wins when multiple outline entries
  // point at the same page. Construction PDFs typically nest like
  // "APPROVAL > Sheet A-101" — we want "A-101", not "APPROVAL".
  const depth: number[] = new Array(pageCount).fill(-1);
  // Track whether an outline entry pointed at EXACTLY this page (vs. a range
  // header whose destination happens to fall on the section's first page).
  // A leaf with no children is a strong signal of a sheet-level bookmark.
  const isLeaf: boolean[] = new Array(pageCount).fill(false);

  const visit = (nodeRef: unknown, currentDepth: number) => {
    const node = lookup(doc, nodeRef);
    if (!(node instanceof PDFDict)) return;

    const title = decodePdfString(node.get(PDFName.of("Title")));
    const pageIdx = resolveDestPageIndex(doc, node, pageIndex, namedDests);
    const firstChild = node.get(PDFName.of("First"));
    const hasChildren = firstChild instanceof PDFRef;

    if (title && pageIdx !== null) {
      const newLeaf = !hasChildren;
      const prevDepth = depth[pageIdx];
      const prevLeaf = isLeaf[pageIdx];
      // Selection order, best first:
      //   1. Nothing recorded yet.
      //   2. Current is a leaf and existing is not.
      //   3. Same leaf/non-leaf class and current is deeper (or equal, so
      //      the last-visited sibling wins on ties).
      const prefer =
        prevDepth === -1 ||
        (newLeaf && !prevLeaf) ||
        (newLeaf === prevLeaf && currentDepth >= prevDepth);

      if (prefer) {
        out[pageIdx] = title;
        depth[pageIdx] = currentDepth;
        isLeaf[pageIdx] = newLeaf;
      }
    }

    visit(firstChild, currentDepth + 1);
    visit(node.get(PDFName.of("Next")), currentDepth);
  };

  visit(outlinesObj.get(PDFName.of("First")), 0);
  return out;
}

function resolveDestPageIndex(
  doc: PDFDocument,
  node: PDFDict,
  pageIndex: Map<string, number>,
  namedDests: Map<string, unknown>
): number | null {
  let dest: unknown = node.get(PDFName.of("Dest"));
  if (!dest) {
    const action = lookup(doc, node.get(PDFName.of("A")));
    if (action instanceof PDFDict) dest = action.get(PDFName.of("D"));
  }
  dest = lookup(doc, dest);

  // Named destination: Name or String -> look up
  if (dest instanceof PDFName) {
    const key = dest.asString().replace(/^\//, "");
    dest = lookup(doc, namedDests.get(key));
  } else if (dest instanceof PDFString || dest instanceof PDFHexString) {
    const key = decodePdfString(dest);
    if (key) dest = lookup(doc, namedDests.get(key));
  }

  // Dest may be wrapped in a dict { D: [...] }
  if (dest instanceof PDFDict) {
    dest = lookup(doc, dest.get(PDFName.of("D")));
  }

  if (dest instanceof PDFArray && dest.size() > 0) {
    const pageRef = dest.get(0);
    if (pageRef instanceof PDFRef) {
      const idx = pageIndex.get(refKey(pageRef));
      return idx ?? null;
    }
  }
  return null;
}

function buildNamedDestMap(doc: PDFDocument): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const catalog = doc.catalog;

  // PDF 1.1 style: /Dests dict in catalog (keys are names)
  const dests = lookup(doc, catalog.get(PDFName.of("Dests")));
  if (dests instanceof PDFDict) {
    for (const [key, value] of dests.entries()) {
      map.set(key.asString().replace(/^\//, ""), value);
    }
  }

  // PDF 1.2+ style: /Names/Dests name tree (keys are strings)
  const names = lookup(doc, catalog.get(PDFName.of("Names")));
  if (names instanceof PDFDict) {
    const destsTree = lookup(doc, names.get(PDFName.of("Dests")));
    if (destsTree instanceof PDFDict) {
      walkNameTree(doc, destsTree, map);
    }
  }
  return map;
}

function walkNameTree(
  doc: PDFDocument,
  node: PDFDict,
  out: Map<string, unknown>
) {
  const names = node.get(PDFName.of("Names"));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const key = names.get(i);
      const val = names.get(i + 1);
      const keyStr = decodePdfString(key);
      if (keyStr) out.set(keyStr, val);
    }
  }
  const kids = node.get(PDFName.of("Kids"));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = lookup(doc, kids.get(i));
      if (kid instanceof PDFDict) walkNameTree(doc, kid, out);
    }
  }
}

// ---------- Page Labels ----------

function readPageLabels(doc: PDFDocument, pageCount: number): (string | null)[] {
  const out: (string | null)[] = new Array(pageCount).fill(null);
  const plRoot = lookup(doc, doc.catalog.get(PDFName.of("PageLabels")));
  if (!(plRoot instanceof PDFDict)) return out;

  const ranges: Array<[number, PDFDict]> = [];
  collectPageLabelNums(doc, plRoot, ranges);
  if (ranges.length === 0) return out;
  ranges.sort((a, b) => a[0] - b[0]);

  for (let p = 0; p < pageCount; p++) {
    let active: [number, PDFDict] | null = null;
    for (const r of ranges) {
      if (r[0] <= p) active = r;
      else break;
    }
    if (!active) continue;
    const [start, dict] = active;
    const prefix = decodePdfString(dict.get(PDFName.of("P"))) ?? "";
    const styleObj = dict.get(PDFName.of("S"));
    const style =
      styleObj instanceof PDFName ? styleObj.asString().replace(/^\//, "") : null;
    const stObj = dict.get(PDFName.of("St"));
    const stNum = stObj instanceof PDFNumber ? stObj.asNumber() : 1;
    const n = stNum + (p - start);

    let numPart = "";
    switch (style) {
      case "D":
        numPart = String(n);
        break;
      case "R":
        numPart = toRoman(n).toUpperCase();
        break;
      case "r":
        numPart = toRoman(n);
        break;
      case "A":
        numPart = toAlpha(n).toUpperCase();
        break;
      case "a":
        numPart = toAlpha(n);
        break;
      default:
        numPart = "";
    }
    const label = `${prefix}${numPart}`;
    out[p] = label.length > 0 ? label : null;
  }
  return out;
}

function collectPageLabelNums(
  doc: PDFDocument,
  node: PDFDict,
  out: Array<[number, PDFDict]>
) {
  const nums = node.get(PDFName.of("Nums"));
  if (nums instanceof PDFArray) {
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const idx = nums.get(i);
      const valRaw = nums.get(i + 1);
      const val = lookup(doc, valRaw);
      if (idx instanceof PDFNumber && val instanceof PDFDict) {
        out.push([idx.asNumber(), val]);
      }
    }
  }
  const kids = node.get(PDFName.of("Kids"));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = lookup(doc, kids.get(i));
      if (kid instanceof PDFDict) collectPageLabelNums(doc, kid, out);
    }
  }
}

function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const map: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let s = "";
  for (const [v, r] of map) {
    while (n >= v) { s += r; n -= v; }
  }
  return s;
}

function toAlpha(n: number): string {
  if (n <= 0) return "";
  // 1->a, 26->z, 27->aa, 28->bb, ... (PDF spec)
  const letter = String.fromCharCode("a".charCodeAt(0) + ((n - 1) % 26));
  const repeats = Math.floor((n - 1) / 26) + 1;
  return letter.repeat(repeats);
}
