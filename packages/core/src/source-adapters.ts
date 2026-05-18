import type { DocClassification, Source } from "./types.js";

/**
 * Source adapter interface.
 *
 * The sync engine (Slice 8) delegates to a source adapter to actually
 * talk to a documentation source: list what's available, fetch the
 * content of individual documents. Adapters are pluggable so the same
 * sync orchestrator works for local folders, MCP-connected SaaS
 * sources, and (later) custom user-provided integrations.
 *
 * Two concrete adapters ship in v1:
 *   - {@link LocalFolderAdapter} — walks a directory of markdown
 *     files. Concrete, no external dependencies, useful in its own
 *     right (any repo with a `docs/` tree becomes a source).
 *   - {@link McpSourceAdapter} — spawns a user-configured MCP server
 *     and talks JSON-RPC over stdio. Currently scaffolded; the actual
 *     transport lives behind a method that throws until a future
 *     slice wires up the protocol.
 */

/**
 * Lightweight metadata returned by an adapter's `listDocs`. The full
 * body is fetched lazily by {@link SourceAdapter.fetchDoc} so the
 * sync engine can short-circuit when a contentHash hasn't changed.
 */
export interface RemoteDocMetadata {
  /** Source-side identifier — opaque to Atelier. */
  docId: string;
  /** Display title. */
  title: string;
  /** Optional one-line summary. */
  summary?: string;
  /** Optional canonical URL pointing back at the source. */
  url?: string;
  /** Source-suggested classification. */
  classification?: DocClassification;
  /**
   * Optional content hash supplied by the source. When present, the
   * sync engine uses it to skip re-fetching unchanged documents. When
   * absent, the engine always fetches.
   */
  contentHash?: string;
  /** Source-side last-modified timestamp (ISO), informational. */
  lastModified?: string;
}

/**
 * Full body content fetched for one document.
 */
export interface FetchedDoc {
  docId: string;
  title: string;
  /** Markdown body. May be empty for sources that have only metadata. */
  body: string;
  summary?: string;
  url?: string;
  classification?: DocClassification;
  /**
   * Source-attested content hash. When absent the sync engine will
   * compute one from `body` itself.
   */
  contentHash?: string;
  /**
   * Original source-file bytes, when the document came from a
   * non-text format that the adapter parsed locally (e.g. .docx,
   * .xlsx, .pdf).
   *
   * When set, the sync engine writes the bytes alongside the
   * markdown body at `.atelier/docs/<source>/<encoded-docId>.<ext>`
   * so the user has the binary on disk for offline reference. The
   * markdown body remains the searchable "indexed view" — the
   * original is archival.
   *
   * Adapters that produce pure-text bodies (`.md`, `.vtt`, GitHub
   * Discussions, etc.) leave this undefined — the body itself IS
   * the original and there's nothing extra worth duplicating.
   */
  original?: {
    /** Raw file bytes. */
    bytes: Buffer;
    /** Filename extension, without the leading dot. e.g. "docx". */
    extension: string;
  };
}

/**
 * The contract every adapter implements. Both methods are async and
 * may throw; the sync engine catches and surfaces errors per source
 * so a single bad source can't fail the whole sync.
 */
export interface SourceAdapter {
  /** Stable id (matches the {@link Source.kind} of sources it serves). */
  readonly kind: string;
  /** Quick check: can this adapter talk to its backing system? */
  checkAvailability(): Promise<AdapterAvailability>;
  /** Enumerate every doc the source can see (subject to scope). */
  listDocs(): Promise<RemoteDocMetadata[]>;
  /** Fetch a single doc's content. */
  fetchDoc(docId: string): Promise<FetchedDoc>;
}

export type AdapterAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Resolves a {@link Source} (the YAML record) to a working
 * {@link SourceAdapter}. The factory is async because adapters can do
 * setup (spawn subprocesses, open MCP connections) that's cleanly
 * tied to their lifecycle.
 *
 * Callers should pass the resolved adapter through to the sync engine
 * and dispose it (if `dispose` is present) once the sync is done.
 */
export interface SourceAdapterFactory {
  create(source: Source): Promise<SourceAdapter & { dispose?(): Promise<void> }>;
}
