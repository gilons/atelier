import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchAtelier } from "./harness.js";

/**
 * Tests for `/doc add` with no URL — the manual flow that spawns
 * the user's $EDITOR on a temp file.
 *
 * To keep the test deterministic we set $EDITOR to a small Node
 * script (`fixtures/fake-editor.mjs`) that writes a known payload
 * to the file path it receives and exits 0. From atelier's
 * perspective the fake editor behaves exactly like a real one:
 * `stdio: "inherit"` works, the child exits with status 0, the
 * file on disk has new content.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_EDITOR = path.join(__dirname, "fixtures", "fake-editor.mjs");

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-manual-"));
  const a = await launchAtelier({ cwd: root, args: ["init", "--name", "ManualTest"] });
  await a.waitForExit({ timeout: 10000 });
  return root;
}

async function rm(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test("REPL: /doc add with no URL spawns $EDITOR and ingests the saved content", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({
    cwd: root,
    env: {
      // Tell atelier to use our deterministic fake editor.
      EDITOR: `${process.execPath} ${FAKE_EDITOR}`,
      // Strip VISUAL so it doesn't shadow EDITOR if the test env
      // has one set.
      VISUAL: "",
      ATELIER_FAKE_EDITOR_CONTENT: "# Onboarding PRD\n\nDraft body for the PRD.\n",
    },
  });
  try {
    await a.expect("atelier ❯");
    a.send("/doc add\r");
    await a.expect(/File name/);
    a.send("onboarding-prd\r");
    await a.expect(/Title/);
    a.send("Onboarding PRD\r");
    await a.expect(/Opening .+ on .+\.md/);
    await a.expect(/Added manual doc/, { timeout: 5000 });
    // Follow-up agent instructions still print on the manual path.
    await a.expect("Next step for the assistant");
    await a.expect(/\.atelier\/docs\/manual\/onboarding-prd\/summary\.md/);

    // The doc actually landed on disk with the editor's content.
    const parsed = await fs.readFile(
      path.join(root, ".atelier", "docs", "manual", "onboarding-prd", "parsed.md"),
      "utf8"
    );
    assert.match(parsed, /Draft body for the PRD\./);
  } finally {
    await a.close();
    await rm(root);
  }
});

test("REPL: /doc add with no URL — empty/unchanged editor output saves nothing", async () => {
  // If the user closes the editor without changing the scaffold
  // (or the editor exits before the file was saved — e.g. `code`
  // without `-w`), atelier should NOT create a doc. It should
  // print a friendly nothing-saved message and exit 0.
  const root = await makeWorkspace();
  const a = await launchAtelier({
    cwd: root,
    env: {
      EDITOR: `${process.execPath} ${FAKE_EDITOR}`,
      VISUAL: "",
      // Empty payload — the fake editor truncates the file.
      ATELIER_FAKE_EDITOR_CONTENT: "",
    },
  });
  try {
    await a.expect("atelier ❯");
    a.send("/doc add\r");
    await a.expect(/File name/);
    a.send("empty-test\r");
    await a.expect(/Title/);
    // Wait past PromptSession's 250ms stale-empty filter before
    // sending Enter to accept the default — without the wait the
    // filter eats our Enter as a likely residual newline from the
    // previous prompt.
    await new Promise((r) => setTimeout(r, 300));
    a.enter();
    await a.expect(/Nothing saved/, { timeout: 5000 });
    // And no folder was created in the docs tree.
    const docsDir = path.join(root, ".atelier", "docs", "manual");
    await assert.rejects(() => fs.access(docsDir));
  } finally {
    await a.close();
    await rm(root);
  }
});
