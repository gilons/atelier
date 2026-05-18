import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { launchAtelier } from "./harness.js";

/**
 * End-to-end REPL tests for `/doc add <url>`.
 *
 * The new flow:
 *
 *   1. User runs `/doc add <url>`.
 *   2. Atelier classifies the URL, finds the matching source by
 *      kind (+ hostname for SharePoint, + scope.repos for GH).
 *   3. If 2+ candidates → interactive picker; 1 → auto-pick.
 *   4. Pin is appended to source.scope, a one-source sync is
 *      kicked off, and the doc lands in the doc map.
 *
 * We test the SharePoint + GitHub paths separately. SharePoint
 * goes through Graph at sync time so we can't fully exercise it
 * here without network; we cover the pin-append + "no matching
 * source" error path. GitHub Discussions doesn't actually mint
 * a `gh` call until sync, so the pin-append path is also the
 * meaningful assertion.
 */

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-docadd-repl-"));
  const a = await launchAtelier({ cwd: root, args: ["init", "--name", "ReplDocAdd"] });
  await a.waitForExit({ timeout: 10000 });
  return root;
}

/** Pre-register a source by writing sources.yaml directly. Avoids
 *  having to script through the onboarding wizard for tests that
 *  are focused on `/doc add` semantics. */
async function writeSources(root, sources) {
  const file = path.join(root, ".atelier", "sources.yaml");
  const body =
    "version: 1\nsources:\n" +
    sources
      .map((s) => {
        const lines = [
          `  - id: ${s.id}`,
          `    kind: ${s.kind}`,
          `    name: ${s.name}`,
          `    enabled: ${s.enabled !== false}`,
        ];
        if (s.transport) lines.push(`    transport: ${s.transport}`);
        if (s.credentials) {
          lines.push(`    credentials:`);
          for (const [k, v] of Object.entries(s.credentials)) {
            lines.push(`      ${k}: ${v}`);
          }
        }
        if (s.scope) {
          lines.push(`    scope:`);
          // Naive YAML inliner — fine because we only write
          // primitives and string arrays from tests.
          for (const [k, v] of Object.entries(s.scope)) {
            if (Array.isArray(v)) {
              lines.push(`      ${k}:${v.length === 0 ? " []" : ""}`);
              for (const item of v) {
                lines.push(`        - ${typeof item === "string" ? item : JSON.stringify(item)}`);
              }
            } else {
              lines.push(`      ${k}: ${v}`);
            }
          }
        }
        return lines.join("\n");
      })
      .join("\n") +
    "\n";
  await fs.writeFile(file, body, "utf8");
}

async function readSources(root) {
  const file = path.join(root, ".atelier", "sources.yaml");
  return parseYaml(await fs.readFile(file, "utf8"));
}

async function rm(root) {
  await fs.rm(root, { recursive: true, force: true });
}

// ============================================================
// /doc add <url> — unrecognised URL
// ============================================================

