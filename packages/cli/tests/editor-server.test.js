import { test } from "node:test";
import assert from "node:assert/strict";
import { startEditorSession } from "../dist/editor/server.js";

/**
 * Tests for the manual-add editor's HTTP server.
 *
 * We don't actually launch a browser here — the tests pretend to
 * be the editor frontend, POSTing the same JSON the real page
 * would, and assert the server's done-promise resolves correctly.
 *
 * Two pieces of the URL matter:
 *   - The port (chosen by the kernel via `listen(0)`).
 *   - The leading 8 chars of the token in the query (a hint to
 *     the user, NOT used for auth — the auth token is full-length
 *     and lives in the served HTML).
 *
 * To get the full token we fetch the page itself, parse it, and
 * use that in the POST headers. Same path the browser uses.
 */

/** Pull the full auth token out of the rendered HTML page. */
async function fetchToken(url) {
  // The URL we get back from the server has `?t=<first8>` — strip
  // that off and request the bare root so we get a clean page.
  const root = new URL(url);
  root.searchParams.delete("t");
  const r = await fetch(root.toString());
  const html = await r.text();
  // Match the `const TOKEN = "..."` line in the inline script.
  const m = /const TOKEN = "([^"]+)"/.exec(html);
  if (!m) throw new Error("token not found in served page");
  return m[1];
}

test("editor server resolves with the saved payload after a POST /save", async () => {
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const token = await fetchToken(session.url);
    const r = await fetch(new URL("/save", session.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": token,
      },
      body: JSON.stringify({
        filename: "test-doc",
        title: "Test Doc",
        body: "# Hello\n\nBody.",
      }),
    });
    assert.equal(r.status, 200);
    const outcome = await session.done;
    assert.equal(outcome.kind, "saved");
    assert.equal(outcome.filename, "test-doc");
    assert.equal(outcome.title, "Test Doc");
    assert.equal(outcome.body, "# Hello\n\nBody.");
  } finally {
    await session.close();
  }
});

test("editor server resolves with cancelled after a POST /cancel", async () => {
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const token = await fetchToken(session.url);
    const r = await fetch(new URL("/cancel", session.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": token,
      },
      body: "{}",
    });
    assert.equal(r.status, 204);
    const outcome = await session.done;
    assert.equal(outcome.kind, "cancelled");
  } finally {
    await session.close();
  }
});

test("editor server accepts POST /cancel?token=... (pagehide-beacon path)", async () => {
  // navigator.sendBeacon can't set custom headers, so the
  // editor's window-close beacon rides the token in the URL
  // query instead. The server must accept that form for
  // /cancel specifically — /save still requires the header.
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const token = await fetchToken(session.url);
    const r = await fetch(
      new URL("/cancel?token=" + encodeURIComponent(token), session.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        // No X-Atelier-Token header — that's the whole point of
        // this code path.
      }
    );
    assert.equal(r.status, 204);
    const outcome = await session.done;
    assert.equal(outcome.kind, "cancelled");
  } finally {
    await session.close();
  }
});

test("editor server rejects POST /save?token=... (header-only required for /save)", async () => {
  // /save shouldn't accept the query-token shortcut — it
  // carries user content we want authenticated strictly.
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const token = await fetchToken(session.url);
    const r = await fetch(
      new URL("/save?token=" + encodeURIComponent(token), session.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "x", body: "y" }),
      }
    );
    assert.equal(r.status, 403);
  } finally {
    await session.close();
  }
});

test("editor server rejects POST /save without the correct token", async () => {
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const r = await fetch(new URL("/save", session.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": "wrong",
      },
      body: JSON.stringify({ filename: "x", body: "y" }),
    });
    assert.equal(r.status, 403);
  } finally {
    await session.close();
  }
});

test("editor server rejects POST /save with an empty filename", async () => {
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const token = await fetchToken(session.url);
    const r = await fetch(new URL("/save", session.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": token,
      },
      body: JSON.stringify({ filename: "  ", body: "y" }),
    });
    assert.equal(r.status, 400);
  } finally {
    await session.close();
  }
});

test("editor server rejects filenames with disallowed characters", async () => {
  const session = await startEditorSession({ timeoutMs: 5000 });
  try {
    const token = await fetchToken(session.url);
    const r = await fetch(new URL("/save", session.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atelier-Token": token,
      },
      body: JSON.stringify({ filename: "bad/name?", body: "y" }),
    });
    assert.equal(r.status, 400);
  } finally {
    await session.close();
  }
});

test("editor server times out cleanly when nobody saves or cancels", async () => {
  const session = await startEditorSession({ timeoutMs: 100 });
  // Don't POST anything — let the timeout fire.
  const outcome = await session.done;
  assert.equal(outcome.kind, "timeout");
  await session.close();
});

test("editor served HTML escapes the token (no script injection from the token bytes)", async () => {
  // Quick sanity check that the token shows up inside a JSON-
  // quoted string in the page. crypto.randomBytes(24).toString
  // base64url-encodes — no special chars — but the escape pass
  // should still produce safe HTML even if it ever changes.
  const session = await startEditorSession({ timeoutMs: 1000 });
  try {
    const r = await fetch(session.url);
    const html = await r.text();
    assert.match(html, /const TOKEN = "[A-Za-z0-9_-]+"/);
    // Make sure we never produce an unclosed script tag.
    const open = (html.match(/<script\b/g) ?? []).length;
    const close = (html.match(/<\/script>/g) ?? []).length;
    assert.equal(open, close);
  } finally {
    await session.close();
  }
});
