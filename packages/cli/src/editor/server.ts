import * as http from "node:http";
import * as crypto from "node:crypto";
import { renderEditorHtml } from "./frontend.js";

/**
 * Headless little HTTP server that hosts the manual-add editor.
 *
 * Lifecycle:
 *
 *   1. Atelier CLI calls `startEditorSession()`. The server binds to
 *      127.0.0.1 on a kernel-chosen free port, prints nothing.
 *   2. Caller hands the returned `url` to the browser launcher, which
 *      opens it in a chromeless `chrome --app=` window (or the default
 *      browser as a fallback).
 *   3. The user fills in the form and clicks Save (or Cancel).
 *   4. The server resolves the `done` promise with the user's input
 *      (or a cancellation), then closes.
 *
 * Why a one-shot server per session? The editor is a transient
 * affordance, not a persistent endpoint. Spinning up + tearing
 * down per `/doc add` invocation means we never hold a port open
 * between sessions, and the CSRF-ish token can be single-use.
 *
 * Why bind to 127.0.0.1 explicitly and not 0.0.0.0? Defense in
 * depth — we don't want the editor reachable from other machines
 * on the network even briefly. The token check is the primary
 * guard; the loopback bind is the second line.
 */

export interface EditorSession {
  /** URL to hand to the browser. Includes the auth token. */
  url: string;
  /** Resolves when the user saves or cancels (or the timeout fires). */
  done: Promise<EditorOutcome>;
  /**
   * Force-close the server. Call from a `finally` so a launcher
   * failure (no Chrome, user kills the terminal) doesn't leak the
   * listener. Safe to call multiple times.
   */
  close: () => Promise<void>;
}

export type EditorOutcome =
  | { kind: "saved"; filename: string; title: string; body: string }
  | { kind: "cancelled" }
  | { kind: "timeout" };

export interface StartEditorOptions {
  /**
   * Hard limit on how long the session can stay open. Default 10
   * minutes — long enough for a real edit, short enough that an
   * orphaned window doesn't leak a port forever.
   */
  timeoutMs?: number;
  /** Host to bind to. Defaults to loopback. */
  host?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function startEditorSession(
  opts: StartEditorOptions = {}
): Promise<EditorSession> {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Random per-session token. Embedded in the page; required on
  // every POST. Stops a stray script on localhost from posting to
  // the save endpoint with crafted content.
  const token = crypto.randomBytes(24).toString("base64url");

  let resolveDone: (o: EditorOutcome) => void;
  const done = new Promise<EditorOutcome>((res) => {
    resolveDone = res;
  });

  let closed = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const server = http.createServer((req, res) => {
    // Tiny dispatcher. We never serve more than a few routes so
    // not worth wiring in a router.
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        // Don't let the browser cache this page across sessions —
        // each session has a new token.
        "Cache-Control": "no-store",
        // Defense-in-depth: even though the page is served from
        // localhost we deny embedding it elsewhere.
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
      res.end(renderEditorHtml({ token }));
      return;
    }
    // /cancel accepts the token via either the header (normal
    // fetch path from the editor) OR a `?token=` query (the
    // pagehide beacon path — `navigator.sendBeacon` can't set
    // custom headers, so we let the token ride in the URL for
    // that one endpoint). /save always requires the header
    // because it carries user content we want to authenticate
    // strictly.
    const isSavePost = req.method === "POST" && req.url?.split("?")[0] === "/save";
    const isCancelPost = req.method === "POST" && req.url?.split("?")[0] === "/cancel";
    if (isSavePost || isCancelPost) {
      const headerToken = req.headers["x-atelier-token"];
      let queryToken: string | undefined;
      if (isCancelPost && req.url) {
        try {
          const parsed = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
          queryToken = parsed.searchParams.get("token") ?? undefined;
        } catch {
          /* ignore */
        }
      }
      const provided = headerToken ?? queryToken;
      if (provided !== token) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("forbidden");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const payload = raw ? JSON.parse(raw) : {};
          if (isCancelPost) {
            res.writeHead(204);
            res.end();
            settle({ kind: "cancelled" });
            return;
          }
          const filename = typeof payload.filename === "string" ? payload.filename.trim() : "";
          const title = typeof payload.title === "string" ? payload.title.trim() : "";
          const body = typeof payload.body === "string" ? payload.body : "";
          if (!filename) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("filename is required");
            return;
          }
          if (!/^[a-zA-Z0-9._\- ]+$/.test(filename)) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("filename contains disallowed characters");
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          settle({ kind: "saved", filename, title: title || filename, body });
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("bad request: " + (err as Error).message);
        }
      });
      return;
    }
    // Favicon and anything else — silent 404.
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("editor server failed to bind");
  }
  const sessionUrl = `http://${host}:${addr.port}/?t=${encodeURIComponent(token.slice(0, 8))}`;

  // Settle helper: resolves the done promise and tears down the
  // listener. Idempotent — once we've heard from the editor (or
  // the timeout fired) we don't want a later callback to flip
  // the result.
  function settle(outcome: EditorOutcome): void {
    if (closed) return;
    closed = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Small delay so the response we just sent flushes before
    // the listener stops accepting new connections.
    setTimeout(() => {
      server.close();
    }, 50);
    resolveDone(outcome);
  }

  timeoutHandle = setTimeout(() => {
    settle({ kind: "timeout" });
  }, timeoutMs);
  timeoutHandle.unref?.();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // If anyone was awaiting `done`, resolve with a cancellation
    // so they don't hang forever.
    resolveDone({ kind: "cancelled" });
  };

  return { url: sessionUrl, done, close };
}