test("REPL: /doc add <random URL> shows a clear classification error", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/doc add https://example.com/whatever\r");
    await a.expect(/Couldn't classify/, { timeout: 5000 });
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /doc add <SharePoint URL> — no matching source registered
// ============================================================

test("REPL: /doc add <sharepoint URL> with no SharePoint source tells the user to onboard first", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send(
      "/doc add https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx\r"
    );
    await a.expect(/No registered sharepoint source/, { timeout: 5000 });
    await a.expect(/source onboard sharepoint/);
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /doc add <SharePoint URL> — auto-picks the only matching source
// and appends a file pin to scope.pins. We skip the sync step
// (--no-sync) so we don't need a live Graph token.
// ============================================================

test("REPL: /doc add prints follow-up instructions for the assistant (summary.md request)", async () => {
  // After every successful /doc add in agent mode, the CLI emits
  // a structured "Next step for the assistant" block instructing
  // the agent reading the terminal to produce summary.md alongside
  // the doc's parsed.md. The block must be present, include the
  // exact summary.md path, and call out the available inputs.
  //
  // We opt into agent mode via ATELIER_AGENT=1 — without that the
  // follow-up block is suppressed entirely (humans running the
  // CLI interactively don't want the noise).
  const root = await makeWorkspace();
  await writeSources(root, [
    {
      id: "gh",
      kind: "github-discussions",
      name: "GH",
      transport: "cli",
      scope: { repos: [] },
    },
  ]);
  const a = await launchAtelier({ cwd: root, env: { ATELIER_AGENT: "1" } });
  try {
    await a.expect("atelier ❯");
    a.send("/doc add https://github.com/my-org/my-repo/discussions/42 --no-sync\r");
    await a.expect(/Added to source/, { timeout: 5000 });
    await a.expect("Next step for the assistant");
    await a.expect(
      /\.atelier\/docs\/gh\/my-org%2Fmy-repo%2342\/summary\.md/
    );
    await a.expect(/1–\d+ sentence overview|1-\d+ sentence overview/);
    await a.expect(/Keywords/);
    await a.expect(/Anchors/);
    // Step 2: the agent should also suggest mapping the doc to a
    // feature or spec. The exact doc ref to use shows up in the
    // suggested `/feature add` / `/spec new` lines.
    await a.expect(/\/feature add.*--doc gh:my-org\/my-repo#42/);
    await a.expect(/\/spec new.*--doc gh:my-org\/my-repo#42/);
  } finally {
    await a.close();
    await rm(root);
  }
});

test("REPL: /doc add <sharepoint file URL> --no-sync appends a file pin to the matching source", async () => {
  const root = await makeWorkspace();
  await writeSources(root, [
    {
      id: "sp",
      kind: "sharepoint",
      name: "SP",
      transport: "rest",
      credentials: { envVar: "TOK" },
      scope: { hostname: "contoso.sharepoint.com", pins: [] },
    },
  ]);
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send(
      "/doc add https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3/spec.docx --no-sync\r"
    );
    await a.expect(/Added to source/, { timeout: 5000 });

    // sources.yaml should now contain a file pin pointing at /Q3/spec.docx
    const cfg = await readSources(root);
    const pins = cfg.sources[0].scope.pins;
    assert.equal(pins.length, 1);
    assert.equal(pins[0].kind, "file");
    assert.equal(pins[0].itemPath, "/Q3/spec.docx");
    assert.equal(pins[0].sitePath, "/sites/Marketing");
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /doc add <discussion URL> — no matching source registered
// ============================================================

test("REPL: /doc add <discussion URL> with no GH source tells the user to onboard first", async () => {
  const root = await makeWorkspace();
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/doc add https://github.com/my-org/my-repo/discussions/42\r");
    await a.expect(/No registered github-discussions source/, { timeout: 5000 });
    await a.expect(/source onboard github-discussions/);
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /doc add <discussion URL> auto-pins into a freshly-onboarded
// (empty-scope) GH source — proves that you don't need to
// pre-configure repos at onboarding time.
// ============================================================

test("REPL: /doc add <discussion URL> --no-sync pins into a credentials-only GH source", async () => {
  const root = await makeWorkspace();
  await writeSources(root, [
    {
      id: "gh",
      kind: "github-discussions",
      name: "GH",
      transport: "cli",
      scope: { repos: [] },
    },
  ]);
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/doc add https://github.com/my-org/my-repo/discussions/42 --no-sync\r");
    await a.expect(/Added to source/, { timeout: 5000 });
    const cfg = await readSources(root);
    const scope = cfg.sources[0].scope;
    // Both fields populated: scope.repos picks up the owner/name,
    // scope.discussionIds pins the specific thread.
    assert.deepEqual(scope.repos, ["my-org/my-repo"]);
    assert.deepEqual(scope.discussionIds, ["my-org/my-repo#42"]);
  } finally {
    await a.close();
    await rm(root);
  }
});

// ============================================================
// /doc add <SharePoint URL> with two matching SP sources →
// interactive picker. The user picks one and the pin lands
// there only.
// ============================================================

test("REPL: /doc add picks between two same-hostname sources via picker", async () => {
  const root = await makeWorkspace();
  await writeSources(root, [
    {
      id: "sp-alpha",
      kind: "sharepoint",
      name: "Alpha",
      transport: "rest",
      credentials: { envVar: "TOK_A" },
      scope: { hostname: "contoso.sharepoint.com", pins: [] },
    },
    {
      id: "sp-beta",
      kind: "sharepoint",
      name: "Beta",
      transport: "rest",
      credentials: { envVar: "TOK_B" },
      scope: { hostname: "contoso.sharepoint.com", pins: [] },
    },
  ]);
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send(
      "/doc add https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx --no-sync\r"
    );
    await a.expectPicker(["sp-alpha", "sp-beta"], { timeout: 5000 });
    a.arrowDown();
    a.enter(); // pick sp-beta
    await a.expect(/Added to source.*sp-beta/, { timeout: 5000 });
    const cfg = await readSources(root);
    const alpha = cfg.sources.find((s) => s.id === "sp-alpha");
    const beta = cfg.sources.find((s) => s.id === "sp-beta");
    assert.equal(alpha.scope.pins.length, 0);
    assert.equal(beta.scope.pins.length, 1);
  } finally {
    await a.close();
    await rm(root);
  }
});
