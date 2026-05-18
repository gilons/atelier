import { readZipEntry, readZipEntries } from "./zip-reader.js";
import { decodeXmlEntities } from "./ooxml-text.js";

/**
 * Plain-text extraction for Excel `.xlsx` files.
 *
 * `.xlsx` is an Office Open XML package — a ZIP whose interesting
 * entries are:
 *
 *   xl/workbook.xml             — list of sheets, with rId references
 *   xl/_rels/workbook.xml.rels  — rId → target path mapping
 *   xl/sharedStrings.xml        — string table indexed by `<c><v>`
 *   xl/worksheets/sheet1.xml    — actual cell data, one per sheet
 *
 * We emit one `## Sheet name` heading per worksheet, followed by a
 * fenced ```csv code block with that sheet's cells. CSV (rather than
 * a markdown table) because agents reading the doc map can parse
 * tabular data trivially with stdlib CSV readers, but parsing
 * markdown-table pipes correctly is surprisingly fiddly (column
 * widths, escape handling, alignment rows). The fenced block makes
 * the format explicit so a renderer won't try to interpret it as
 * prose.
 *
 * Numeric values stay as their literal string form; date-typed
 * cells stay as their raw float serial (Excel encodes dates as days
 * since 1900-01-01 — converting needs format metadata we skip in
 * this minimal pass).
 *
 * Output shape:
 *
 *     ## Sheet1
 *
 *     ```csv
 *     A,B,C
 *     foo,bar,42
 *     baz,,7
 *     ```
 *
 * Empty trailing rows are trimmed; trailing empty columns within a
 * row become trailing empty fields per RFC 4180.
 */

/**
 * Extract markdown from an `.xlsx` binary buffer. Throws if the
 * buffer isn't a valid Office Open XML spreadsheet package.
 */
