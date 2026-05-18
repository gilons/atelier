import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { extractDocxText, wordXmlToText } from "../dist/index.js";

/**
 * Tests for the .docx text extractor.
 *
 * `wordXmlToText` is the easy part — we feed it WordprocessingML
 * fragments and check the plain-text output. `extractDocxText` is
 * the round-trip: build a tiny in-memory ZIP that looks like a
 * real .docx (one entry: word/document.xml), pass it in, expect
 * the same text back.
 */

// ============================================================
// wordXmlToText
// ============================================================

test("wordXmlToText: single paragraph with one text run", () => {
  const xml = `
    <w:document>
      <w:body>
        <w:p><w:r><w:t>Hello, world.</w:t></w:r></w:p>
      </w:body>
    </w:document>
  `;
  assert.equal(wordXmlToText(xml), "Hello, world.");
});

test("wordXmlToText: concatenates multiple runs within a paragraph", () => {
  const xml = `
    <w:body>
      <w:p>
        <w:r><w:t xml:space="preserve">Hello, </w:t></w:r>
        <w:r><w:t>world</w:t></w:r>
        <w:r><w:t>.</w:t></w:r>
      </w:p>
    </w:body>
  `;
  assert.equal(wordXmlToText(xml), "Hello, world.");
});

test("wordXmlToText: paragraphs become newline-separated lines", () => {
  const xml = `
    <w:body>
      <w:p><w:r><w:t>First.</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second.</w:t></w:r></w:p>
      <w:p><w:r><w:t>Third.</w:t></w:r></w:p>
    </w:body>
  `;
  assert.equal(wordXmlToText(xml), "First.\nSecond.\nThird.");
});

test("wordXmlToText: empty paragraphs preserved as blank lines (paragraph spacing)", () => {
  const xml = `
    <w:body>
      <w:p><w:r><w:t>Heading</w:t></w:r></w:p>
      <w:p></w:p>
      <w:p><w:r><w:t>Body.</w:t></w:r></w:p>
    </w:body>
  `;
  assert.equal(wordXmlToText(xml), "Heading\n\nBody.");
});

test("wordXmlToText: trailing empty paragraphs are trimmed", () => {
  // Word always appends 1-3 empty paragraphs at the end of a doc.
  // Keeping them would dirty every doc's body with trailing
  // whitespace.
  const xml = `
    <w:body>
      <w:p><w:r><w:t>Only line.</w:t></w:r></w:p>
      <w:p></w:p>
      <w:p></w:p>
    </w:body>
  `;
  assert.equal(wordXmlToText(xml), "Only line.");
});

test("wordXmlToText: tabs and line breaks", () => {
  const xml = `
    <w:body>
      <w:p>
        <w:r><w:t>Col1</w:t></w:r>
        <w:r><w:tab/><w:t>Col2</w:t></w:r>
      </w:p>
      <w:p>
        <w:r><w:t>Line A</w:t><w:br/><w:t>Line B</w:t></w:r>
      </w:p>
    </w:body>
  `;
  assert.equal(wordXmlToText(xml), "Col1\tCol2\nLine A\nLine B");
});

test("wordXmlToText: XML entities decoded", () => {
  const xml = `
    <w:body>
      <w:p><w:r><w:t>&amp;copy; 2026 &lt;Acme &amp; Co.&gt;</w:t></w:r></w:p>
    </w:body>
  `;
  assert.equal(wordXmlToText(xml), "&copy; 2026 <Acme & Co.>");
});

// ============================================================
// extractDocxText — full ZIP round-trip
// ============================================================

/**
 * Build a minimal valid `.docx` (a ZIP with one entry,
 * `word/document.xml`) so we can exercise the reader without
 * fixtures on disk. Real .docx files have additional entries
 * (`[Content_Types].xml`, `_rels/`, styles, etc.) but our reader
 * only needs `word/document.xml` — extra entries are simply
 * skipped by the local-file-header scan, so we don't have to
 * include them.
 */
function buildMiniDocx(documentXml) {
  const name = "word/document.xml";
  const nameBuf = Buffer.from(name, "utf8");
  const uncompressed = Buffer.from(documentXml, "utf8");
  const compressed = zlib.deflateRawSync(uncompressed);

  // Local file header (30 bytes fixed + name + extra)
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // signature
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(8, 8); // compression method: deflate
  lfh.writeUInt16LE(0, 10); // mod time
  lfh.writeUInt16LE(0, 12); // mod date
  lfh.writeUInt32LE(0, 14); // crc32 (left zero; reader doesn't check)
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(uncompressed.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([lfh, nameBuf, compressed]);
}

test("extractDocxText: round-trips through a minimal in-memory ZIP", () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Cloud Services Contract</w:t></w:r></w:p>
    <w:p><w:r><w:t>Version 2.0, signed 2026-05-18.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const docx = buildMiniDocx(documentXml);
  const text = extractDocxText(docx);
  assert.equal(text, "Cloud Services Contract\nVersion 2.0, signed 2026-05-18.");
});

test("extractDocxText: throws when word/document.xml is missing", () => {
  // A ZIP with a different entry name.
  const name = "wrong/name.xml";
  const nameBuf = Buffer.from(name, "utf8");
  const data = Buffer.from("<x/>", "utf8");
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(0, 8); // stored
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  const fakeDocx = Buffer.concat([lfh, nameBuf, data]);
  assert.throws(() => extractDocxText(fakeDocx), /word\/document\.xml/);
});
