import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchAtelier } from "./harness.js";

/**
 * Regression test for the "paste a long URL into the REPL and watch
 * it draw the prompt+URL 50+ times" bug.
 *
 * Root cause: `InputReader` refreshed (clear + render) after every
 * decoded key. Pastes arrive as a single chunk that decodes to N
 * keys — so we did N refreshes for an N-char paste. Each render
 * wrote `prompt + buffer`; once the buffer exceeded the terminal
 * width, line wrap left fragments above the cursor that the next
 * `\r\x1b[0J` clear couldn't reach. Result: the user saw the same
 * prompt+URL stacked on themselves like an accordion.
 *
 * Fix: detect multi-key chunks in `handle()`, apply all edits
 * silently, render exactly once at the end of the chunk.
 *
 * Test strategy: send a realistic-length URL (the actual user-
 * reported one is ~300 chars including escape sequences) as a
 * single PTY write — the way a terminal delivers a paste — and
 * count how many times the prompt label appears on screen.
 * Pre-fix the count was hundreds; post-fix it should be exactly 1.
 */

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-paste-"));
  const a = await launchAtelier({ cwd: root, args: ["init", "--name", "PasteTest"] });
  await a.waitForExit({ timeout: 10000 });
  return root;
}

async function rm(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test("REPL: pasting a long URL doesn't multiply the prompt across the screen", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    // Snapshot prompt count BEFORE the paste — the welcome banner
    // and the initial draw together produce a baseline.
    const beforeCount = (a.buffer.match(/atelier ❯/g) ?? []).length;

    // A real-world SharePoint URL with escape sequences, parens,
    // ampersands, and percent-encoded bytes — the user-reported
    // shape. ~280 chars, long enough to wrap on the test PTY's
    // 100-col width.
    const url =
      "/doc add https://dinolabgmbh-my.sharepoint.com/:w:/r/personal/stephan_dino-lab_io/" +
      "_layouts/15/Doc.aspx?sourcedoc=%7BAAAA89C6-5728-42FE-AE9A-1C6F5F3EC960%7D" +
      "&file=Cloud%20Services%20Vertrag%20(SaaS)%202.0.docx" +
      "&action=default&mobileredirect=true&wdOrigin=OUTLOOK-METAOS.FILEBROWSER";
    // Note: no trailing \r — we don't want to actually submit, just
    // verify the visual state of the prompt line after the paste lands.
    a.send(url);

    // Give the renderer a moment to apply the (single, batched) refresh.
    await new Promise((r) => setTimeout(r, 400));

    const afterCount = (a.buffer.match(/atelier ❯/g) ?? []).length;
    // The paste should add at most one new prompt-render (the
    // single batched refresh) on top of the baseline. Anything
    // beyond `baseline + 1` means we regressed back to per-key
    // redrawing.
    assert.ok(
      afterCount <= beforeCount + 1,
      `prompt label was rendered ${afterCount - beforeCount} times after a single paste — expected at most 1. ` +
        `Looks like InputReader is re-rendering per keystroke instead of batching paste chunks.`
    );

    // Sanity: the URL itself should be on screen exactly once
    // (the final batched render). Pre-fix it would appear N times.
    const urlOccurrences = (
      a.buffer.match(/\/doc add https:\/\/dinolabgmbh-my\.sharepoint\.com/g) ?? []
    ).length;
    assert.equal(
      urlOccurrences,
      1,
      `URL appears ${urlOccurrences} times — paste-burst rendering regressed.`
    );
  } finally {
    await a.close();
    await rm(root);
  }
});
