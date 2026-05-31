import * as crypto from "node:crypto";

/**
 * Filesystem-safe encoding for source-side ids used as folder names.
 *
 * Content surfaces (documentation, tickets, designs) store one folder
 * per entry, named after an id that can contain anything — Notion
 * UUIDs, `owner/repo#42`, URLs, ticket keys, slugs. This maps any id
 * to a deterministic, filesystem-safe stem: `[A-Za-z0-9._-]` is kept
 * verbatim, everything else is percent-encoded (UTF-8 byte by byte).
 * Ids over 200 chars get a sha1-suffixed truncation to stay under the
 * 255-byte filename cap.
 */
export function encodeFilenameStem(id: string): string {
  if (!id) throw new Error("id must be a non-empty string");
  let out = "";
  for (const ch of id) {
    const code = ch.charCodeAt(0);
    const safe =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      ch === "." ||
      ch === "_" ||
      ch === "-";
    if (safe) {
      out += ch;
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  if (out.length > 200) {
    const hash = crypto.createHash("sha1").update(id).digest("hex").slice(0, 8);
    out = out.slice(0, 200) + "_" + hash;
  }
  return out;
}

/** Inverse of {@link encodeFilenameStem} for the common-case mapping. */
export function decodeFilenameStem(stem: string): string {
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}
