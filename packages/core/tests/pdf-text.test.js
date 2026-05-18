import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "../dist/index.js";

/**
 * Tests for the PDF text extractor.
 *
 * We construct a hand-rolled minimal PDF instead of shipping a
 * fixture file. The PDF spec is permissive enough that a small
 * literal byte string can be a valid one-page document — handy for
 * keeping the test self-contained and the repo lean.
 *
 * Note: pdfjs-dist is real software with real performance, so a
 * full parse can take ~100ms even for a tiny PDF. That's fine for
 * an occasional /doc add but is the main reason we don't try to
 * extract during listDocs.
 */

/**
 * Build a minimal text-bearing PDF. One page, Helvetica-style
 * font, with the given content drawn at a fixed position. Useful
 * for asserting that we route through pdfjs and surface the text.
 */
function buildMiniPdf(text) {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${("BT\n/F1 12 Tf\n100 700 Td\n(" + text + ") Tj\nET").length} >>
stream
BT
/F1 12 Tf
100 700 Td
(${text}) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000010 00000 n
0000000060 00000 n
0000000115 00000 n
0000000220 00000 n
0000000330 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
400
%%EOF`, "binary");
}

test("extractPdfText: returns markdown with a Page section and the text content", async () => {
  const pdf = buildMiniPdf("Hello, Atelier!");
  const md = await extractPdfText(pdf);
  assert.match(md, /^## Page 1/);
  assert.match(md, /Hello, Atelier!/);
});

test("extractPdfText: rejects non-PDF input with a clear error", async () => {
  await assert.rejects(
    () => extractPdfText(Buffer.from("not a pdf at all", "utf8")),
    /InvalidPDFException|PDF|invalid/i
  );
});

test("extractPdfText: an image-only / empty-text PDF returns an empty string", async () => {
  // A valid PDF with no text-drawing operators — pdfjs returns
  // zero text items. The adapter handles the empty case with a
  // "no extractable text" stub; the extractor itself simply
  // returns what's there.
  const emptyPdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length 0 >>
stream

endstream
endobj
xref
0 5
0000000000 65535 f
0000000010 00000 n
0000000060 00000 n
0000000115 00000 n
0000000205 00000 n
trailer
<< /Size 5 /Root 1 0 R >>
startxref
250
%%EOF`, "binary");
  const md = await extractPdfText(emptyPdf);
  // Just the heading, no text content.
  assert.match(md, /^## Page 1/);
  // After the heading there should be no actual content lines.
  const afterHeading = md.split("\n").slice(2).join("\n").trim();
  assert.equal(afterHeading, "");
});
