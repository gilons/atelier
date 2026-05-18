import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchAtelier } from "./harness.js";

/**
 * End-to-end REPL tests for `/source onboard sharepoint`.
 *
 * Each scenario in this file maps to a bug we hit during manual
 * testing — codified so a regression breaks the build instead of
 * the next person's afternoon.
 *
 * The tests need a real PTY (node-pty); they don't run under
 * piped stdin. CI must invoke them via `npm run test:repl`.
 */

async function makeWorkspace(opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-repl-"));
  // Use atelier's own init to ensure the workspace shape matches
  // whatever the current version writes — keeps the fixture from
  // drifting from the live schema.
  const a = await launchAtelier({ cwd: root, args: ["init", "--name", "ReplTest"] });
  await a.waitForExit({ timeout: 10000 });
  if (opts.env) {
    const envPath = path.join(root, ".atelier", ".env");
    const lines = Object.entries(opts.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    await fs.writeFile(envPath, "# Test fixture\n" + lines + "\n", "utf8");
  }
  return root;
}

async function rm(root) {
  await fs.rm(root, { recursive: true, force: true });
}

// ============================================================
// Bug 1: auth-type step renders as a picker, not a text prompt.
// History: the step was authored with a static `choices: [...]`
// array which OnboardingStep doesn't support, so the wizard
// silently fell through to free-text. User got "How should
// Atelier authenticate?" as a text prompt and saw "✗ This
// answer can't be empty" no matter what they typed.
// ============================================================

test("REPL: /source onboard sharepoint renders the auth-type picker", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/source onboard sharepoint\r");
    await a.expect("How would you like to connect");
    a.enter(); // accept transport (rest)
    // The auth-type step must render as a picker with both
    // options visible AND the picker's "navigate" help line.
    await a.expectPicker(["azure-app", "bearer"], { timeout: 7000 });
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Bug 2: drained \n from raw→canonical handoff produced an
// instant "✗ This answer can't be empty" on the first text
// prompt after a picker.
// ============================================================

test("REPL: tenant id prompt is patient after the auth picker (no stale-newline empty)", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/source onboard sharepoint\r");
    await a.expect("How would you like to connect");
    a.enter();
    await a.expect("Authenticate via?");
    a.enter(); // pick azure-app
    // The prompt must wait for the user, NOT pre-resolve with empty.
    const r = await a.expectAny(
      ["Microsoft Entra tenant id", "This answer can't be empty"],
      { timeout: 5000 }
    );
    assert.equal(
      r.index,
      0,
      "tenant id prompt should appear without a pre-consumed empty submission"
    );
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Bug 3: the secret should be skipped when the env var is
// already populated from .atelier/.env. Two real concerns it
// dodges: terminal-echoing the secret in clear text on paste,
// and the drain eating the first character of the pasted value.
// ============================================================

test("REPL: client-secret prompt is skipped when the env var is preloaded from .atelier/.env", async () => {
  const root = await makeWorkspace({
    env: { SHAREPOINT_CLIENT_SECRET: "test-secret-value-not-real" },
  });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/source onboard sharepoint\r");
    await a.expect("How would you like to connect");
    a.enter();
    await a.expect("Authenticate via?");
    a.enter();
    await a.expect("Microsoft Entra tenant id");
    a.send("00000000-0000-0000-0000-000000000000\r");
    await a.expect("App (client) id");
    a.send("00000000-0000-0000-0000-000000000000\r");
    // Atelier should now jump straight to the mode picker —
    // NOT prompt for the secret.
    const r = await a.expectAny(
      [
        "How do you want to add this SharePoint source",
        "Paste the client secret",
      ],
      { timeout: 5000 }
    );
    assert.equal(
      r.index,
      0,
      "secret prompt should be skipped when SHAREPOINT_CLIENT_SECRET is already set"
    );
    // The fixture secret value should NEVER appear on screen —
    // even masked. The whole point is we never prompt for it.
    a.assertNotPresent("test-secret-value-not-real");
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Bug 4: linkUrl prompt used to be 110+ chars with an inline
// example. Pasting a long URL into readline's line-editor
// triggered per-chunk re-renders and the prompt wrapped twice
// over its own tail. The fix shortened it. This test asserts
// the prompt is short enough to not wrap on a typical 100-col
// terminal.
// ============================================================

test("REPL: link-mode URL prompt is short enough not to wrap (≤80 chars before the colon)", async () => {
  const root = await makeWorkspace({
    env: { SHAREPOINT_CLIENT_SECRET: "x" },
  });
  const a = await launchAtelier({ cwd: root, cols: 100 });
  try {
    await a.expect("atelier ❯");
    a.send("/source onboard sharepoint\r");
    await a.expect("How would you like to connect");
    a.enter();
    await a.expect("Authenticate via?");
    a.enter();
    await a.expect("Microsoft Entra tenant id");
    a.send("00000000-0000-0000-0000-000000000000\r");
    await a.expect("App (client) id");
    a.send("00000000-0000-0000-0000-000000000000\r");
    await a.expect("How do you want to add this SharePoint");
    a.enter(); // pick first (link)
    // The link mode prompt should appear once, on one line. We
    // can't perfectly assert "no wrap" but we can require the
    // prompt text be short.
    const m = await a.expect(/SharePoint URL[^\n]{0,40}:/, { timeout: 5000 });
    assert.ok(
      m.length <= 80,
      `linkUrl prompt is ${m.length} chars wide — long prompts trigger readline wrap-storms during paste. Keep it under 80.`
    );
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Sanity: bare REPL boots, displays the banner, accepts /quit.
// Cheap regression catcher for whole-flow brokenness — e.g. an
// import error or a banner crash would surface here before any
// of the more specific scenarios run.
// ============================================================

test("REPL: bare boot shows the prompt and exits cleanly on /quit", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/quit\r");
    const exit = await a.waitForExit({ timeout: 5000 });
    assert.equal(exit.code, 0, "atelier should exit cleanly on /quit");
  } finally {
    await a.close();
    await rm(root);
  }
});
