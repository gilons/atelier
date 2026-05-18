import { readZipEntry } from "./zip-reader.js";
import { decodeXmlEntities } from "./ooxml-text.js";

/**
 * Plain-text extraction for Word `.docx` files.
 *
 * A `.docx` is an Office Open XML package — a ZIP archive containing
 * `word/document.xml` (the body text in WordprocessingML) plus styles,
 * relationships, embedded media, etc. To get plain text we read just
 * that one entry and walk its `<w:p>` / `<w:r>` / `<w:t>` tree.
 *
 * Background: Microsoft Graph's `?format=text/plain` content endpoint
 * doesn't actually convert Office docs to plain text — it only does
 * PDF (and a couple of 3D formats). Every `.docx` we asked for as
 * `text/plain` came back HTTP 406. So we extract the text ourselves
 * instead of relying on Graph.
 *
 * Deliberately minimal. We don't try to render styles, headers,
 * footers, tables-as-tables, footnotes, comments, or tracked changes.
 * Text-as-the-reader-sees-it is the goal — agents reading the doc
 * map need the words, not the layout.
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

/**
 * Convert the body XML of a `.docx` into plain text. Each `<w:p>`
 * becomes a line; `<w:t>` runs concatenate within a paragraph;
 * `<w:tab/>` → `\t`, `<w:br/>` → `\n`. XML entities are decoded.
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
    // replace passes) keeps the interleaving correct.
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
  // end of every doc.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}
