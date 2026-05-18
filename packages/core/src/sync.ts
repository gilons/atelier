import { listDocs, addDoc, updateDoc, removeDoc, hashBody, loadDoc } from "./docs.js";
import { listSources } from "./sources.js";
import { LocalFolderAdapter } from "./local-folder-adapter.js";
import {
  McpSourceAdapter,
  StdioMcpClient,
  type McpClient,
} from "./mcp-adapter.js";
import { loadMcpServersConfig } from "./mcp-config.js";
import {
  getAdapter,
  listAdapters,
  type AdapterRegistration,
} from "./onboarding.js";
import type { SourceAdapter } from "./source-adapters.js";
import type { Source, SourceTransport } from "./types.js";

/**
 * Sync orchestration: pull doc metadata from each enabled source,
 * diff against the doc map, and apply creates/updates/(optionally)
 * deletes.
 *
 * Pure with respect to the source adapter — the engine takes an
 * `adapterFactory` so tests pass fakes and production passes the
 * real factory. This is also how MCP sources will plug in once their
 * transport is finished: factory returns an `McpSourceAdapter` for
 * those source kinds.
 */

export interface SyncOptions {
  /** Limit sync to a single source id. */
  source?: string;
  /**
   * When true, remove doc entries that are no longer present in the
   * remote. Default false — orphans are preserved so an outage can't
   * delete the user's index.
   */
  removeOrphans?: boolean;
  /** Read remote state but don't write to disk. */
  dryRun?: boolean;
  /**
   * Adapter factory. The default resolves local-folder sources and
   * (once the transport ships) MCP sources from config; tests can
   * inject a deterministic factory.
   */
  adapterFactory?: AdapterFactory;
  /** Per-source error handler. Default: collect into the report. */
  onSourceError?: (source: Source, err: Error) => void;
}

export type AdapterFactory = (
  source: Source,
  workspaceRoot: string
) => Promise<SourceAdapter>;

/** Per-doc action taken (or planned, for dry-run) during sync. */
export type SyncActionKind = "created" | "updated" | "unchanged" | "orphaned" | "removed";

export interface SyncDocAction {
  source: string;
  docId: string;
  title: string;
  action: SyncActionKind;
}

/** Result for a single source. */
export interface SourceSyncReport {
  source: string;
  /** Adapter-reported total. */
  remoteCount: number;
  /** Doc entries Atelier knew about for this source before the sync. */
  localBefore: number;
  /** Doc entries after the sync (for dry-run, the would-be count). */
  localAfter: number;
  actions: SyncDocAction[];
  errors: { docId?: string; error: Error }[];
}

/** Aggregate result. */
export interface SyncReport {
  dryRun: boolean;
  sources: SourceSyncReport[];
  /** Sources skipped because they were disabled, filtered out, or unsupported. */
  skipped: { sourceId: string; reason: string }[];
}

/**
 * Resolve a source's transport. Back-compat: sources without an
 * explicit `transport` field are mapped from their kind (`local-folder`)
 * or from the presence of `mcpServer` (→ `mcp`). Anything else falls
 * through to checking the adapter registry — built-in adapters
 * declare which transport they default to.
 */
function resolveTransport(source: Source): SourceTransport {
  if (source.transport) return source.transport;
  if (source.kind === "local-folder") return "local-folder";
  if (source.mcpServer) return "mcp";
  return "rest";
}

/**
 * Default factory: dispatch on (kind, transport).
 *
 *   - `local-folder`  → `LocalFolderAdapter`
 *   - any kind / `mcp` → `McpSourceAdapter` with `StdioMcpClient`
 *   - any kind / `rest`|`cli` → built-in adapter from the registry
 *   - any kind / `external` → load adapterModule via dynamic import
 *
 * Tests should pass their own factory to skip filesystem lookup.
 */
