import { readZipEntry, readZipEntries } from "./zip-reader.js";
import { decodeXmlEntities } from "./ooxml-text.js";

/**
 * Plain-text extraction for PowerPoint `.pptx` files.
 *
 * `.pptx` is an Office Open XML package with these interesting
 * entries:
 *
 *   ppt/presentation.xml             — slide order (sldIdLst → rIds)
 *   ppt/_rels/presentation.xml.rels  — rId → slide file mapping
 *   ppt/slides/slide{N}.xml          — actual slide content
 *
 * Each slide's body is a shape tree (`<p:spTree>`) containing shapes
 * (`<p:sp>`) with text bodies (`<p:txBody>`). Text inside a body
 * uses DrawingML markup: `<a:p>` paragraphs, `<a:r>` runs,
 * `<a:t>` text, `<a:br/>` line break.
 *
 * Output shape:
 *
 *     ## Slide 1: <first-line-of-first-text-body>
 *
 *     Body paragraph 1
 *
 *     Body paragraph 2
 *
 *     ## Slide 2: <title>
 *     ...
 *
 * We don't try to detect bullet markers or hierarchy — that would
 * require parsing list-style indentation. Each `<a:p>` becomes a
 * paragraph in document order.
 */

/**
 * Extract markdown from a `.pptx` binary buffer. Throws if the
 * buffer isn't a valid OOXML presentation package.
 */
export function extractPptxText(buffer: Buffer): string {
  const presXml = readZipEntry(buffer, "ppt/presentation.xml");
  if (!presXml) {
    throw new Error(
      "Not a valid .pptx — couldn't find ppt/presentation.xml inside the archive."
    );
  }
  const relsXml = readZipEntry(buffer, "ppt/_rels/presentation.xml.rels");
  const ridToTarget = relsXml ? parseRels(relsXml.toString("utf8")) : new Map<string, string>();

  // Slide order is in <p:sldIdLst><p:sldId r:id="rIdN"/>...</p:sldIdLst>.
  const slideOrder = parseSlideOrder(presXml.toString("utf8"));

  // Index every slide file in the archive — some authoring tools
  // produce variant paths (`ppt/slides/_rels/slide.xml.rels` etc.)
  // so we filter strictly to `ppt/slides/slideN.xml`.
  const slideEntries = readZipEntries(buffer, (name) =>
    /^ppt\/slides\/slide\d+\.xml$/i.test(name)
  );
  const slideByFile = new Map<string, Buffer>();
  for (const e of slideEntries) {
    // The rels target is relative to `ppt/`, e.g. "slides/slide1.xml".
    slideByFile.set(e.name.replace(/^ppt\//, ""), e.data);
  }

  const sections: string[] = [];
  let slideNumber = 0;
  for (const rid of slideOrder) {
    slideNumber++;
    const target = ridToTarget.get(rid);
    if (!target) continue;
    const data = slideByFile.get(target);
    if (!data) continue;
    sections.push(renderSlideMarkdown(slideNumber, data.toString("utf8")));
  }
  // Fallback when the presentation rels don't enumerate slides
  // (unusual, but seen in some exports). Iterate slide files in
  // archive order so the user gets *something*.
  if (sections.length === 0 && slideEntries.length > 0) {
    slideEntries
      .sort((a, b) => slideNumberFromPath(a.name) - slideNumberFromPath(b.name))
      .forEach((e, i) => {
        sections.push(renderSlideMarkdown(i + 1, e.data.toString("utf8")));
      });
  }
  return sections.join("\n\n").trimEnd() + (sections.length > 0 ? "\n" : "");
}

// ============================================================
// presentation.xml + rels parsing
// ============================================================

function parseSlideOrder(xml: string): string[] {
  // <p:sldIdLst>
  //   <p:sldId id="256" r:id="rId1"/>
  //   <p:sldId id="257" r:id="rId2"/>
  // </p:sldIdLst>
  const out: string[] = [];
  const re = /<p:sldId\b([^>]*?)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const rid = attrAt(m[1], "r:id") ?? attrAt(m[1], "id");
    if (rid && rid.startsWith("rId")) out.push(rid);
  }
  return out;
}

function parseRels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<Relationship\b([^>]*)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const id = attrAt(m[1], "Id");
    const target = attrAt(m[1], "Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

function attrAt(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}=("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[2] ?? m[3];
}

function slideNumberFromPath(path: string): number {
  const m = /slide(\d+)\.xml$/i.exec(path);
  return m ? parseInt(m[1], 10) : 0;
}

// ============================================================
// Slide XML → markdown
// ============================================================

/**
 * Render one slide's XML as markdown. Strategy:
 *
 *   - Pull every `<a:t>` text run from the slide in document
 *     order, grouped by parent `<a:p>` (paragraph). `<a:br/>`
 *     inside a run becomes a newline.
 *   - The first non-empty paragraph is treated as the slide title
 *     and appended to the `## Slide N` header.
 *   - Subsequent paragraphs become body lines, blank-separated.
 *
 * Exported for tests so the slide-XML → markdown conversion can
 * be verified independently of the ZIP layer.
 */
export function renderSlideMarkdown(slideNumber: number, slideXml: string): string {
  const paragraphs = extractDrawingMlParagraphs(slideXml);
  const nonEmpty = paragraphs.filter((p) => p.trim().length > 0);
  if (nonEmpty.length === 0) {
    return `## Slide ${slideNumber}\n\n*(no text on this slide)*`;
  }
  const [title, ...body] = nonEmpty;
  const lines: string[] = [];
  lines.push(`## Slide ${slideNumber}: ${title}`);
  if (body.length > 0) {
    lines.push("");
    // Each remaining paragraph becomes its own block — preserves
    // bullet-style separation without imposing list syntax we
    // can't verify.
    for (const p of body) {
      lines.push(p);
      lines.push("");
    }
    // Strip the trailing blank we just pushed.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }
  return lines.join("\n");
}

function extractDrawingMlParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  // <a:p>...</a:p> — text body's paragraph. Note: there are also
  // <a:p> elements inside speaker notes, tables, etc.; for body
  // text in a typical slide they're all in shape txBodies and we
  // want them all.
  const reP = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
  let m: RegExpExecArray | null;
  while ((m = reP.exec(xml)) !== null) {
    const inner = m[1];
    // Within a paragraph, walk runs and breaks in order.
    const reRun = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/gi;
    let line = "";
    let r: RegExpExecArray | null;
    while ((r = reRun.exec(inner)) !== null) {
      if (r[0].toLowerCase().startsWith("<a:br")) line += "\n";
      else line += decodeXmlEntities(r[1]);
    }
    paragraphs.push(line);
  }
  return paragraphs;
}
