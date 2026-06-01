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

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function setup(repos = []) {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-spec-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  const init = runCli(["init", "--name", "T"], workspaceRoot);
  assert.equal(init.status, 0, init.stderr);
  for (const { name, remote } of repos) {
    const dir = path.join(umbrella, name);
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = ${remote}\n`,
      "utf8"
    );
    const add = runCli(["repo", "add", `../${name}`], workspaceRoot);
    assert.equal(add.status, 0, add.stderr);
  }
  return { umbrella, workspaceRoot };
}

test("atelier spec --help shows subcommands", () => {
  const result = runCli(["spec", "--help"], process.cwd());
  assert.equal(result.status, 0);
  for (const sub of ["new", "list", "show", "set-status", "remove"]) {
    assert.match(result.stdout, new RegExp(sub));
  }
});

test("atelier spec list --feature shows only that feature's specs (the breakdown)", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["feature", "add", "Billing"], workspaceRoot);
    runCli(["feature", "add", "Search"], workspaceRoot);
    runCli(["spec", "new", "Metering", "--type", "new-feature", "--feature", "billing"], workspaceRoot);
    runCli(["spec", "new", "Invoices", "--type", "new-feature", "--feature", "billing"], workspaceRoot);
    runCli(["spec", "new", "Indexing", "--type", "new-feature", "--feature", "search"], workspaceRoot);

    const all = runCli(["spec", "list"], workspaceRoot);
    assert.match(all.stdout, /metering/i);
    assert.match(all.stdout, /indexing/i);

    const billing = runCli(["spec", "list", "--feature", "billing"], workspaceRoot);
    assert.equal(billing.status, 0, billing.stderr);
    assert.match(billing.stdout, /metering/i);
    assert.match(billing.stdout, /invoices/i);
    assert.doesNotMatch(billing.stdout, /indexing/i);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec deps + list --feature shows the build order", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["feature", "add", "Billing"], workspaceRoot);
    // Three slices (ids must match YYYY-MM-DD-<slug>); "invoices" depends on
    // "metering", "reports" on "invoices".
    const M = "2099-01-01-metering", I = "2099-01-01-invoices", R = "2099-01-01-reports";
    assert.equal(runCli(["spec", "new", "Metering", "--type", "new-feature", "--feature", "billing", "--id", M], workspaceRoot).status, 0);
    assert.equal(runCli(["spec", "new", "Invoices", "--type", "new-feature", "--feature", "billing", "--id", I], workspaceRoot).status, 0);
    assert.equal(runCli(["spec", "new", "Reports", "--type", "new-feature", "--feature", "billing", "--id", R], workspaceRoot).status, 0);

    assert.equal(runCli(["spec", "deps", I, "--on", M], workspaceRoot).status, 0);
    assert.equal(runCli(["spec", "deps", R, "--on", I], workspaceRoot).status, 0);

    const list = runCli(["spec", "list", "--feature", "billing"], workspaceRoot);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /Build order/);
    // Dependencies come before dependents in the printed order.
    const out = list.stdout;
    assert.ok(out.indexOf(M) < out.indexOf(I), "metering before invoices");
    assert.ok(out.indexOf(I) < out.indexOf(R), "invoices before reports");
    assert.match(out, new RegExp(`needs ${M}`));

    // plan.md was scaffolded.
    const dirs = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    assert.ok(dirs.includes(M));
    const plan = await fs.readFile(path.join(workspaceRoot, ".atelier", "issues", M, "plan.md"), "utf8");
    assert.match(plan, /## Approach/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new --from-ticket records the originating ticket in context", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["source", "register", "linear", "--name", "Linear"], workspaceRoot);
    runCli(["ticket", "add", "linear:ENG-7", "--title", "Billing epic"], workspaceRoot);
    const res = runCli(
      ["spec", "new", "Metering", "--type", "new-feature", "--from-ticket", "linear:ENG-7"],
      workspaceRoot
    );
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    const context = await fs.readFile(
      path.join(workspaceRoot, ".atelier", "issues", dirs[0], "context.md"),
      "utf8"
    );
    assert.match(context, /Originating ticket/);
    assert.match(context, /linear:ENG-7/);
    assert.match(context, /Billing epic/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new requires --type", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["spec", "new", "Add stuff"], workspaceRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--type/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new scaffolds an issue folder", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(
      ["spec", "new", "Add CSV export", "--type", "new-feature"],
      workspaceRoot
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Scaffolded spec/);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    assert.equal(dirs.length, 1);
    const dir = path.join(workspaceRoot, ".atelier", "issues", dirs[0]);
    for (const f of ["README.md", "spec.md", "context.md", "prompt.md"]) {
      const stat = await fs.stat(path.join(dir, f));
      assert.ok(stat.isFile(), `${f} missing`);
    }
    const spec = await fs.readFile(path.join(dir, "spec.md"), "utf8");
    assert.match(spec, /## Goal/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new rejects bad --type", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(
      ["spec", "new", "x", "--type", "wishlist"],
      workspaceRoot
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Valid:/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new --feature pulls feature refs", async () => {
  const { umbrella, workspaceRoot } = await setup([
    { name: "api", remote: "git@github.com:org/api.git" },
  ]);
  try {
    runCli(
      ["feature", "add", "Reports", "--code", "api:src/reports/"],
      workspaceRoot
    );
    const result = runCli(
      ["spec", "new", "Add CSV", "--type", "new-feature", "--feature", "reports"],
      workspaceRoot
    );
    assert.equal(result.status, 0, result.stderr);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    const context = await fs.readFile(
      path.join(workspaceRoot, ".atelier", "issues", dirs[0], "context.md"),
      "utf8"
    );
    assert.match(context, /### `reports`/);
    assert.match(context, /api:src\/reports\//);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec new --feature ghost errors", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(
      ["spec", "new", "x", "--type", "bug", "--feature", "ghost"],
      workspaceRoot
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not registered/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec list shows registered specs", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["spec", "new", "Alpha", "--type", "bug"], workspaceRoot);
    runCli(["spec", "new", "Beta", "--type", "ui"], workspaceRoot);
    const result = runCli(["spec", "list"], workspaceRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /alpha/);
    assert.match(result.stdout, /beta/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec set-status changes status", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["spec", "new", "X", "--type", "bug"], workspaceRoot);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    const id = dirs[0];
    const result = runCli(["spec", "set-status", id, "ready"], workspaceRoot);
    assert.equal(result.status, 0, result.stderr);
    const show = runCli(["spec", "show", id], workspaceRoot);
    assert.match(show.stdout, /status:\s+ready/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier spec remove deletes the folder", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["spec", "new", "X", "--type", "bug"], workspaceRoot);
    const dirs = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    const id = dirs[0];
    const result = runCli(["spec", "remove", id], workspaceRoot);
    assert.equal(result.status, 0);
    const after = await fs.readdir(path.join(workspaceRoot, ".atelier", "issues"));
    assert.equal(after.length, 0);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
