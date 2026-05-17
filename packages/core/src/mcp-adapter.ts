import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type {
  AdapterAvailability,
  FetchedDoc,
  RemoteDocMetadata,
  SourceAdapter,
} from "./source-adapters.js";
import type { McpServerDef } from "./mcp-config.js";
import type { Source } from "./types.js";

import { ATELIER_VERSION } from "./version.js";

/**
 * MCP source adapter.
 *
 * Implements the {@link SourceAdapter} contract by talking JSON-RPC
 * over stdio to a user-configured MCP server (see {@link McpServerDef}
 * and `~/.atelier/mcp-servers.json`). The transport is
 * {@link StdioMcpClient}; tests can inject a fake client via
 * {@link buildFakeMcpClient}.
 *
 * Atelier-compatible MCP servers are expected to expose two tools
 * (names overridable per server in config):
 *   - `atelier_list_docs(scope) -> { docs: [{docId, title, ...}] }`
 *   - `atelier_fetch_doc({docId}) -> { docId, title, body, ... }`
 *
 * The adapter prefers the MCP 2024-11-05 `structuredContent` field
 * for tool results. Servers that only return text content blocks are
 * supported too — the first text block is parsed as JSON.
 */

export const MCP_TRANSPORT_READY = true;

/**
 * Minimal interface the MCP adapter requires of a client. Lets tests
 * inject a fake client without touching the network or filesystem.
 */
export interface McpClient {
  /** Call a server tool by name. Returns the tool's structured result. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Tear down the underlying transport. Idempotent. */
  dispose(): Promise<void>;
  /**
   * Resolves when the transport has completed any handshake required
   * before tool calls are valid. Optional — fake clients (and any
   * client that's ready synchronously) can omit it. The adapter's
   * `checkAvailability` awaits this to surface spawn/init failures
   * before the first tool call.
   */
  whenReady?(): Promise<void>;
}

/**
 * The conventional shape Atelier expects from an MCP server's
 * documentation tools. Server authors can adapt their existing tools
 * to this shape, or override `tools.list`/`tools.fetch` names in
 * `~/.atelier/mcp-servers.json`.
 */
export interface McpListDocsResult {
  docs: Array<{
    docId: string;
    title: string;
    summary?: string;
    url?: string;
    contentHash?: string;
    lastModified?: string;
  }>;
}

export interface McpFetchDocResult {
  docId: string;
  title: string;
  body: string;
  summary?: string;
  url?: string;
  contentHash?: string;
}

export interface McpAdapterOptions {
  /** The server's id from `~/.atelier/mcp-servers.json`. */
  serverId: string;
  /** The server definition (looked up from config). */
  server: McpServerDef;
  /** Pre-built client. Tests pass a fake; real usage passes a stdio one. */
  client: McpClient;
  /** Optional scope hints to forward as a tool argument. */
  scope?: Record<string, unknown>;
}

export class McpSourceAdapter implements SourceAdapter {
  readonly kind = "mcp";

  constructor(private readonly opts: McpAdapterOptions) {}

  async checkAvailability(): Promise<AdapterAvailability> {
    if (this.opts.client.whenReady) {
      try {
        await this.opts.client.whenReady();
      } catch (err) {
        return {
          available: false,
          reason: `MCP server "${this.opts.serverId}" failed to initialize: ${(err as Error).message}`,
        };
      }
    }
    return { available: true };
  }

  async listDocs(): Promise<RemoteDocMetadata[]> {
    const toolName = this.opts.server.tools?.list ?? "atelier_list_docs";
    const raw = (await this.opts.client.callTool(toolName, {
      scope: this.opts.scope ?? {},
    })) as McpListDocsResult;
    if (!raw || !Array.isArray(raw.docs)) {
      throw new Error(
        `MCP server "${this.opts.serverId}": tool "${toolName}" returned an unexpected shape (expected { docs: [...] }).`
      );
    }
    return raw.docs.map((d) => ({
      docId: d.docId,
      title: d.title,
      summary: d.summary,
      url: d.url,
      contentHash: d.contentHash,
      lastModified: d.lastModified,
    }));
  }

  async fetchDoc(docId: string): Promise<FetchedDoc> {
    const toolName = this.opts.server.tools?.fetch ?? "atelier_fetch_doc";
    const raw = (await this.opts.client.callTool(toolName, { docId })) as McpFetchDocResult;
    if (!raw || typeof raw.body !== "string") {
      throw new Error(
        `MCP server "${this.opts.serverId}": tool "${toolName}" returned an unexpected shape (expected { docId, title, body }).`
      );
    }
    return {
      docId: raw.docId ?? docId,
      title: raw.title,
      body: raw.body,
      summary: raw.summary,
      url: raw.url,
      contentHash: raw.contentHash,
    };
  }
}

// ============================================================
// StdioMcpClient — JSON-RPC 2.0 over the server's stdin/stdout
// ============================================================

/**
 * JSON-RPC 2.0 message shapes we exchange with the server.
 *
 * The MCP stdio transport is newline-delimited JSON: one message per
 * line on each direction. Stderr is for server-side logging and is
 * intentionally not parsed as protocol.
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Tool-result shape per MCP 2024-11-05. */
interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The MCP protocol version we negotiate. Servers that don't support
 * exactly this version typically respond with their supported version
 * in the `initialize` result — we don't bother to renegotiate today,
 * but the server's reply is logged via stderr.
 */
