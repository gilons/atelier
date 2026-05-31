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

async function write(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

async function setup() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-design-cli-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  assert.equal(runCli(["init", "--name", "Test"], workspaceRoot).status, 0);
  await write(path.join(umbrella, "api", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  await write(path.join(umbrella, "api", "go.mod"), "module acme/api\n");
  assert.equal(runCli(["repo", "add", "../api"], workspaceRoot).status, 0);
  assert.equal(runCli(["feature", "add", "Checkout"], workspaceRoot).status, 0);
  return { umbrella, workspaceRoot };
}

test("atelier design palette lists subsystems + features with refs", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "palette"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Subsystems/);
    assert.match(result.stdout, /repo:api/);
    assert.match(result.stdout, /Features/);
    assert.match(result.stdout, /feature:checkout/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design palette --json is parseable", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "palette", "--json"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const palette = JSON.parse(result.stdout);
    assert.ok(Array.isArray(palette.subsystems));
    assert.ok(palette.subsystems.some((s) => s.ref === "repo:api"));
    assert.ok(palette.features.some((f) => f.ref === "feature:checkout"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design live show reports the default gate before tuning", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "live", "show"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /stability gate:\s*2 chunk/);
    assert.match(result.stdout, /default/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design live set tunes the gate + model and persists", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const set = runCli(
      ["design", "live", "set", "--stability-chunks", "3", "--model", "base"],
      workspaceRoot
    );
    assert.equal(set.status, 0, `stderr: ${set.stderr}\nstdout: ${set.stdout}`);
    const show = runCli(["design", "live", "show"], workspaceRoot);
    assert.match(show.stdout, /stability gate:\s*3 chunk/);
    assert.match(show.stdout, /live STT model:\s*base/);
    const cfg = await fs.readFile(path.join(workspaceRoot, ".atelier", "design.yaml"), "utf8");
    assert.match(cfg, /stabilityChunks: 3/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("atelier design live set rejects a bad gate", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "live", "set", "--stability-chunks", "0"], workspaceRoot);
    assert.equal(result.status, 2);
    assert.match(result.stdout + result.stderr, /positive integer/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design apps detects the workspace's frontend apps", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    await write(path.join(umbrella, "web", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
    await write(path.join(umbrella, "web", "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
    assert.equal(runCli(["repo", "add", "../web"], workspaceRoot).status, 0);

    const result = runCli(["design", "apps"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /app:web/);
    assert.match(result.stdout, /Next\.js/);

    const json = JSON.parse(runCli(["design", "apps", "--json"], workspaceRoot).stdout);
    assert.ok(json.apps.some((a) => a.ref === "app:web" && a.framework === "Next.js"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design nav extracts an app's routes", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    await write(path.join(umbrella, "web", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
    await write(path.join(umbrella, "web", "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
    await write(path.join(umbrella, "web", "app", "page.tsx"), "");
    await write(path.join(umbrella, "web", "app", "blog", "[slug]", "page.tsx"), "");
    assert.equal(runCli(["repo", "add", "../web"], workspaceRoot).status, 0);

    const result = runCli(["design", "nav"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /app:web/);
    assert.match(result.stdout, /\/blog\/\[slug\]/);
    assert.match(result.stdout, /dynamic/);

    const json = JSON.parse(runCli(["design", "nav", "app:web", "--json"], workspaceRoot).stdout);
    const routes = json.apps[0].routes.map((r) => r.route).sort();
    assert.deepEqual(routes, ["/", "/blog/[slug]"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design connections infers shared-code edges between apps", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const mono = path.join(umbrella, "platform");
    await write(path.join(mono, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
    await write(path.join(mono, "package.json"), '{"name":"platform","workspaces":["apps/*","packages/*"]}');
    await write(path.join(mono, "packages", "ui", "package.json"), '{"name":"@acme/ui"}');
    await write(path.join(mono, "apps", "web", "package.json"), '{"name":"@acme/web","dependencies":{"next":"14","@acme/ui":"workspace:*"}}');
    await write(path.join(mono, "apps", "admin", "package.json"), '{"name":"@acme/admin","dependencies":{"react":"18","@acme/ui":"workspace:*"}}');
    assert.equal(runCli(["repo", "add", "../platform"], workspaceRoot).status, 0);

    const result = runCli(["design", "connections"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /@acme\/ui/);
    assert.match(result.stdout, /design system/);

    const json = JSON.parse(runCli(["design", "connections", "--json"], workspaceRoot).stdout);
    const edge = json.edges.find((e) => e.package === "@acme/ui");
    assert.ok(edge && edge.designSystem === true);
    assert.equal(edge.apps.length, 2);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design kit detects component sources + design tokens", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const repo = path.join(umbrella, "platform");
    await write(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
    await write(path.join(repo, "package.json"), '{"name":"@acme/ui"}');
    await write(path.join(repo, "src", "components", "Button.tsx"), "export const Button=()=>null");
    await write(path.join(repo, "src", "components", "Card.tsx"), "export const Card=()=>null");
    await write(path.join(repo, "tailwind.config.ts"), "export default {}");
    assert.equal(runCli(["repo", "add", "../platform"], workspaceRoot).status, 0);

    const result = runCli(["design", "kit"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /Component sources/);
    assert.match(result.stdout, /Button/);
    assert.match(result.stdout, /Design tokens/);
    assert.match(result.stdout, /tailwind/);

    const json = JSON.parse(runCli(["design", "kit", "--json"], workspaceRoot).stdout);
    assert.ok(json.components.some((c) => c.dir.endsWith("src/components") && c.count === 2));
    assert.ok(json.tokens.some((t) => t.kind === "tailwind"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design screens lists each app's screens grouped by section", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    await write(path.join(umbrella, "web", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
    await write(path.join(umbrella, "web", "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
    await write(path.join(umbrella, "web", "app", "page.tsx"), "");
    await write(path.join(umbrella, "web", "app", "blog", "[slug]", "page.tsx"), "");
    assert.equal(runCli(["repo", "add", "../web"], workspaceRoot).status, 0);

    const result = runCli(["design", "screens"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /app:web/);
    assert.match(result.stdout, /Home/);
    assert.match(result.stdout, /blog \/ \[slug\]/);

    const json = JSON.parse(runCli(["design", "screens", "--json"], workspaceRoot).stdout);
    assert.equal(json.apps[0].total, 2);
    assert.ok(json.apps[0].sections.some((s) => s.section === "blog"));
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design discipline list shows built-in disciplines", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const result = runCli(["design", "discipline", "list"], workspaceRoot);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /system-design/);
    assert.match(result.stdout, /ui-design/);
    assert.match(result.stdout, /built-in/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("tools are per-discipline (ui-design vs system-design)", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    runCli(["design", "tool", "set", "excalidraw"], workspaceRoot); // system-design (default)
    runCli(["design", "tool", "set", "figma", "--discipline", "ui-design"], workspaceRoot);
    const sys = runCli(["design", "tool", "show"], workspaceRoot);
    assert.match(sys.stdout, /excalidraw/);
    const ui = runCli(["design", "tool", "show", "--discipline", "ui-design"], workspaceRoot);
    assert.match(ui.stdout, /figma/);
    assert.match(ui.stdout, /ui-design/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design discipline add scaffolds a custom discipline + its agent", async () => {
  const { umbrella, workspaceRoot } = await setup();
  try {
    const add = runCli(
      ["design", "discipline", "add", "service-design", "--name", "Service Design", "--designs", "service blueprints"],
      workspaceRoot
    );
    assert.equal(add.status, 0, `stderr: ${add.stderr}\nstdout: ${add.stdout}`);
    assert.match(add.stdout, /Added design discipline service-design/);
    // The agent was generated from the shared template.
    const list = runCli(["agent", "list"], workspaceRoot);
    assert.match(list.stdout, /service-design/);
    // And it carries the engine (install + check a unit).
    runCli(["agent", "install", "service-design"], workspaceRoot);
    const sub = await fs.readFile(
      path.join(workspaceRoot, ".claude", "agents", "atelier-service-design.md"),
      "utf8"
    );
    assert.match(sub, /Live companion mode/);
    assert.match(sub, /service blueprints/);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
