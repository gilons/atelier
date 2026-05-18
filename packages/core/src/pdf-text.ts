/**
 * Plain-text extraction for `.pdf` files via pdfjs-dist (legacy
 * build for Node — the modern build leans on browser globals like
 * `DOMMatrix` that Node hasn't shipped).
 *
 * For text-bearing PDFs (Word→PDF exports, LaTeX, real digital
 * documents) this produces a faithful page-by-page rendering. For
 * image-only / scanned PDFs the extracted text is empty — pdfjs
 * doesn't do OCR. The caller handles the empty-body case by falling
 * back to "no extractable text" alongside the preserved original.
 *
 * Why a wrapper module rather than calling pdfjs inline from the
 * adapter? Three reasons:
 *
 *   1. pdfjs's API is async-only and chatty. Wrapping it lets the
 *      adapter stay focused on Graph semantics.
 *   2. The legacy-build import path is unusual (`pdfjs-dist/legacy
 *      /build/pdf.mjs`); concentrating that detail here means the
 *      adapter doesn't need to know.
 *   3. Tests can stub the wrapper rather than the entire pdfjs
 *      surface when an adapter test wants to exercise routing
 *      without a full PDF fixture.
 */

import { decodeXmlEntities } from "./ooxml-text.js";

/**
 * Render a `.pdf` binary as markdown. Each page becomes a section
 * with a `## Page N` heading; the text items are joined into
 * paragraphs heuristically (a y-position gap → new line).
 *
 * Throws when the buffer isn't a parsable PDF — the adapter
 * surfaces that as a clear stub in the doc body.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfjs = await loadPdfjs();
  // Use a fresh Uint8Array because pdfjs transfers ownership of
  // the buffer (it nulls our reference internally). Passing a
  // sliced copy keeps the caller's Buffer usable afterwards —
  // important because the sync engine also preserves the bytes
  // on disk after extraction.
  const data = new Uint8Array(buffer);
  const loading = pdfjs.getDocument({
    data,
    // Suppress pdfjs's console noise. We surface failures to the
    // adapter ourselves; their internal warnings about indexing
    // and font fallbacks aren't actionable for end users.
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loading.promise;
  try {
    const sections: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const tc = await page.getTextContent();
      const pageText = itemsToMarkdown(tc.items);
      sections.push(`## Page ${pageNum}\n\n${pageText}`.trimEnd());
    }
    return sections.join("\n\n").trimEnd() + (sections.length > 0 ? "\n" : "");
  } finally {
    // Release pdfjs's internal worker resources so the process
    // doesn't accumulate them across many doc syncs.
    await pdf.cleanup();
    pdf.destroy();
  }
}

/**
 * Join pdfjs text items into paragraphs. pdfjs returns items in
 * reading order with each item's position; a vertical jump signals
 * a new line. We use a simple "y differs by more than the item's
 * own height" heuristic — works for typical document layouts.
 * Word-internal spacing is preserved verbatim from the item strings.
 */
function itemsToMarkdown(items: unknown[]): string {
  let lastY: number | undefined;
  const lines: string[] = [];
  let buf = "";
  for (const raw of items) {
    const item = raw as {
      str?: string;
      hasEOL?: boolean;
      transform?: number[];
      height?: number;
    };
    const str = item.str ?? "";
    const y = item.transform ? item.transform[5] : undefined;
    const height = item.height ?? 12;
    // Explicit end-of-line marker from pdfjs trumps geometry.
    if (item.hasEOL) {
      buf += str;
      lines.push(buf);
      buf = "";
      lastY = y;
      continue;
    }
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > height * 0.6) {
      if (buf.length > 0) lines.push(buf);
      buf = str;
    } else {
      buf += str;
    }
    lastY = y;
  }
  if (buf.length > 0) lines.push(buf);
  // Decode any XML-style entities that snuck in via embedded
  // fonts' ToUnicode CMaps. Most PDFs don't, but it's cheap
  // insurance.
  return lines.map((l) => decodeXmlEntities(l).trimEnd()).join("\n");
}

// ============================================================
// pdfjs loader — single-shot, lazy
// ============================================================

interface PdfjsModule {
  getDocument: (opts: unknown) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>; cleanup: () => Promise<void>; destroy: () => Promise<void> }> };
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Lazy-load the pdfjs legacy build. Cached so the module is only
 * imported once even when many PDFs sync in a single run — pdfjs
 * is a few megabytes of JS that we don't want to re-parse.
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfjsModule>;
  }
  return pdfjsPromise;
}
