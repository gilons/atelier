import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { extractPptxText, renderSlideMarkdown } from "../dist/index.js";

function buildZip(entries) {
  const parts = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const uncompressed = Buffer.from(e.content, "utf8");
    const compressed = zlib.deflateRawSync(uncompressed);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(0, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(uncompressed.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    parts.push(lfh, nameBuf, compressed);
  }
  return Buffer.concat(parts);
}

// ============================================================
// renderSlideMarkdown — slide XML → markdown
// ============================================================

test("renderSlideMarkdown: first paragraph becomes the slide title", () => {
  const xml = `
    <p:sld xmlns:p="..." xmlns:a="...">
      <p:cSld><p:spTree>
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Vision</a:t></a:r></a:p>
          <a:p><a:r><a:t>Make planning feel calm</a:t></a:r></a:p>
        </p:txBody></p:sp>
      </p:spTree></p:cSld>
    </p:sld>
  `;
  const md = renderSlideMarkdown(3, xml);
  assert.match(md, /^## Slide 3: Vision/);
  assert.match(md, /Make planning feel calm/);
});

test("renderSlideMarkdown: empty slide gets a placeholder line", () => {
  const xml = `<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`;
  const md = renderSlideMarkdown(1, xml);
  assert.match(md, /## Slide 1/);
  assert.match(md, /\(no text on this slide\)/);
});

test("renderSlideMarkdown: <a:br/> inside a run becomes a newline within the paragraph", () => {
  const xml = `
    <p:sld>
      <p:cSld><p:spTree>
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Title</a:t></a:r></a:p>
          <a:p><a:r><a:t>Line one</a:t><a:br/><a:t>Line two</a:t></a:r></a:p>
        </p:txBody></p:sp>
      </p:spTree></p:cSld>
    </p:sld>
  `;
  const md = renderSlideMarkdown(1, xml);
  assert.match(md, /Line one\nLine two/);
});

// ============================================================
// extractPptxText — full archive round-trip
// ============================================================

const PRESENTATION = `<?xml version="1.0"?>
<p:presentation xmlns:p="..." xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`;

const PRES_RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="..." Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="..." Target="slides/slide2.xml"/>
</Relationships>`;

function buildSlide(title, body) {
  return `<?xml version="1.0"?>
<p:sld xmlns:p="..." xmlns:a="...">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>${title}</a:t></a:r></a:p>
      <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
}

test("extractPptxText: orders slides per the presentation rels (rId order)", () => {
  const buf = buildZip([
    { name: "ppt/presentation.xml", content: PRESENTATION },
    { name: "ppt/_rels/presentation.xml.rels", content: PRES_RELS },
    { name: "ppt/slides/slide1.xml", content: buildSlide("First", "Body of first") },
    { name: "ppt/slides/slide2.xml", content: buildSlide("Second", "Body of second") },
  ]);
  const md = extractPptxText(buf);
  const firstIdx = md.indexOf("Slide 1: First");
  const secondIdx = md.indexOf("Slide 2: Second");
  assert.ok(firstIdx >= 0 && secondIdx >= 0, "both slides should appear");
  assert.ok(firstIdx < secondIdx, "slide 1 should come before slide 2");
  assert.match(md, /Body of first/);
  assert.match(md, /Body of second/);
});

test("extractPptxText: falls back to archive order when presentation.xml lacks an sldIdLst", () => {
  const presentationNoSlides = `<?xml version="1.0"?>
<p:presentation xmlns:p="..."></p:presentation>`;
  const buf = buildZip([
    { name: "ppt/presentation.xml", content: presentationNoSlides },
    { name: "ppt/slides/slide1.xml", content: buildSlide("Solo title", "Solo body") },
  ]);
  const md = extractPptxText(buf);
  assert.match(md, /## Slide 1: Solo title/);
  assert.match(md, /Solo body/);
});

test("extractPptxText: throws on a buffer without ppt/presentation.xml", () => {
  const buf = buildZip([{ name: "wrong.xml", content: "<x/>" }]);
  assert.throws(() => extractPptxText(buf), /ppt\/presentation\.xml/);
});
