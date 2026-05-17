import { test } from "node:test";
import assert from "node:assert/strict";
import { CliRunner, CliError } from "../dist/index.js";

function stubSpawn(script) {
  let i = 0;
  const calls = [];
  const fn = async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (i >= script.length) {
      throw new Error(`unexpected extra spawn: ${command} ${args.join(" ")}`);
    }
    return script[i++];
  };
  fn.calls = calls;
  return fn;
}

test("CliRunner.run prepends defaultArgs and returns stdout/stderr/code", async () => {
  const spawnImpl = stubSpawn([{ stdout: "ok", stderr: "", code: 0 }]);
  const runner = new CliRunner({
    command: "gh",
    defaultArgs: ["--no-color"],
    spawnImpl,
  });
  const result = await runner.run(["repo", "list"]);
  assert.deepEqual(spawnImpl.calls[0].args, ["--no-color", "repo", "list"]);
  assert.equal(result.stdout, "ok");
});

test("CliRunner.run throws CliError on non-zero exit", async () => {
  const spawnImpl = stubSpawn([
    { stdout: "", stderr: "auth required\nrun gh auth login", code: 1 },
  ]);
  const runner = new CliRunner({ command: "gh", spawnImpl });
  await assert.rejects(
    () => runner.run(["repo", "list"]),
    (err) =>
      err instanceof CliError &&
      err.code === 1 &&
      /auth required/.test(err.message)
  );
});

test("CliRunner.json parses stdout", async () => {
  const spawnImpl = stubSpawn([
    { stdout: '{"items":[1,2,3]}', stderr: "", code: 0 },
  ]);
  const runner = new CliRunner({ command: "gh", spawnImpl });
  const data = await runner.json(["repo", "list", "--json", "items"]);
  assert.deepEqual(data, { items: [1, 2, 3] });
});

test("CliRunner.json throws when stdout isn't JSON", async () => {
  const spawnImpl = stubSpawn([{ stdout: "not json", stderr: "", code: 0 }]);
  const runner = new CliRunner({ command: "gh", spawnImpl });
  await assert.rejects(
    () => runner.json(["x"]),
    (err) => /not valid JSON/.test(err.message)
  );
});

test("CliRunner.checkAvailable reports false when binary returns ENOENT (127)", async () => {
  const spawnImpl = stubSpawn([
    { stdout: "", stderr: "command not found: nonexistent-cli", code: 127 },
  ]);
  const runner = new CliRunner({ command: "nonexistent-cli", spawnImpl });
  const result = await runner.checkAvailable();
  assert.equal(result.available, false);
  assert.match(result.reason, /command not found/);
});

test("CliRunner.checkAvailable returns true on zero exit", async () => {
  const spawnImpl = stubSpawn([
    { stdout: "v1.2.3", stderr: "", code: 0 },
  ]);
  const runner = new CliRunner({ command: "fake-cli", spawnImpl });
  const result = await runner.checkAvailable();
  assert.equal(result.available, true);
});
