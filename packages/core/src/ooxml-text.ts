/**
 * Shared helpers for Office Open XML text extraction (.docx, .xlsx,
 * .pptx). The OOXML formats all wrap text in XML with a few common
 * conventions — namespaced tags, predeclared entities, sometimes
 * `xml:space="preserve"`. The helpers here cover those.
 */

/**
 * Decode the five named XML entities plus numeric (`&#NN;` /
 * `&#xHH;`) escapes. Office documents never emit other named
 * entities (no `&copy;` etc.), so we don't need a full HTML entity
 * table — just the XML core set.
 */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
