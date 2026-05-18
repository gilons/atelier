import * as zlib from "node:zlib";

/**
 * Plain-text extraction for Word `.docx` files.
 *
 * Background: Microsoft Graph's `/drives/{id}/items/{id}/content?format=…`
 * endpoint only converts to PDF (and a couple of 3D formats). There's no
 * "give me the plain text" mode — every `.docx` we asked for as
 * `text/plain` came back as HTTP 406. So we do the extraction ourselves.
 *
 * A `.docx` is an Office Open XML package — a ZIP archive containing
 * `word/document.xml` (the body text in WordprocessingML) plus styles,
 * relationships, embedded media, etc. To get plain text we:
 *
 *   1. Read just `word/document.xml` out of the ZIP (skip the rest —
 *      we never need it).
 *   2. Walk the XML, treating `<w:p>` as paragraph boundaries and
 *      pulling text from `<w:t>` runs. `<w:tab/>` becomes `\t`,
 *      `<w:br/>` becomes `\n`.
 *
 * Deliberately minimal. We don't try to render styles, headers,
 * footers, tables-as-tables, footnotes, comments, or tracked changes.
 * Text-as-the-reader-sees-it is the goal — agents reading the doc map
 * need the words, not the layout.
 *
 * Why a hand-rolled ZIP reader rather than `jszip` etc.? Adding a
 * production dep for a feature this tiny doesn't pay for itself.
 * The local-file-header format is stable and well-documented; the
 * code is ~50 lines.
 */

/**
 * Extract plain text from a `.docx` binary buffer. Throws if the
 * buffer isn't a valid Office Open XML package (no
 * `word/document.xml` inside).
 */
export function extractDocxText(buffer: Buffer): string {
  const xml = readZipEntry(buffer, "word/document.xml");
  if (!xml) {
    throw new Error(
      "Not a valid .docx — couldn't find word/document.xml inside the archive. " +
        "If you're sure this is a Word document, it may have been re-saved with " +
        "an unusual ZIP layout (encrypted .docx, .doc Compound Binary, etc.)."
    );
  }
  return wordXmlToText(xml.toString("utf8"));
}

// ============================================================
// Minimal ZIP reader — local-file-header scan, single entry
// ============================================================

/**
 * Scan a ZIP archive for one named entry and return its
 * decompressed bytes. Returns null when the entry isn't found.
 *
 * Implementation notes:
 *   - Walks local file headers only (signature `PK\x03\x04`). We
 *     skip the central directory entirely — it's an optimization
 *     for random access we don't need.
 *   - Supports `stored` (0) and `deflate` (8). Office files use
 *     `deflate` for everything except small files. ZIP64 (>4GB
 *     entries) isn't handled; `word/document.xml` is never that
 *     big in practice.
 *   - Uses `zlib.inflateRawSync` (not `inflateSync`) — ZIP stores
 *     deflate streams without the zlib header/checksum wrapper.
 */
function readZipEntry(zipBuf: Buffer, targetName: string): Buffer | null {
  const LOCAL_FILE_HEADER_SIG = 0x04034b50;
  const HEADER_SIZE = 30;
  let pos = 0;
  while (pos + HEADER_SIZE <= zipBuf.length) {
    if (zipBuf.readUInt32LE(pos) !== LOCAL_FILE_HEADER_SIG) {
      // Not at a local file header — either we hit the central
      // directory (sig 0x02014b50) or a data descriptor we don't
      // know about. In either case we're past the file content.
      return null;
    }
    const compressionMethod = zipBuf.readUInt16LE(pos + 8);
    const compressedSize = zipBuf.readUInt32LE(pos + 18);
    const nameLen = zipBuf.readUInt16LE(pos + 26);
    const extraLen = zipBuf.readUInt16LE(pos + 28);
    const name = zipBuf
      .subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + nameLen)
      .toString("utf8");
    const dataStart = pos + HEADER_SIZE + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (name === targetName) {
      const data = zipBuf.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) return Buffer.from(data);
      if (compressionMethod === 8) return zlib.inflateRawSync(data);
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for ${targetName}. ` +
          "Atelier only handles stored (0) and deflate (8) entries."
      );
    }
    pos = dataEnd;
  }
  return null;
}

// ============================================================
// WordprocessingML → plain text
// ============================================================

/**
 * Convert the body XML of a `.docx` into plain text. Each `<w:p>`
 * becomes a line; `<w:t>` runs concatenate within a paragraph;
 * `<w:tab/>` → `\t`, `<w:br/>` → `\n`. XML entities are decoded
 * (`&amp;` → `&` etc.).
 *
 * Exported for tests — the round-trip from a synthetic XML
 * fragment is easier to verify in isolation than via a full .docx.
 */
export function wordXmlToText(xml: string): string {
  // Strip the body wrapper if present — we only care about what's
  // inside <w:body>...</w:body>. Falls through gracefully when the
  // input is a raw paragraph list.
  const bodyMatch = /<w:body[^>]*>([\s\S]*?)<\/w:body>/i.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const paragraphs = body.split(/<\/w:p\s*>/i);
  const lines: string[] = [];
  for (const p of paragraphs) {
    if (!/<w:p[\s>]/i.test(p) && lines.length > 0) {
      // Junk after the last </w:p> — usually section properties.
      // Skip.
      continue;
    }
    // Walk every text-emitting tag in document order. Three kinds
    // matter:
    //   <w:t...>text</w:t>  → literal text run
    //   <w:tab/>            → tab character
    //   <w:br/>             → soft line break inside a paragraph
    //
    // Doing this in one regex pass (rather than running separate
    // replace passes) keeps the interleaving correct — a
    // `<w:t>Col1</w:t><w:tab/><w:t>Col2</w:t>` stays as
    // `Col1\tCol2`, where pre-processing the tabs first would lose
    // them (they sit OUTSIDE `<w:t>` so a later "extract only
    // `<w:t>` content" pass would strip them).
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/gi;
    let line = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(p)) !== null) {
      if (m[0].toLowerCase().startsWith("<w:tab")) line += "\t";
      else if (m[0].toLowerCase().startsWith("<w:br")) line += "\n";
      else line += decodeXmlEntities(m[1]);
    }
    lines.push(line);
  }
  // Trim trailing empty paragraphs — Word litters those at the
  // end of every doc. Keep interior empties (they're paragraph
  // spacing the author intentionally added).
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
