import * as YAML from "yaml";

/**
 * Shared front-matter parser/serializer used by feature and doc files.
 *
 * Both artifacts use the same on-disk shape: a `---`-delimited YAML
 * block at the top, then a markdown body. Centralizing here keeps the
 * convention consistent across artifacts and gives us one place to
 * fix any encoding/round-trip bugs.
 */

const DELIM = "---";

export interface SplitFrontMatter {
  /** YAML text between the opening and closing `---` lines. */
  frontMatterRaw: string;
  /** Markdown body after the closing delimiter (and one optional blank line). */
  body: string;
}

/**
 * Split a markdown-with-frontmatter file into its YAML and body parts.
 * Returns null if the file does not start with a `---` delimiter line.
 *
 * Trailing whitespace on the delimiter line is tolerated (matches the
 * Jekyll/Hugo convention) but the line must otherwise be exactly `---`.
 */
export function splitFrontMatter(text: string): SplitFrontMatter | null {
  if (!text.startsWith(DELIM)) return null;
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return null;
  const firstLine = text.slice(0, firstNewline).replace(/\r$/, "");
  if (firstLine !== DELIM) return null;

  const rest = text.slice(firstNewline + 1);
  const closingMatch = rest.match(/(^|\n)---[ \t]*(\r?\n|$)/);
  if (!closingMatch) return null;
  const closingIdx = closingMatch.index! + (closingMatch[1] === "\n" ? 1 : 0);
  const frontMatterRaw = rest.slice(0, closingIdx);
  const afterClosing = rest.slice(closingIdx + DELIM.length);
  // Skip the delim line's own newline plus one optional blank line.
  // The serializer always inserts a blank line between front-matter
  // and body for readability; treating it as part of the boundary
  // keeps round-trips lossless.
  const body = afterClosing.replace(/^[ \t]*\r?\n(?:[ \t]*\r?\n)?/, "");
  return { frontMatterRaw, body };
}

/**
 * Parse the YAML between the delimiters into a plain JS value.
 * Throws if the YAML is malformed.
 */
export function parseFrontMatterYaml(raw: string): unknown {
  return YAML.parse(raw);
}

/**
 * Serialize an arbitrary object into front-matter + body file text.
 * The object keys are written in iteration order — call sites are
 * responsible for ordering fields the way they want them to appear.
 */
export function buildFrontMatterFile(fm: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(fm, {
    lineWidth: 100,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  }).trimEnd();
  let normalizedBody = body;
  if (normalizedBody && !normalizedBody.endsWith("\n")) normalizedBody += "\n";
  return `---\n${yaml}\n---\n\n${normalizedBody}`;
}