export function extractXlsxText(buffer: Buffer): string {
  // 1. Optional shared-strings table — t="s" cells reference it.
  const sharedStringsXml = readZipEntry(buffer, "xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml
    ? parseSharedStrings(sharedStringsXml.toString("utf8"))
    : [];

  // 2. Workbook + rels map (rId → sheet file). Without these we'd
  //    still find sheets but couldn't preserve order or names.
  const workbookXml = readZipEntry(buffer, "xl/workbook.xml");
  if (!workbookXml) {
    throw new Error(
      "Not a valid .xlsx — couldn't find xl/workbook.xml inside the archive."
    );
  }
  const relsXml = readZipEntry(buffer, "xl/_rels/workbook.xml.rels");
  const ridToTarget = relsXml ? parseRels(relsXml.toString("utf8")) : new Map<string, string>();

  // workbook.xml lists sheets like:
  //   <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  // We pair (name, rId) → (name, sheet file path).
  const sheetRefs = parseSheetRefs(workbookXml.toString("utf8"));

  // 3. Read every worksheet file. We use readZipEntries so we don't
  //    have to know the exact path each time (some authors put
  //    sheets in `xl/worksheets/`, some in unusual layouts).
  const sheetEntries = readZipEntries(buffer, (name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
  );
  const sheetByFile = new Map<string, Buffer>();
  for (const e of sheetEntries) {
    // The rels target is relative to xl/_rels/, e.g. "worksheets/sheet1.xml".
    // Strip the leading "xl/" from the full path to compare.
    const rel = e.name.replace(/^xl\//, "");
    sheetByFile.set(rel, e.data);
  }

  const sections: string[] = [];
  for (const ref of sheetRefs) {
    const target = ridToTarget.get(ref.rid);
    if (!target) continue;
    const data = sheetByFile.get(target);
    if (!data) continue;
    const table = parseSheet(data.toString("utf8"), sharedStrings);
    sections.push(renderSheetMarkdown(ref.name, table));
  }
  return sections.join("\n\n").trimEnd() + (sections.length > 0 ? "\n" : "");
}

// ============================================================
// Shared strings
// ============================================================

/**
 * Parse `xl/sharedStrings.xml`. Each `<si>` is a string entry,
 * possibly with rich-text runs inside. We concatenate any `<t>`
 * text we find within an entry — formatting is dropped.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const reSi = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let m: RegExpExecArray | null;
  while ((m = reSi.exec(xml)) !== null) {
    const inner = m[1];
    const reT = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi;
    let text = "";
    let t: RegExpExecArray | null;
    while ((t = reT.exec(inner)) !== null) {
      text += decodeXmlEntities(t[1]);
    }
    out.push(text);
  }
  return out;
}

// ============================================================
// Workbook rels (rId → file path)
// ============================================================

function parseRels(xml: string): Map<string, string> {
  // <Relationship Id="rId1" Type="..." Target="worksheets/sheet1.xml"/>
  const out = new Map<string, string>();
  const re =
    /<Relationship\b([^>]*)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = attrAt(attrs, "Id");
    const target = attrAt(attrs, "Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

interface SheetRef {
  name: string;
  rid: string;
}

function parseSheetRefs(workbookXml: string): SheetRef[] {
  const out: SheetRef[] = [];
  const re = /<sheet\b([^>]*)\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(workbookXml)) !== null) {
    const attrs = m[1];
    const name = attrAt(attrs, "name") ?? "Sheet";
    // `r:id` namespaced; sometimes serialized as plain "id" depending on
    // the authoring tool. Try both.
    const rid = attrAt(attrs, "r:id") ?? attrAt(attrs, "id");
    if (rid) out.push({ name: decodeXmlEntities(name), rid });
  }
  return out;
}

function attrAt(attrs: string, name: string): string | undefined {
  // Match `name="value"` or `name='value'`. We escape ":" for the
  // r:id case.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}=("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[2] ?? m[3];
}

// ============================================================
// Sheet XML → cell grid
// ============================================================

interface Cell {
  /** 1-based column index parsed from cell ref (A=1, B=2, …, AA=27). */
  col: number;
  /** Rendered string value. */
  value: string;
}

interface ParsedRow {
  row: number;
  cells: Cell[];
}

function parseSheet(xml: string, sharedStrings: string[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  // <row r="1"> ... </row>
  const reRow = /<row\b([^>]*)>([\s\S]*?)<\/row>/gi;
  let m: RegExpExecArray | null;
  while ((m = reRow.exec(xml)) !== null) {
    const rowAttrs = m[1];
    const rowInner = m[2];
    const r = parseInt(attrAt(rowAttrs, "r") ?? "0", 10);
    if (!Number.isFinite(r) || r <= 0) continue;
    const cells: Cell[] = [];
    // <c r="A1" t="s"><v>0</v></c>            string ref
    // <c r="B1" t="inlineStr"><is><t>x</t></is></c>   inline string
    // <c r="C1"><v>42</v></c>                  number
    // <c r="D1" t="b"><v>1</v></c>             boolean
    const reCell = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^/]*)\/>/gi;
    let c: RegExpExecArray | null;
    while ((c = reCell.exec(rowInner)) !== null) {
      const attrs = c[1] ?? c[3] ?? "";
      const inner = c[2] ?? "";
      const ref = attrAt(attrs, "r");
      const col = ref ? colFromRef(ref) : 0;
      if (!col) continue;
      const type = attrAt(attrs, "t") ?? "n";
      let value = "";
      if (type === "s") {
        const vMatch = /<v>([^<]*)<\/v>/i.exec(inner);
        if (vMatch) {
          const idx = parseInt(vMatch[1], 10);
          if (Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length) {
            value = sharedStrings[idx];
          }
        }
      } else if (type === "inlineStr" || type === "str") {
        const tMatch = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/i.exec(inner);
        if (tMatch) value = decodeXmlEntities(tMatch[1]);
      } else if (type === "b") {
        const vMatch = /<v>([^<]*)<\/v>/i.exec(inner);
        if (vMatch) value = vMatch[1] === "1" ? "TRUE" : "FALSE";
      } else {
        // Numeric / generic. We don't decode date serials; surfacing
        // the raw value lets agents that care reconstruct it.
        const vMatch = /<v>([^<]*)<\/v>/i.exec(inner);
        if (vMatch) value = vMatch[1];
      }
      cells.push({ col, value });
    }
    if (cells.length > 0) rows.push({ row: r, cells });
  }
  return rows;
}

/**
 * Convert a cell reference column part to a 1-based index.
 *   A → 1, B → 2, …, Z → 26, AA → 27, AB → 28, …
 */
function colFromRef(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      n = n * 26 + (code - 64);
    } else if (code >= 97 && code <= 122) {
      n = n * 26 + (code - 96);
    } else {
      break;
    }
  }
  return n;
}

// ============================================================
// Markdown rendering
// ============================================================

function renderSheetMarkdown(name: string, rows: ParsedRow[]): string {
  if (rows.length === 0) {
    return `## ${name}\n\n*(empty)*`;
  }
  // Trim trailing empty rows — Excel padding.
  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].cells.some((c) => c.value.trim().length > 0)) {
      lastNonEmpty = i;
    }
  }
  if (lastNonEmpty < 0) return `## ${name}\n\n*(empty)*`;
  const usedRows = rows.slice(0, lastNonEmpty + 1);

  // Compute the populated column range.
  const maxCol = usedRows.reduce(
    (m, r) => Math.max(m, ...r.cells.map((c) => c.col)),
    0
  );
  // Build a 2D grid filled with empty strings. Sparse cells (an
  // empty B in a row with an A and a C) become empty CSV fields,
  // which is the standard "value not present here" encoding.
  const grid: string[][] = usedRows.map(() => Array(maxCol).fill(""));
  for (let i = 0; i < usedRows.length; i++) {
    for (const cell of usedRows[i].cells) {
      grid[i][cell.col - 1] = cell.value;
    }
  }
  const lines: string[] = [];
  lines.push(`## ${name}`);
  lines.push("");
  lines.push("```csv");
  for (const row of grid) {
    lines.push(row.map(csvEscape).join(","));
  }
  lines.push("```");
  return lines.join("\n");
}

/**
 * RFC 4180 escaping. A field that contains a comma, double quote,
 * or newline gets wrapped in double quotes; embedded double quotes
 * inside such a field are doubled. Plain alphanumeric / single-
 * token cells pass through unchanged.
 */
function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