const PROTOCOL_VERSION = "2024-11-05";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/**
 * Real stdio JSON-RPC client for MCP servers. Lifecycle:
 *
 *   1. Constructor spawns the subprocess and immediately kicks off
 *      `initialize`. The promise is stashed in `initPromise` so any
 *      subsequent `callTool` waits on it without explicit ordering.
 *   2. `callTool` sends `tools/call`, awaits the response, and
 *      unwraps `structuredContent` (or falls back to parsing the
 *      first text content block as JSON).
 *   3. `dispose` shuts the subprocess down cleanly.
 *
 * Errors propagate as rejections. If the subprocess exits while
 * requests are in flight, every pending request rejects with the
 * exit reason — preferable to hanging forever.
 */
export class StdioMcpClient implements McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutLines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly initPromise: Promise<void>;
  private nextId = 1;
  private exited = false;
  private exitError?: Error;
  /** Captured server stderr so callers can surface protocol errors. */
  private readonly stderrBuffer: string[] = [];

  constructor(private readonly server: McpServerDef) {
    if (!server.command || server.command.length === 0) {
      throw new Error("StdioMcpClient: server.command is required");
    }
    this.child = spawn(server.command, server.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(server.env ?? {}) },
    });
    this.stdoutLines = createInterface({ input: this.child.stdout });
    this.stdoutLines.on("line", (line) => this.onStdoutLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer.push(chunk.toString("utf8"));
      // Keep the buffer bounded so a chatty server doesn't grow forever.
      if (this.stderrBuffer.length > 200) this.stderrBuffer.shift();
    });
    this.child.on("error", (err) => {
      this.exitError = err as Error;
      this.exited = true;
      this.rejectAll(this.exitError);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (this.pending.size > 0) {
        const reason = code !== null ? `exit code ${code}` : `signal ${signal}`;
        this.exitError = new Error(
          `MCP server exited (${reason}) with ${this.pending.size} request(s) in flight.${this.stderrTail()}`
        );
        this.rejectAll(this.exitError);
      }
    });

    this.initPromise = this.initialize();
  }

  /**
   * The MCP handshake: send `initialize`, await capabilities, send
   * the `notifications/initialized` notification.
   */
  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "atelier", version: ATELIER_VERSION },
    });
    this.notify("notifications/initialized", {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initPromise;
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as ToolCallResult;
    return unwrapToolResult(name, result);
  }

  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  async dispose(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    // Give the server a moment to exit on its own; if it doesn't,
    // SIGTERM. We don't await `exit` here because dispose() is
    // expected to return promptly.
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(
        this.exitError ?? new Error("MCP server has exited")
      );
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write(msg);
    });
  }

  private notify(method: string, params: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.write(msg);
  }

  private write(msg: unknown): void {
    const line = JSON.stringify(msg) + "\n";
    try {
      this.child.stdin.write(line);
    } catch (err) {
      // Stdin already closed — surface to pending requests on next exit.
      this.exitError = err as Error;
    }
  }

  private onStdoutLine(line: string): void {
    if (!line.trim()) return;
    let parsed: JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Servers occasionally emit non-JSON on stdout (banner text,
      // log lines that should have gone to stderr). Ignore quietly —
      // protocol clients are required to tolerate this per spec.
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    if (!("id" in parsed)) return; // notifications from server, currently ignored
    const r = parsed as JsonRpcResponse;
    if (typeof r.id !== "number") return; // we never send string ids
    const pending = this.pending.get(r.id);
    if (!pending) return;
    this.pending.delete(r.id);
    if (r.error) {
      pending.reject(
        new Error(
          `MCP ${pending.method} failed: ${r.error.message} (code ${r.error.code})`
        )
      );
    } else {
      pending.resolve(r.result);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private stderrTail(): string {
    const tail = this.stderrBuffer.join("").trim();
    if (!tail) return "";
    const lines = tail.split("\n").slice(-5).join("\n");
    return `\n--- server stderr (last lines) ---\n${lines}`;
  }
}

/**
 * Unwrap a `tools/call` response into the structured payload Atelier
 * expects. The MCP `structuredContent` field is preferred (typed
 * arbitrary JSON). Otherwise, the first `text` content block is
 * parsed as JSON.
 */
function unwrapToolResult(name: string, result: ToolCallResult): unknown {
  if (result.isError === true) {
    const text =
      result.content?.find((c) => c.type === "text" && typeof c.text === "string")
        ?.text ?? "(no error detail)";
    throw new Error(`MCP tool "${name}" reported an error: ${text}`);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const textBlock = result.content.find(
      (c) => c.type === "text" && typeof c.text === "string"
    );
    if (textBlock?.text !== undefined) {
      try {
        return JSON.parse(textBlock.text);
      } catch (err) {
        throw new Error(
          `MCP tool "${name}" returned a text block that isn't valid JSON: ${(err as Error).message}`
        );
      }
    }
  }
  throw new Error(
    `MCP tool "${name}" returned neither structuredContent nor a text content block`
  );
}

/** Resolve an MCP source to an adapter, using injected client + config. */
export function makeMcpAdapter(
  source: Source,
  server: McpServerDef,
  client: McpClient
): McpSourceAdapter {
  return new McpSourceAdapter({
    serverId: source.mcpServer ?? source.id,
    server,
    client,
    scope: source.scope,
  });
}
