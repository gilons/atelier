import * as http from "node:http";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * Live design preview — a tiny localhost server that renders a
 * session's `design-draft.md` (markdown + Mermaid diagrams) and
 * auto-refreshes as the system-design agent updates it during a call.
 *
 * This is the "good way to visualize" the Markdown fallback: when no
 * Figma/Excalidraw/Lucid is connected, the agent writes the running
 * design into design-draft.md and the user keeps this page open to
 * watch it take shape live. (When a tool IS connected, the agent
 * shares the tool's own link instead and this isn't needed.)
 *
 * Deliberately dependency-free on the Node side: a plain http server.
 * The browser page pulls markdown-it + Mermaid from a CDN, so the
 * live view needs internet at view time (the recorder/transcription
 * keep working offline regardless).
 */

/** The browser page: polls /draft and re-renders markdown + Mermaid. */
export function renderPreviewShell(title: string): string {
  const safeTitle = title.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
  );
  // NOTE: the browser JS below avoids backticks so this whole document
  // can live in a single template literal without escaping headaches.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<script src="https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js"></script>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; font: 15px/1.6 -apple-system, system-ui, sans-serif;
         background: #0f1115; color: #e6e6e6; }
  header { position: sticky; top: 0; background: #161922; border-bottom: 1px solid #262b36;
           padding: 10px 20px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; color: #c8d0e0; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ad29f; }
  header .meta { margin-left: auto; font-size: 12px; color: #6b7488; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 20px 80px; }
  h1, h2, h3 { color: #fff; }
  h2 { margin-top: 1.6em; border-bottom: 1px solid #262b36; padding-bottom: 4px; }
  code { background: #1c212b; padding: 1px 5px; border-radius: 4px; }
  pre { background: #1c212b; padding: 12px; border-radius: 8px; overflow: auto; }
  a { color: #6aa3ff; }
  .mermaid { background: #fbfbfe; border-radius: 8px; padding: 12px; margin: 12px 0; }
  blockquote { border-left: 3px solid #3a4254; margin: 12px 0; padding: 4px 14px; color: #aab3c5; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>${safeTitle}</h1>
  <span class="meta" id="meta">connecting…</span>
</header>
<main id="content"><p style="color:#6b7488">Waiting for the design draft…</p></main>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, theme: "default" });
  const md = window.markdownit({ html: false, linkify: true, breaks: false });
  const content = document.getElementById("content");
  const meta = document.getElementById("meta");
  let last = null;

  function renderMermaid() {
    const blocks = content.querySelectorAll("code.language-mermaid");
    blocks.forEach((c) => {
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = c.textContent;
      const pre = c.closest("pre") || c;
      pre.replaceWith(div);
    });
    const nodes = content.querySelectorAll(".mermaid");
    if (nodes.length) {
      try { mermaid.run({ nodes }); } catch (e) { /* partial diagram while typing */ }
    }
  }

  async function tick() {
    try {
      const r = await fetch("draft");
      const data = await r.json();
      if (data.mtime !== last) {
        last = data.mtime;
        content.innerHTML = md.render(data.markdown || "");
        renderMermaid();
      }
      const t = data.mtime ? new Date(data.mtime).toLocaleTimeString() : "—";
      meta.textContent = "updated " + t;
    } catch (e) {
      meta.textContent = "preview stopped";
    }
  }
  setInterval(tick, 2000);
  tick();
</script>
</body>
</html>`;
}

export interface PreviewServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StartPreviewOptions {
  /** Absolute path to the design-draft.md to serve. */
  draftPath: string;
  /** Page title. */
  title: string;
  /** Preferred port; 0 picks a random free one. Default 4317. */
  port?: number;
}

async function readDraft(draftPath: string): Promise<{ markdown: string; mtime: number }> {
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(draftPath, "utf8"),
      fs.stat(draftPath),
    ]);
    return { markdown: text, mtime: Math.floor(stat.mtimeMs) };
  } catch {
    return { markdown: "", mtime: 0 };
  }
}

/**
 * Start the preview server. Returns the URL + a close() handle.
 * Tries `port`, then a few above it, on EADDRINUSE (unless port is 0,
 * which lets the OS pick).
 */
export async function startDesignPreviewServer(
  opts: StartPreviewOptions
): Promise<PreviewServer> {
  const { draftPath, title } = opts;
  const shell = renderPreviewShell(title);

  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(shell);
      return;
    }
    if (url === "/draft") {
      readDraft(draftPath).then((d) => {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(d));
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const preferred = opts.port ?? 4317;
  const port = await listenWithFallback(server, preferred);
  return {
    url: `http://localhost:${port}/`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function listenWithFallback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryListen = (p: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && p !== 0 && attempts < 10) {
          attempts++;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : p);
      });
    };
    tryListen(port);
  });
}

/** Best-effort: open a URL in the user's default browser. Never throws. */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore — the URL is printed regardless */
  }
}
