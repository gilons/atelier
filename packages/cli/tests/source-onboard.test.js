import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, NO_COLOR: "1" },
  });
}

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-onboard-cli-"));
  const init = runCli(["init", "--name", "Test"], root);
  assert.equal(init.status, 0, init.stderr);
  return root;
}

test("atelier source onboard --list-kinds prints registered adapters", () => {
  const result = runCli(["source", "onboard", "--list-kinds"], process.cwd());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /notion/);
  assert.match(result.stdout, /Notion/);
});

test("atelier source onboard rejects unknown kind", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      ["source", "onboard", "unicorn", "--non-interactive", "--skip-verify"],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown source kind/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard notion non-interactive writes sources.yaml", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "source",
        "onboard",
        "notion",
        "--non-interactive",
        "--transport",
        "rest",
        "--skip-verify",
        "--answer",
        "id=company-notion",
        "--answer",
        "name=Company Notion",
        "--answer",
        "envVar=NOTION_TOKEN",
        "--answer",
        "token=secret_fake_token",
      ],
      root
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /About to register/);
    assert.match(result.stdout, /Source registered/);
    assert.match(result.stdout, /Next steps/);
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.match(yaml, /id: company-notion/);
    assert.match(yaml, /kind: notion/);
    assert.match(yaml, /transport: rest/);
    assert.match(yaml, /envVar: NOTION_TOKEN/);
    // Sensitive value never lands on disk.
    assert.doesNotMatch(yaml, /secret_fake_token/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard --dry-run does not write", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "source",
        "onboard",
        "notion",
        "--non-interactive",
        "--transport",
        "rest",
        "--skip-verify",
        "--dry-run",
        "--answer",
        "id=company-notion",
        "--answer",
        "name=Company Notion",
        "--answer",
        "envVar=NOTION_TOKEN",
        "--answer",
        "token=secret_fake_token",
      ],
      root
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--dry-run: skipping writes/);
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.doesNotMatch(yaml, /company-notion/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard rejects invalid --transport for the kind", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "source",
        "onboard",
        "notion",
        "--non-interactive",
        "--transport",
        "external",
        "--skip-verify",
      ],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not available/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard surfaces missing --answer values in non-interactive mode", async () => {
  const root = await workspace();
  try {
    // No --answer for "token" — should fail rather than silently use empty.
    const result = runCli(
      [
        "source",
        "onboard",
        "notion",
        "--non-interactive",
        "--transport",
        "rest",
        "--skip-verify",
        "--answer",
        "envVar=NOTION_TOKEN",
      ],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no value for "token"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard validates --answer format against step regex", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      [
        "source",
        "onboard",
        "notion",
        "--non-interactive",
        "--transport",
        "rest",
        "--skip-verify",
        "--answer",
        "id=BadID With Spaces",
        "--answer",
        "name=X",
        "--answer",
        "envVar=NOTION_TOKEN",
        "--answer",
        "token=secret_x",
      ],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /doesn't match the expected format/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard --answer is rejected if missing the `=`", async () => {
  const root = await workspace();
  try {
    const result = runCli(
      ["source", "onboard", "notion", "--non-interactive", "--answer", "no-equals-sign"],
      root
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /key=value/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source --help mentions onboard", () => {
  const result = runCli(["source", "--help"], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /onboard/);
});

test("atelier source onboard drives all prompts from piped stdin", async () => {
  const root = await workspace();
  try {
    // Answers in order: transport pick → id → name → envVar → token →
    // scope.titleContains → confirm.
    const scripted = ["1", "docs-source", "Docs", "DOCS_TOKEN", "secret_x", "", "y"].join("\n") + "\n";
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "source", "onboard", "notion", "--skip-verify"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        input: scripted,
      }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /About to register/);
    assert.match(result.stdout, /Source registered/);
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.match(yaml, /id: docs-source/);
    assert.match(yaml, /transport: rest/);
    assert.match(yaml, /envVar: DOCS_TOKEN/);
    // Secret never lands on disk.
    assert.doesNotMatch(yaml, /secret_x/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("atelier source onboard aborts cleanly when user answers 'n' to confirm", async () => {
  const root = await workspace();
  try {
    const scripted = ["1", "docs-source", "Docs", "DOCS_TOKEN", "secret_x", "", "n"].join("\n") + "\n";
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "source", "onboard", "notion", "--skip-verify"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        input: scripted,
      }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Aborted/);
    // No source landed.
    const yaml = await fs.readFile(path.join(root, ".planning", "sources.yaml"), "utf8");
    assert.doesNotMatch(yaml, /docs-source/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
