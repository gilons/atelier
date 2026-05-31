import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, addRepo, detectUiKit } from "../dist/index.js";

async function ws() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-kit-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}
async function write(p, c = "") {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}

test("detectUiKit finds component sources + token sources", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const repo = path.join(umbrella, "platform");
  await write(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/platform.git\n');
  await write(path.join(repo, "package.json"), '{"name":"platform","workspaces":["packages/*"]}');
  // a design-system package with components + tailwind + tokens
  await write(path.join(repo, "packages", "ui", "package.json"), '{"name":"@acme/ui"}');
  await write(path.join(repo, "packages", "ui", "src", "components", "Button.tsx"), "export const Button=()=>null");
  await write(path.join(repo, "packages", "ui", "src", "components", "Card.tsx"), "export const Card=()=>null");
  await write(path.join(repo, "packages", "ui", "src", "components", "index.ts"), ""); // not counted
  await write(path.join(repo, "packages", "ui", "tailwind.config.ts"), "export default {}");
  await write(path.join(repo, "packages", "ui", "tokens.json"), "{}");
  await addRepo(workspaceRoot, { pathInput: "../platform", cwd: workspaceRoot });

  const kit = await detectUiKit(workspaceRoot);

  const comp = kit.components.find((c) => c.dir.endsWith("packages/ui/src/components"));
  assert.ok(comp, "expected the ui component source");
  assert.equal(comp.count, 2);
  assert.deepEqual(comp.samples.sort(), ["Button", "Card"]);
  assert.match(comp.ref, /^kit:platform\/packages\/ui\/src\/components$/);

  const kinds = kit.tokens.filter((t) => t.repo === "platform").map((t) => t.kind).sort();
  assert.ok(kinds.includes("tailwind"));
  assert.ok(kinds.includes("tokens-json"));
});

test("detectUiKit ignores routing sentinels + lowercase files", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const repo = path.join(umbrella, "web");
  await write(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/web.git\n');
  await write(path.join(repo, "package.json"), '{"name":"web","dependencies":{"next":"14"}}');
  await write(path.join(repo, "components", "Header.tsx"), "");
  await write(path.join(repo, "components", "page.tsx"), ""); // sentinel, skip
  await write(path.join(repo, "components", "helpers.ts"), ""); // not a component ext
  await addRepo(workspaceRoot, { pathInput: "../web", cwd: workspaceRoot });

  const kit = await detectUiKit(workspaceRoot);
  const comp = kit.components.find((c) => c.dir === "components");
  assert.ok(comp);
  assert.equal(comp.count, 1);
  assert.deepEqual(comp.samples, ["Header"]);
});

test("detectUiKit is empty for a workspace with no UI kit", async () => {
  const { umbrella, workspaceRoot } = await ws();
  const repo = path.join(umbrella, "api");
  await write(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  await write(path.join(repo, "go.mod"), "module acme/api\n");
  await addRepo(workspaceRoot, { pathInput: "../api", cwd: workspaceRoot });
  const kit = await detectUiKit(workspaceRoot);
  assert.deepEqual(kit.components, []);
  assert.deepEqual(kit.tokens, []);
});
