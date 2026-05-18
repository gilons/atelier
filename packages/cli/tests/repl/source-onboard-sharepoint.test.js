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
    // Wait for the tenant id prompt to render — first occurrence
    // happens before any stale newlines could fire.
    await a.expect("Microsoft Entra tenant id");
    // Give the kernel up to 400ms to flush any stale `\n` byte
    // queued during the raw→canonical mode handoff. If it fires,
    // readline will emit an empty 'line' which would resolve
    // session.ask() with "" and surface "answer can't be empty"
    // in the buffer.
    await new Promise((r) => setTimeout(r, 400));
    a.assertNotPresent(
      "This answer can't be empty",
      "stale newline from the picker leaked into the tenant id prompt — armEmptyLineSwallow regression?"
    );
    // Bonus: send a real value and confirm the next prompt
    // advances (proves the prompt wasn't wedged).
    a.send("00000000-0000-0000-0000-000000000000\r");
    await a.expect("App (client) id");
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
    // Atelier should now jump straight to the hostname text
    // prompt — NOT prompt for the secret.
    const r = await a.expectAny(
      [
        "SharePoint hostname",
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
// Bug 4: hostname prompt is short enough not to wrap. (Used to
// be the linkUrl prompt back when onboarding asked for a doc
// URL; that step is gone now — documents are added via
// `/doc add <url>` after onboarding finishes. The hostname
// prompt is the only text input near the end of the wizard,
// so it inherits the "must not wrap" requirement.)
// ============================================================

test("REPL: hostname prompt is short enough not to wrap (≤80 chars before the colon)", async () => {
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
    const m = await a.expect(/SharePoint hostname[^\n]{0,40}:/, { timeout: 5000 });
    assert.ok(
      m.length <= 80,
      `hostname prompt is ${m.length} chars wide — long prompts trigger readline wrap-storms during paste. Keep it under 80.`
    );
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Bug 5: stale empties leaking into LATER prompts. The
// previous fixes caught the prompt immediately after the auth
// picker; this scenario covers the hostname prompt at the END
// of the wizard, which is two pickers + several text prompts
// further on. Per-prompt stale-empty filtering in
// PromptSession.ask should keep ALL prompts patient.
// ============================================================

test("REPL: hostname prompt is patient (no stale-newline empty deep in the wizard)", async () => {
  const root = await makeWorkspace({
    env: { SHAREPOINT_CLIENT_SECRET: "x" },
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
    await a.expect(/SharePoint hostname.*:/);
    // Same rigorous check as the tenant-id test: wait + assert
    // the empty-error never fired.
    await new Promise((r) => setTimeout(r, 400));
    a.assertNotPresent(
      "This answer can't be empty",
      "stale empty leaked into the hostname prompt — PromptSession.ask filter regressed?"
    );
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Bug 6: sources.yaml validator must accept the
// azureClientCredentials shape. Previously rejected the
// onboarded source with "credentials must be of the form
// {envVar: ...}" because the validator predated the new
// auth path.
// ============================================================

test("REPL: registering an azure-app source writes credentials that load back cleanly", async () => {
  const root = await makeWorkspace({
    env: { SHAREPOINT_CLIENT_SECRET: "x" },
  });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send(
      "/source onboard sharepoint --non-interactive --transport rest " +
        "--answer authType=azure-app " +
        "--answer azureTenantId=00000000-0000-0000-0000-000000000000 " +
        "--answer azureClientId=00000000-0000-0000-0000-000000000000 " +
        "--answer azureClientSecretEnvVar=SHAREPOINT_CLIENT_SECRET " +
        "--answer hostname=contoso.sharepoint.com " +
        "--skip-verify --yes\r"
    );
    // Source registered. Atelier should then read sources.yaml
    // back cleanly the next time we list sources.
    await a.expect(/Source registered|registered|complete/i, {
      timeout: 10000,
    });
    a.assertNotPresent(
      "credentials: if present, must be",
      "validator rejected the azureClientCredentials shape it should accept"
    );
    a.assertNotPresent("✗ Writing sources.yaml");
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// Bug 7: text prompts after a picker rendered the SAME prompt
// text twice on screen — once during paste echo, once via
// readline's auto-prompt after the 'line' event fired. Looked
// like a duplicate to users even though the data was correct.
// Caused by readline's terminal-mode raw-mode state being
// inconsistent after pickers toggled it externally.
// ============================================================

test("REPL: text prompt after a picker doesn't render its prompt text twice", async () => {
  const root = await makeWorkspace({
    env: { SHAREPOINT_CLIENT_SECRET: "x" },
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
    await a.expect("SharePoint hostname");
    a.send("contoso.sharepoint.com\r");
    // Give readline a beat to settle (paste echo, line emit,
    // any auto-prompt re-render).
    await new Promise((r) => setTimeout(r, 400));
    // The prompt label should appear at most once in the
    // accumulated screen buffer. Two occurrences means readline
    // auto-prompted after the line event and produced a
    // duplicate "SharePoint hostname: <value>" pair.
    const occurrences = (a.buffer.match(/SharePoint hostname:/g) ?? []).length;
    assert.ok(
      occurrences <= 1,
      `"SharePoint hostname:" appeared ${occurrences} times — readline is double-rendering the prompt after Enter.`
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
