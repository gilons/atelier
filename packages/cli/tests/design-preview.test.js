import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderPreviewShell,
  startDesignPreviewServer,
} from "../dist/design-preview.js";

test("renderPreviewShell embeds the title + markdown/mermaid loaders + poll loop", () => {
  const html = renderPreviewShell("Q3 planning — live design");
  assert.match(html, /Q3 planning — live design/);
  assert.match(html, /markdown-it/);
  assert.match(html, /mermaid/);
  assert.match(html, /fetch\("draft"\)/);
});

test("renderPreviewShell escapes angle brackets in the title", () => {
  const html = renderPreviewShell("<script>evil</script>");
  assert.doesNotMatch(html, /<title><script>evil/);
  assert.match(html, /&lt;script&gt;/);
});

test("startDesignPreviewServer serves the shell and the live draft JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-preview-"));
  const draftPath = path.join(dir, "design-draft.md");
  await fs.writeFile(draftPath, "# Draft\n\n```mermaid\ngraph TD; A-->B\n```\n", "utf8");

  const server = await startDesignPreviewServer({
    draftPath,
    title: "Test",
    port: 0,
  });
  try {
    const root = await fetch(server.url);
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /Test/);

    const draft = await fetch(server.url + "draft");
    assert.equal(draft.status, 200);
    const data = await draft.json();
    assert.match(data.markdown, /graph TD/);
    assert.ok(data.mtime > 0);

    // 404 for anything else.
    const miss = await fetch(server.url + "nope");
    assert.equal(miss.status, 404);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startDesignPreviewServer reports mtime 0 for a missing draft", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-preview-"));
  const server = await startDesignPreviewServer({
    draftPath: path.join(dir, "absent.md"),
    title: "Test",
    port: 0,
  });
  try {
    const data = await (await fetch(server.url + "draft")).json();
    assert.equal(data.mtime, 0);
    assert.equal(data.markdown, "");
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
