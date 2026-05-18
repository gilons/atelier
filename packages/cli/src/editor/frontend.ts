/**
 * Inline HTML for the manual-add editor window.
 *
 * Why one file and inline rather than static assets on disk?
 *
 *   1. `tsc --build` doesn't copy non-TS files into `dist/`. Inlining
 *      keeps everything inside the TS compile graph — no postbuild
 *      copy step, no risk of the runtime serving a stale asset.
 *   2. The editor is small (form + contenteditable + toolbar + a few
 *      hundred lines of JS); a single string stays readable enough.
 *   3. The server template-substitutes a CSRF-ish token into the
 *      page so save/cancel POSTs from a hostile localhost script
 *      can't impersonate the editor.
 *
 * The frontend talks to atelier via two endpoints:
 *
 *   POST /save    body: { filename, body, title? }
 *   POST /cancel  body: {}
 *
 * Both include the token in an `X-Atelier-Token` header. The server
 * rejects anything that doesn't match. On a successful POST the
 * frontend shows a small success card and the server (after a tiny
 * delay so the user sees it) shuts down — Chrome's `--app=` window
 * closes when the page navigates to about:blank.
 *
 * Rich text handling:
 *   - `contenteditable` div backed by `document.execCommand` for the
 *     toolbar (Bold / Italic / H1-2 / lists). execCommand is
 *     deprecated but every browser still implements it and it's the
 *     simplest path that produces the formatting most users expect
 *     when they hit the obvious keyboard shortcuts.
 *   - Paste: when the clipboard carries HTML (the "rich" path,
 *     e.g. Word/Google Docs), we normalize it into markdown via a
 *     small inline converter. Plain-text paste passes through
 *     verbatim.
 *   - Save: serialize the editor's current HTML into markdown using
 *     the same converter, then POST.
 */

/**
 * Render the editor's HTML for a given session.
 *
 * `token` is generated per-session by the server and embedded into
 * the page so save/cancel requests are authenticated.
 */
export function renderEditorHtml(opts: { token: string }): string {
  // Escape the token for safe insertion into HTML. The token is
  // base64url so no special chars in practice, but defensive
  // escaping is cheap.
  const token = opts.token.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[c] ?? c
  );
  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Add document — Atelier</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>${EDITOR_CSS}</style>
</head>
<body>
  <main class="editor">
    <header class="editor__header">
      <h1>Add document</h1>
      <p class="editor__sub">
        The filename becomes the doc's id. The body is saved as markdown.
      </p>
    </header>

    <form id="form" class="editor__form" autocomplete="off">
      <label class="field">
        <span class="field__label">File name <em class="required">*</em></span>
        <input
          id="filename"
          name="filename"
          type="text"
          required
          placeholder="onboarding-prd"
          autofocus
          spellcheck="false"
        />
        <span class="field__hint">
          Letters, numbers, hyphens. No spaces — they'll be replaced.
        </span>
      </label>

      <label class="field">
        <span class="field__label">Title <span class="field__optional">(optional)</span></span>
        <input
          id="title"
          name="title"
          type="text"
          placeholder="Defaults to the file name"
        />
      </label>

      <div class="field">
        <span class="field__label">Content</span>
        <div class="toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" data-cmd="bold"     title="Bold (⌘B)"><strong>B</strong></button>
          <button type="button" data-cmd="italic"   title="Italic (⌘I)"><em>I</em></button>
          <button type="button" data-cmd="underline" title="Underline (⌘U)"><u>U</u></button>
          <span class="toolbar__sep"></span>
          <button type="button" data-cmd="h1"       title="Heading 1">H1</button>
          <button type="button" data-cmd="h2"       title="Heading 2">H2</button>
          <button type="button" data-cmd="h3"       title="Heading 3">H3</button>
          <span class="toolbar__sep"></span>
          <button type="button" data-cmd="ul"       title="Bulleted list">•</button>
          <button type="button" data-cmd="ol"       title="Numbered list">1.</button>
          <button type="button" data-cmd="quote"    title="Block quote">”</button>
          <span class="toolbar__sep"></span>
          <button type="button" data-cmd="link"     title="Link (⌘K)">⌘K</button>
          <button type="button" data-cmd="code"     title="Inline code">&lt;/&gt;</button>
          <span class="toolbar__sep"></span>
          <button type="button" data-cmd="clear"    title="Clear formatting" class="toolbar__danger">↺</button>
        </div>
        <div
          id="body"
          class="body"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          aria-label="Document content"
          spellcheck="true"
        ></div>
        <span class="field__hint">
          Paste from Word / Google Docs — formatting is preserved and converted to markdown on save.
        </span>
      </div>

      <footer class="editor__actions">
        <button type="button" id="cancel" class="btn btn--ghost">Cancel</button>
        <button type="submit" id="save"   class="btn btn--primary">Save document</button>
      </footer>

      <p id="status" class="status" role="status" aria-live="polite"></p>
    </form>
  </main>

  <script>
    const TOKEN = ${JSON.stringify(token)};
    ${EDITOR_JS}
  </script>