export const defaultAdapterFactory: AdapterFactory = async (source, workspaceRoot) => {
  const transport = resolveTransport(source);

  if (source.kind === "local-folder" || transport === "local-folder") {
    return LocalFolderAdapter.fromSource(source, workspaceRoot);
  }

  if (transport === "mcp") {
    if (!source.mcpServer) {
      throw new Error(
        `Source "${source.id}" uses transport=mcp but has no \`mcpServer\` set. Re-run \`atelier source onboard ${source.kind}\` or edit sources.yaml.`
      );
    }
    const cfg = await loadMcpServersConfig();
    const server = cfg.servers[source.mcpServer];
    if (!server) {
      throw new Error(
        `Source "${source.id}" references MCP server "${source.mcpServer}" but no such server is defined in ~/.atelier/mcp-servers.json.`
      );
    }
    const client: McpClient = new StdioMcpClient(server);
    return new McpSourceAdapter({
      serverId: source.mcpServer,
      server,
      client,
      scope: source.scope,
    });
  }

  if (transport === "rest" || transport === "cli") {
    const reg = getAdapter(source.kind);
    if (!reg) {
      throw new Error(
        `No built-in adapter for kind "${source.kind}" with transport "${transport}". Available built-in adapters: ${listAdapters()
          .map((a) => a.kind)
          .join(", ") || "(none)"}.`
      );
    }
    return reg.build(source);
  }

  if (transport === "external") {
    if (!source.adapterModule) {
      throw new Error(
        `Source "${source.id}" uses transport=external but has no \`adapterModule\` set.`
      );
    }
    let mod: unknown;
    try {
      mod = await import(source.adapterModule);
    } catch (err) {
      throw new Error(
        `Source "${source.id}" failed to load adapter module "${source.adapterModule}": ${(err as Error).message}`
      );
    }
    const exported = (mod as { default?: unknown }).default ?? mod;
    const builder = (exported as { build?: AdapterRegistration["build"] }).build;
    if (typeof builder !== "function") {
      throw new Error(
        `Adapter module "${source.adapterModule}" does not export a \`build(source)\` function.`
      );
    }
    return builder(source);
  }

  throw new Error(
    `Source "${source.id}" has unsupported transport "${transport}".`
  );
};

/**
 * Build a fake MCP client for tests. Implements `callTool` against
 * the user-supplied function; `whenReady` is omitted so the adapter's
 * availability check passes immediately.
 */
export function buildFakeMcpClient(
  impl: Pick<McpClient, "callTool">
): McpClient {
  return {
    callTool: impl.callTool,
    dispose: async () => {},
  };
}

// ============================================================
// The sync function
// ============================================================

export async function syncWorkspace(
  workspaceRoot: string,
  opts: SyncOptions = {}
): Promise<SyncReport> {
  const factory = opts.adapterFactory ?? defaultAdapterFactory;
  const report: SyncReport = { dryRun: opts.dryRun === true, sources: [], skipped: [] };

  const sources = await listSources(workspaceRoot);
  for (const source of sources) {
    if (opts.source && source.id !== opts.source) {
      report.skipped.push({ sourceId: source.id, reason: "filtered out" });
      continue;
    }
    if (!source.enabled) {
      report.skipped.push({ sourceId: source.id, reason: "disabled" });
      continue;
    }
    let adapter: SourceAdapter;
    try {
      adapter = await factory(source, workspaceRoot);
    } catch (err) {
      const e = err as Error;
      if (opts.onSourceError) opts.onSourceError(source, e);
      report.skipped.push({ sourceId: source.id, reason: e.message });
      continue;
    }

    const availability = await adapter.checkAvailability();
    if (!availability.available) {
      if (opts.onSourceError)
        opts.onSourceError(source, new Error(availability.reason));
      report.skipped.push({ sourceId: source.id, reason: availability.reason });
      continue;
    }

    try {
      const sourceReport = await syncSource(workspaceRoot, source, adapter, opts);
      report.sources.push(sourceReport);
    } catch (err) {
      const e = err as Error;
      if (opts.onSourceError) opts.onSourceError(source, e);
      report.skipped.push({ sourceId: source.id, reason: e.message });
    } finally {
      const disposable = adapter as SourceAdapter & { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === "function") {
        try {
          await disposable.dispose();
        } catch {
          /* swallow */
        }
      }
    }
  }

  return report;
}

