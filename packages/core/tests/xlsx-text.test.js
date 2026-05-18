import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { extractXlsxText } from "../dist/index.js";

/** Build a multi-entry ZIP from `{name, content}` pairs. */
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

const SHARED_STRINGS = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Name</t></si>
  <si><t>Alice</t></si>
  <si><t>Bob</t></si>
</sst>`;

const WORKBOOK_ONE_SHEET = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="People" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

const RELS_ONE_SHEET = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="..." Target="worksheets/sheet1.xml"/>
</Relationships>`;

test("extractXlsxText: renders a single sheet as a fenced csv block", () => {
  const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2"><v>42</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>2</v></c>
      <c r="B3"><v>7</v></c>
    </row>
  </sheetData>
</worksheet>`;
  const buf = buildZip([
    { name: "xl/sharedStrings.xml", content: SHARED_STRINGS },
    { name: "xl/workbook.xml", content: WORKBOOK_ONE_SHEET },
    { name: "xl/_rels/workbook.xml.rels", content: RELS_ONE_SHEET },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
  const out = extractXlsxText(buf);
  assert.match(out, /## People/);
  // The CSV block, fenced and parseable by any stdlib CSV reader.
  assert.match(out, /```csv\nName,1\nAlice,42\nBob,7\n```/);
});

test("extractXlsxText: quotes cells containing commas, quotes, or newlines (RFC 4180)", () => {
  const sharedStrings = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Plain</t></si>
  <si><t>Has, comma</t></si>
  <si><t>Has "quote"</t></si>
</sst>`;
  const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
  </sheetData>
</worksheet>`;
  const buf = buildZip([
    { name: "xl/sharedStrings.xml", content: sharedStrings },
    { name: "xl/workbook.xml", content: WORKBOOK_ONE_SHEET },
    { name: "xl/_rels/workbook.xml.rels", content: RELS_ONE_SHEET },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
  const out = extractXlsxText(buf);
  // Plain cell passes through unquoted; the other two get wrapped
  // and (for the quoted one) the embedded quote is doubled.
  assert.match(out, /Plain,"Has, comma","Has ""quote"""/);
});

test("extractXlsxText: handles inlineStr cells", () => {
  // <c t="inlineStr"><is><t>Direct</t></is></c>
  const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Inline header</t></is></c>
    </row>
  </sheetData>
</worksheet>`;
  const buf = buildZip([
    { name: "xl/workbook.xml", content: WORKBOOK_ONE_SHEET },
    { name: "xl/_rels/workbook.xml.rels", content: RELS_ONE_SHEET },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
  const out = extractXlsxText(buf);
  assert.match(out, /Inline header/);
});

test("extractXlsxText: handles boolean cells (t='b' → TRUE/FALSE)", () => {
  const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="b"><v>1</v></c>
      <c r="C1" t="b"><v>0</v></c>
    </row>
  </sheetData>
</worksheet>`;
  const buf = buildZip([
    { name: "xl/sharedStrings.xml", content: SHARED_STRINGS },
    { name: "xl/workbook.xml", content: WORKBOOK_ONE_SHEET },
    { name: "xl/_rels/workbook.xml.rels", content: RELS_ONE_SHEET },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
  const out = extractXlsxText(buf);
  assert.match(out, /TRUE/);
  assert.match(out, /FALSE/);
});

test("extractXlsxText: preserves multi-sheet order from workbook rels", () => {
  const workbook = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="First" sheetId="1" r:id="rId1"/>
    <sheet name="Second" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;
  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="..." Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="..." Target="worksheets/sheet2.xml"/>
</Relationships>`;
  const sheetBody = (label) => `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>${label}</t></is></c></row>
  </sheetData>
</worksheet>`;
  const buf = buildZip([
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: rels },
    { name: "xl/worksheets/sheet1.xml", content: sheetBody("FirstData") },
    { name: "xl/worksheets/sheet2.xml", content: sheetBody("SecondData") },
  ]);
  const out = extractXlsxText(buf);
  const firstIdx = out.indexOf("## First");
  const secondIdx = out.indexOf("## Second");
  assert.ok(firstIdx >= 0, "First section should appear");
  assert.ok(secondIdx >= 0, "Second section should appear");
  assert.ok(firstIdx < secondIdx, "sheet order should match workbook order");
});

test("extractXlsxText: throws on a buffer without xl/workbook.xml", () => {
  const buf = buildZip([{ name: "nope.xml", content: "<x/>" }]);
  assert.throws(() => extractXlsxText(buf), /xl\/workbook\.xml/);
});