</body>
</html>
`;
}

// ============================================================
// CSS — keep the form looking like a desktop dialog
// ============================================================

const EDITOR_CSS = /* css */ `
  :root {
    --bg: #fafaf9;
    --fg: #1f2328;
    --muted: #6b7280;
    --border: #d8d4cb;
    --border-focus: #6e6753;
    --primary: #1f2328;
    --primary-fg: #ffffff;
    --accent: #b85e3e;
    --shadow: 0 1px 0 rgba(0,0,0,0.04);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .editor {
    max-width: 760px;
    margin: 0 auto;
    padding: 28px 28px 32px;
  }
  .editor__header h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .editor__sub { margin: 0 0 24px; color: var(--muted); font-size: 13px; }
  .editor__form { display: grid; gap: 18px; }
  .field { display: grid; gap: 6px; }
  .field__label { font-size: 12px; font-weight: 600; color: var(--fg); text-transform: uppercase; letter-spacing: 0.04em; }
  .field__optional { color: var(--muted); text-transform: none; font-weight: 400; letter-spacing: 0; }
  .field__hint { font-size: 12px; color: var(--muted); }
  .required { color: var(--accent); font-style: normal; }

  input[type="text"] {
    width: 100%;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fff;
    font: inherit;
    box-shadow: var(--shadow);
    color: var(--fg);
  }
  input[type="text"]:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(110,103,83,0.15);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 4px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 6px 6px 0 0;
    border-bottom: none;
    box-shadow: var(--shadow);
  }
  .toolbar button {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 5px 9px;
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    color: var(--fg);
    cursor: pointer;
    min-width: 30px;
    line-height: 1;
  }
  .toolbar button:hover { background: rgba(0,0,0,0.05); }
  .toolbar button:active { background: rgba(0,0,0,0.1); }
  .toolbar button.toolbar__danger { color: var(--accent); }
  .toolbar__sep { width: 1px; background: var(--border); margin: 3px 4px; }

  .body {
    min-height: 280px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 14px 16px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 0 0 6px 6px;
    box-shadow: var(--shadow);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--fg);
    outline: none;
  }
  .body:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px rgba(110,103,83,0.15); }
  .body:empty::before {
    content: attr(data-placeholder);
    color: var(--muted);
  }
  .body p { margin: 0 0 0.6em; }
  .body h1, .body h2, .body h3 { margin: 0.6em 0 0.3em; line-height: 1.25; font-weight: 600; }
  .body h1 { font-size: 1.45em; }
  .body h2 { font-size: 1.22em; }
  .body h3 { font-size: 1.08em; }
  .body blockquote { margin: 0 0 0.6em; padding: 0 0 0 12px; border-left: 3px solid var(--border); color: var(--muted); }
  .body ul, .body ol { padding-left: 1.4em; margin: 0 0 0.6em; }
  .body code { background: rgba(0,0,0,0.05); padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
  .body a { color: var(--accent); text-decoration: underline; }

  .editor__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .btn {
    appearance: none;
    border: 1px solid transparent;
    padding: 8px 14px;
    border-radius: 6px;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    line-height: 1;
  }
  .btn--primary { background: var(--primary); color: var(--primary-fg); }
  .btn--primary:hover { background: #000; }
  .btn--primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn--ghost { background: transparent; color: var(--fg); border-color: var(--border); }
  .btn--ghost:hover { background: rgba(0,0,0,0.04); }

  .status { margin: 0; min-height: 1.2em; font-size: 13px; color: var(--muted); }
  .status.is-error { color: var(--accent); }
  .status.is-success { color: #2c7a4b; }
`;

// ============================================================
// JS — editor behaviour + HTML→markdown serializer
// ============================================================

const EDITOR_JS = /* javascript */ `
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const filenameInput = $("filename");
  const titleInput = $("title");
  const body = $("body");
  const cancelBtn = $("cancel");
  const saveBtn = $("save");
  const status = $("status");

  // Show the editable area's empty-state hint via attribute (CSS reads it).
  body.dataset.placeholder = "Start typing — or paste from Word / Google Docs to keep formatting.";

  // ============================================================
  // Toolbar — execCommand-based formatting. execCommand is
  // deprecated but every browser still implements it and the
  // alternatives (manual Selection/Range manipulation) are 10x
  // the code for the same result.
  // ============================================================
  function runCmd(cmd) {
    body.focus();
    switch (cmd) {
      case "bold": document.execCommand("bold"); break;
      case "italic": document.execCommand("italic"); break;
      case "underline": document.execCommand("underline"); break;
      case "h1": document.execCommand("formatBlock", false, "H1"); break;
      case "h2": document.execCommand("formatBlock", false, "H2"); break;
      case "h3": document.execCommand("formatBlock", false, "H3"); break;
      case "ul": document.execCommand("insertUnorderedList"); break;
      case "ol": document.execCommand("insertOrderedList"); break;
      case "quote": document.execCommand("formatBlock", false, "BLOCKQUOTE"); break;
      case "code": wrapInline("code"); break;
      case "link": {
        const sel = window.getSelection();
        const initial = sel && sel.toString().match(/^https?:\\/\\//) ? sel.toString() : "https://";
        const url = window.prompt("Link URL", initial);
        if (url) document.execCommand("createLink", false, url);
        break;
      }
      case "clear": document.execCommand("removeFormat"); break;
    }
  }
  function wrapInline(tag) {
    // <code> doesn't have an execCommand. Manual wrap: only acts
    // when there's a non-empty selection.
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const wrapper = document.createElement(tag);
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    sel.removeAllRanges();
    sel.selectAllChildren(wrapper);
  }
  for (const btn of document.querySelectorAll(".toolbar button")) {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => runCmd(btn.dataset.cmd));
  }
  // Keyboard shortcuts — Cmd/Ctrl + key.
  body.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    const map = {
      "b": "bold", "i": "italic", "u": "underline",
      "1": "h1", "2": "h2", "3": "h3",
      "k": "link",
    };
    if (map[key]) { e.preventDefault(); runCmd(map[key]); }
    if (key === "s") { e.preventDefault(); save(); }
    if (key === "enter") { e.preventDefault(); save(); }
  });

  // ============================================================
  // Paste handling — when the clipboard carries HTML, normalize
  // it into a clean contenteditable subtree. We strip Word-
  // specific noise (mso-* styles, xml processing instructions,
  // <o:p>, etc.) and otherwise insert the HTML verbatim — the
  // browser handles rendering inside the contenteditable.
  // ============================================================
  body.addEventListener("paste", (e) => {
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (!html) return; // plain-text path: let the default happen
    e.preventDefault();
    const cleaned = sanitizePasteHtml(html);
    document.execCommand("insertHTML", false, cleaned);
  });

  function sanitizePasteHtml(html) {
    // Quick stripping of MS Word's verbose markup. A real
    // sanitizer would parse the DOM; for the common cases this
    // regex pass is enough.
    return html
      .replace(/<!--[\\s\\S]*?-->/g, "")
      .replace(/<\\?xml[^>]*\\?>/g, "")
      .replace(/<\\/?o:[^>]+>/g, "")
      .replace(/<\\/?w:[^>]+>/g, "")
      .replace(/<\\/?meta[^>]*>/gi, "")
      .replace(/<\\/?link[^>]*>/gi, "")
      .replace(/<\\/?style[^>]*>[\\s\\S]*?<\\/style>/gi, "")
      .replace(/<\\/?script[^>]*>[\\s\\S]*?<\\/script>/gi, "")
      .replace(/\\s(class|style|lang|align|valign|width|height|color|face|size)="[^"]*"/gi, "")
      .replace(/\\s(class|style|lang|align|valign|width|height|color|face|size)='[^']*'/gi, "");
  }

  // ============================================================
  // HTML → Markdown serializer
  //
  // Tiny tree walk. Covers the elements our toolbar emits + what
  // a Word paste typically lands in the editor: p, h1-h6, ul/ol/li,
  // blockquote, a, strong/b, em/i, u, code, br. Anything else is
  // recursed into for inner text.
  //
  // Returns trimmed markdown with consistent paragraph spacing.
  // ============================================================
  function htmlToMarkdown(rootHtml) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = rootHtml;
    let out = walkBlock(wrapper).trim();
    // Collapse 3+ consecutive blank lines into 2.
    out = out.replace(/\\n{3,}/g, "\\n\\n");
    return out + "\\n";
  }
  function walkBlock(node) {
    let out = "";
    for (const child of node.childNodes) {
      out += blockOf(child);
    }
    return out;
  }
  function blockOf(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = node.textContent.replace(/\\s+/g, " ");
      return txt;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case "p":         return "\\n\\n" + walkInline(node).trim() + "\\n\\n";
      case "h1":        return "\\n\\n# "    + walkInline(node).trim() + "\\n\\n";
      case "h2":        return "\\n\\n## "   + walkInline(node).trim() + "\\n\\n";
      case "h3":        return "\\n\\n### "  + walkInline(node).trim() + "\\n\\n";
      case "h4":        return "\\n\\n#### " + walkInline(node).trim() + "\\n\\n";
      case "h5":        return "\\n\\n##### " + walkInline(node).trim() + "\\n\\n";
      case "h6":        return "\\n\\n###### " + walkInline(node).trim() + "\\n\\n";
      case "blockquote": return "\\n\\n" + walkBlock(node).trim().split("\\n").map((l) => "> " + l).join("\\n") + "\\n\\n";
      case "ul":         return "\\n" + listItems(node, "- ") + "\\n";
      case "ol":         return "\\n" + listItems(node, "1. ") + "\\n";
      case "br":         return "  \\n";
      case "hr":         return "\\n\\n---\\n\\n";
      default:           return walkInline(node);
    }
  }
  function listItems(node, marker) {
    let out = "";
    let n = 1;
    for (const li of node.children) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const m = marker === "1. " ? n++ + ". " : marker;
      const content = walkInline(li).trim();
      out += m + content + "\\n";
    }
    return out;
  }
  function walkInline(node) {
    let out = "";
    for (const child of node.childNodes) {
      out += inlineOf(child);
    }
    return out;
  }
  function inlineOf(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case "strong":
      case "b":   return "**" + walkInline(node) + "**";
      case "em":
      case "i":   return "*" + walkInline(node) + "*";
      case "u":   return "<u>" + walkInline(node) + "</u>";
      case "code": return "\`" + node.textContent + "\`";
      case "a": {
        const href = node.getAttribute("href") || "";
        return "[" + walkInline(node) + "](" + href + ")";
      }
      case "br":  return "  \\n";
      case "span":
      default:    return walkInline(node);
    }
  }

  // ============================================================
  // Network — POST save / cancel back to atelier
  // ============================================================
  async function postJson(path, payload) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Atelier-Token": TOKEN },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error("HTTP " + r.status + (text ? ": " + text : ""));
    }
    return r;
  }

  // True once the user has either saved successfully or actively
  // cancelled. Used to suppress the pagehide beacon below — once
  // the session has settled we don't want a duplicate /cancel
  // arriving after a successful save (it would race the close
  // handler on the server side).
  let settled = false;

  async function save() {
    const filename = filenameInput.value.trim();
    if (!filename) {
      setStatus("File name is required.", "error");
      filenameInput.focus();
      return;
    }
    if (!/^[a-zA-Z0-9._\\- ]+$/.test(filename)) {
      setStatus("Use letters, numbers, dots, hyphens, underscores, or spaces.", "error");
      filenameInput.focus();
      return;
    }
    const title = titleInput.value.trim() || filename;
    const markdown = htmlToMarkdown(body.innerHTML);
    saveBtn.disabled = true;
    setStatus("Saving…");
    try {
      await postJson("/save", { filename, title, body: markdown });
      settled = true;
      setStatus("Saved. You can close this window.", "success");
      // Atelier's HTTP handler closes the server next tick; the
      // window's --app= host will see the connection drop and the
      // page will fail to reload if the user hits refresh, which
      // is fine. Most users just close the window.
      setTimeout(() => { window.close(); }, 400);
    } catch (err) {
      setStatus("Save failed: " + err.message, "error");
      saveBtn.disabled = false;
    }
  }

  async function cancel() {
    setStatus("Cancelling…");
    settled = true;
    try {
      await postJson("/cancel", {});
    } catch { /* ignore — we're closing anyway */ }
    setTimeout(() => { window.close(); }, 200);
  }

  // ============================================================
  // Window-close detection
  //
  // If the user closes the window via the OS chrome (the red X
  // on macOS, ⌘W, etc.) instead of the Cancel button, we don't
  // get to await a /cancel response — the page is being torn
  // down. Use \`navigator.sendBeacon\` from a \`pagehide\`
  // listener: the browser guarantees the beacon will be sent
  // even during unload, fire-and-forget, no network blocking.
  //
  // sendBeacon can't set custom headers, so the token rides in
  // the URL query for this one endpoint. The server only allows
  // query-token auth on /cancel; /save still requires the
  // header so it stays strict.
  //
  // The \`settled\` flag prevents this from firing after a real
  // save — we don't want a phantom /cancel racing the close
  // handler on the server.
  // ============================================================
  function fireCancelBeacon() {
    if (settled) return;
    settled = true;
    const url = "/cancel?token=" + encodeURIComponent(TOKEN);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob(["{}"], { type: "application/json" }));
      } else {
        // Older browsers: synchronous XHR is the last resort.
        // Still works during unload, just blocks the page for a
        // tick. Modern Chrome/Edge/Brave all have sendBeacon
        // so this path almost never fires.
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, false);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send("{}");
      }
    } catch { /* nothing useful to do during unload */ }
  }
  window.addEventListener("pagehide", fireCancelBeacon);
  // Some browsers (older Safari, mostly) don't fire pagehide
  // reliably for app-mode windows but DO fire beforeunload.
  // Listening to both is harmless — the \`settled\` flag makes
  // the second one a no-op.
  window.addEventListener("beforeunload", fireCancelBeacon);

  function setStatus(msg, kind) {
    status.textContent = msg || "";
    status.className = "status" + (kind === "error" ? " is-error" : kind === "success" ? " is-success" : "");
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  cancelBtn.addEventListener("click", cancel);
  // Esc cancels at any time.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
  });
})();
`;
