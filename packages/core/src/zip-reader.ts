import * as zlib from "node:zlib";

/**
 * Minimal in-memory ZIP reader.
 *
 * Just enough to extract named entries from Office Open XML
 * archives (`.docx`, `.xlsx`, `.pptx`). Walks local file headers
 * (signature `PK\x03\x04`) and decompresses `stored` (0) and
 * `deflate` (8) entries. The central directory is skipped — we
 * don't need random access.
 *
 * Limitations (acceptable for our use case):
 *   - No ZIP64 (>4GB entries). Office files don't hit this.
 *   - No data descriptors / streaming-mode pre-known sizes — Office
 *     files always inline the sizes in the local header.
 *   - No encryption.
 *
 * Why a hand-rolled reader rather than `jszip` etc.? A dep for
 * something this small doesn't pay for itself. The local-file-
 * header layout is stable and ~50 lines of code.
 */

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const HEADER_SIZE = 30;

/**
 * Read a single named entry out of a ZIP buffer. Returns the
 * decompressed bytes, or null when the entry isn't present.
 */
export function readZipEntry(
  zipBuf: Buffer,
  targetName: string
): Buffer | null {
  for (const entry of iterEntries(zipBuf)) {
    if (entry.name === targetName) return entry.read();
  }
  return null;
}

/**
 * Read every entry whose name matches `predicate`. Useful for
 * `.xlsx` (multiple worksheets under `xl/worksheets/`) and
 * `.pptx` (multiple slides under `ppt/slides/`).
 *
 * Returns an array of `{name, data}` in archive order — which for
 * `.xlsx`/`.pptx` IS the canonical sheet/slide order.
 */
export function readZipEntries(
  zipBuf: Buffer,
  predicate: (name: string) => boolean
): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const entry of iterEntries(zipBuf)) {
    if (predicate(entry.name)) {
      out.push({ name: entry.name, data: entry.read() });
    }
  }
  return out;
}

interface ZipEntryHandle {
  name: string;
  read(): Buffer;
}

function* iterEntries(zipBuf: Buffer): IterableIterator<ZipEntryHandle> {
  let pos = 0;
  while (pos + HEADER_SIZE <= zipBuf.length) {
    if (zipBuf.readUInt32LE(pos) !== LOCAL_FILE_HEADER_SIG) {
      // First non-local-header sig is the central directory or EOCD.
      // We're done with file content either way.
      return;
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
    const data = zipBuf.subarray(dataStart, dataEnd);
    yield {
      name,
      read(): Buffer {
        if (compressionMethod === 0) return Buffer.from(data);
        if (compressionMethod === 8) return zlib.inflateRawSync(data);
        throw new Error(
          `Unsupported ZIP compression method ${compressionMethod} for ${name}. ` +
            "Atelier only handles stored (0) and deflate (8) entries."
        );
      },
    };
    pos = dataEnd;
  }
}