async function syncSource(
  workspaceRoot: string,
  source: Source,
  adapter: SourceAdapter,
  opts: SyncOptions
): Promise<SourceSyncReport> {
  const remoteList = await adapter.listDocs();
  const { docs: localList } = await listDocs(workspaceRoot, source.id);

  const localById = new Map(localList.map((l) => [l.doc.docId, l]));
  const remoteIds = new Set(remoteList.map((r) => r.docId));

  const actions: SyncDocAction[] = [];
  const errors: { docId?: string; error: Error }[] = [];
  let after = localList.length;

  // Create / update.
  for (const remote of remoteList) {
    const local = localById.get(remote.docId);
    try {
      if (!local) {
        // New doc — fetch and add.
        if (!opts.dryRun) {
          const fetched = await adapter.fetchDoc(remote.docId);
          const now = new Date().toISOString();
          await addDoc(workspaceRoot, {
            source: source.id,
            docId: remote.docId,
            title: fetched.title ?? remote.title,
            summary: fetched.summary ?? remote.summary,
            classification: fetched.classification ?? remote.classification,
            url: fetched.url ?? remote.url,
            body: fetched.body,
            fetchedAt: now,
            original: fetched.original,
            skipSourceValidation: true,
          });
        }
        after = opts.dryRun ? after + 1 : after + 1;
        actions.push({
          source: source.id,
          docId: remote.docId,
          title: remote.title,
          action: "created",
        });
      } else {
        // Existing — refetch only if hash differs (or remote doesn't advertise one).
        const sameHash =
          remote.contentHash !== undefined &&
          local.doc.contentHash !== undefined &&
          remote.contentHash === local.doc.contentHash;
        if (sameHash) {
          actions.push({
            source: source.id,
            docId: remote.docId,
            title: remote.title,
            action: "unchanged",
          });
          continue;
        }
        const fetched = await adapter.fetchDoc(remote.docId);
        const newHash = fetched.contentHash ?? hashBody(fetched.body);
        if (newHash === local.doc.contentHash) {
          actions.push({
            source: source.id,
            docId: remote.docId,
            title: remote.title,
            action: "unchanged",
          });
          continue;
        }
        if (!opts.dryRun) {
          await updateDoc(workspaceRoot, source.id, remote.docId, {
            title: fetched.title ?? remote.title,
            summary: fetched.summary ?? remote.summary,
            classification: fetched.classification ?? remote.classification ?? null,
            url: fetched.url ?? remote.url,
            body: fetched.body,
            original: fetched.original,
          });
        }
        actions.push({
          source: source.id,
          docId: remote.docId,
          title: fetched.title ?? remote.title,
          action: "updated",
        });
      }
    } catch (err) {
      errors.push({ docId: remote.docId, error: err as Error });
    }
  }

  // Orphans (locally present, not in remote).
  for (const [docId, listing] of localById) {
    if (remoteIds.has(docId)) continue;
    if (opts.removeOrphans) {
      if (!opts.dryRun) {
        await removeDoc(workspaceRoot, source.id, docId);
      }
      after = opts.dryRun ? after - 1 : after - 1;
      actions.push({
        source: source.id,
        docId,
        title: listing.doc.title,
        action: "removed",
      });
    } else {
      actions.push({
        source: source.id,
        docId,
        title: listing.doc.title,
        action: "orphaned",
      });
    }
  }

  return {
    source: source.id,
    remoteCount: remoteList.length,
    localBefore: localList.length,
    localAfter: opts.dryRun ? localList.length : after,
    actions,
    errors,
  };
}

/**
 * Convenience: re-fetch a single doc by id (used by `atelier sync
 * doc <source> <docId>`-style invocations later).
 */
export async function refreshDoc(
  workspaceRoot: string,
  sourceId: string,
  docId: string,
  adapter: SourceAdapter
): Promise<void> {
  const fetched = await adapter.fetchDoc(docId);
  // If we don't have it yet, addDoc; otherwise updateDoc.
  try {
    await loadDoc(workspaceRoot, sourceId, docId);
    await updateDoc(workspaceRoot, sourceId, docId, {
      title: fetched.title,
      summary: fetched.summary,
      url: fetched.url,
      body: fetched.body,
    });
  } catch {
    await addDoc(workspaceRoot, {
      source: sourceId,
      docId,
      title: fetched.title,
      summary: fetched.summary,
      url: fetched.url,
      body: fetched.body,
      fetchedAt: new Date().toISOString(),
      skipSourceValidation: true,
    });
  }
}
