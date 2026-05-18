import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretStore, parseEnv, formatEnv } from "../dist/index.js";

async function tmpWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-secret-store-"));
  await fs.mkdir(path.join(root, ".atelier"), { recursive: true });
  return root;
}

// ============================================================
// parseEnv — tolerant, dotenv-compatible
// ============================================================

test("parseEnv handles bare KEY=value pairs", () => {
  const m = parseEnv("FOO=bar\nBAZ=qux");
  assert.equal(m.get("FOO"), "bar");
  assert.equal(m.get("BAZ"), "qux");
});

test("parseEnv ignores blanks and # comments", () => {
  const m = parseEnv("\n# top comment\nFOO=bar\n\n# inline\nBAZ=qux\n");
  assert.equal(m.size, 2);
});

test("parseEnv strips surrounding double quotes", () => {
  const m = parseEnv('FOO="bar with space"\nBAZ="qux"');
  assert.equal(m.get("FOO"), "bar with space");
  assert.equal(m.get("BAZ"), "qux");
});

test("parseEnv strips surrounding single quotes", () => {
  const m = parseEnv("FOO='quoted'");
  assert.equal(m.get("FOO"), "quoted");
});

test("parseEnv preserves = inside values (only the first = splits)", () => {
  const m = parseEnv("EQ_INSIDE=a=b=c");
  assert.equal(m.get("EQ_INSIDE"), "a=b=c");
});

test("parseEnv skips invalid keys (numbers/dashes) without throwing", () => {
  const m = parseEnv("OK=1\n123-BAD=2\nALSO_OK=3");
  assert.equal(m.get("OK"), "1");
  assert.equal(m.get("ALSO_OK"), "3");
  assert.equal(m.size, 2);
});

// ============================================================
// formatEnv — alphabetical, quoted where needed, round-trips
// ============================================================

test("formatEnv sorts keys alphabetically for stable diffs", () => {
  const text = formatEnv(new Map([["Z", "1"], ["A", "2"], ["M", "3"]]));
  const order = text
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.split("=")[0]);
  assert.deepEqual(order, ["A", "M", "Z"]);
});

test("formatEnv quotes values containing whitespace, #, or quotes", () => {
  const text = formatEnv(
    new Map([
      ["SIMPLE", "abc"],
      ["WITH_SPACE", "a b"],
      ["WITH_HASH", "a#b"],
      ["WITH_QUOTE", 'has"quote'],
    ])
  );
  assert.match(text, /SIMPLE=abc$/m);
  assert.match(text, /WITH_SPACE="a b"$/m);
  assert.match(text, /WITH_HASH="a#b"$/m);
  // Embedded double-quote should be backslash-escaped.
  assert.match(text, /WITH_QUOTE="has\\"quote"$/m);
});

test("formatEnv → parseEnv round-trips through all the tricky values", () => {
  const original = new Map([
    ["A", "simple"],
    ["B", "with spaces"],
    ["C", "has=equals"],
    ["D", "has#hash"],
    ["E", "has\"quote"],
    ["F", ""],
  ]);
  const text = formatEnv(original);
  const back = parseEnv(text);
  for (const [k, v] of original) {
    assert.equal(back.get(k), v, `key ${k} should round-trip`);
  }
});

// ============================================================
// SecretStore — read/write/delete + .gitignore + loadIntoProcessEnv
// ============================================================

test("SecretStore.write creates the file and adds .env to .gitignore", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await store.write("SHAREPOINT_TOKEN", "eyJ.xyz");

    // File written with the secret.
    const text = await fs.readFile(path.join(root, ".atelier", ".env"), "utf8");
    assert.match(text, /SHAREPOINT_TOKEN=eyJ\.xyz/);

    // .gitignore has .env in it.
    const gi = await fs.readFile(path.join(root, ".atelier", ".gitignore"), "utf8");
    assert.match(gi, /^\.env$/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.write replaces an existing key in place", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await store.write("FOO", "v1");
    await store.write("FOO", "v2");
    const text = await fs.readFile(path.join(root, ".atelier", ".env"), "utf8");
    // Only one FOO line.
    const matches = text.match(/^FOO=/gm) ?? [];
    assert.equal(matches.length, 1);
    assert.match(text, /FOO=v2/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.writeMany writes multiple keys atomically", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await store.writeMany([
      { name: "TENANT", value: "t-guid" },
      { name: "CLIENT", value: "c-guid" },
      { name: "SECRET", value: "s-val" },
    ]);
    assert.equal(await store.read("TENANT"), "t-guid");
    assert.equal(await store.read("CLIENT"), "c-guid");
    assert.equal(await store.read("SECRET"), "s-val");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.read returns undefined when the file or key is missing", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    assert.equal(await store.read("MISSING"), undefined);
    await store.write("FOO", "bar");
    assert.equal(await store.read("STILL_MISSING"), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.delete removes a key", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await store.write("FOO", "bar");
    await store.delete("FOO");
    assert.equal(await store.read("FOO"), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.write rejects invalid env-var key names", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await assert.rejects(() => store.write("123BAD", "x"), /isn't a valid env var/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.write doesn't duplicate the .gitignore entry on subsequent writes", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await store.write("A", "1");
    await store.write("B", "2");
    await store.write("C", "3");
    const gi = await fs.readFile(path.join(root, ".atelier", ".gitignore"), "utf8");
    const matches = gi.match(/^\.env$/gm) ?? [];
    assert.equal(matches.length, 1, "should only list .env once");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.loadIntoProcessEnv copies keys NOT already set", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    await store.writeMany([
      { name: "ATELIER_TEST_A", value: "from-store" },
      { name: "ATELIER_TEST_B", value: "from-store" },
    ]);
    // Simulate the shell already exporting one of them.
    const env = { ATELIER_TEST_A: "from-shell" };
    const loaded = await store.loadIntoProcessEnv(env);
    // B was empty in env → loaded from store. A was already set → kept.
    assert.equal(env.ATELIER_TEST_A, "from-shell");
    assert.equal(env.ATELIER_TEST_B, "from-store");
    assert.deepEqual(loaded.sort(), ["ATELIER_TEST_B"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore.loadIntoProcessEnv is a no-op when the file is missing", async () => {
  const root = await tmpWorkspace();
  try {
    const store = new SecretStore(root);
    const env = {};
    const loaded = await store.loadIntoProcessEnv(env);
    assert.deepEqual(loaded, []);
    assert.deepEqual(env, {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SecretStore preserves hand-edited values (read after manual edit)", async () => {
  const root = await tmpWorkspace();
  try {
    // Pretend a user hand-edited the file.
    const envPath = path.join(root, ".atelier", ".env");
    await fs.writeFile(envPath, "# my notes\nHAND_EDIT=42\n", "utf8");
    const store = new SecretStore(root);
    assert.equal(await store.read("HAND_EDIT"), "42");
    // Atelier write doesn't lose the hand-edit.
    await store.write("ATELIER_ADDED", "yes");
    assert.equal(await store.read("HAND_EDIT"), "42");
    assert.equal(await store.read("ATELIER_ADDED"), "yes");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
