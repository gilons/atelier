import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  BUILTIN_UI_ADAPTERS,
  validateUiAdapter,
  adapterMatches,
  findAdapterForContext,
  deriveAppName,
  loadUiAdapters,
} from "../dist/index.js";

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-uiadapters-"));
  await initWorkspace(root, { name: "WS" });
  return root;
}

/** Build an in-memory DetectContext from plain data. */
function ctx({ deps = [], files = {} } = {}) {
  return {
    deps,
    hasFile: async (rel) => Object.prototype.hasOwnProperty.call(files, rel),
    readFile: async (rel) => (rel in files ? files[rel] : null),
    hasGlob: async (glob) => {
      // Minimal glob: "**/*.dart" → any key ending in ".dart".
      const m = /\*\*\/\*(\.[A-Za-z0-9]+)$/.exec(glob);
      if (m) return Object.keys(files).some((f) => f.endsWith(m[1]));
      return Object.prototype.hasOwnProperty.call(files, glob);
    },
  };
}

// ============================================================
// Built-in adapters
// ============================================================

test("built-in adapters cover the previous JS framework set", () => {
  const ids = BUILTIN_UI_ADAPTERS.map((a) => a.id);
  for (const id of [
    "next", "remix", "gatsby", "nuxt", "sveltekit", "astro", "angular",
    "expo", "react-native", "ionic", "qwik", "solid", "svelte", "vue",
    "preact", "react",
  ]) {
    assert.ok(ids.includes(id), `missing built-in adapter: ${id}`);
  }
  // Every built-in validates against the schema.
  for (const a of BUILTIN_UI_ADAPTERS) {
    const r = validateUiAdapter(a);
    assert.ok(r.ok, `built-in ${a.id} should validate: ${JSON.stringify(r.issues)}`);
  }
});

test("meta-frameworks win over base libraries by priority", async () => {
  // A Next app also depends on react; Next must win.
  const next = await findAdapterForContext(BUILTIN_UI_ADAPTERS, ctx({ deps: ["next", "react"] }));
  assert.equal(next?.id, "next");
  // Expo over react-native.
  const expo = await findAdapterForContext(BUILTIN_UI_ADAPTERS, ctx({ deps: ["expo", "react-native", "react"] }));
  assert.equal(expo?.id, "expo");
  // SvelteKit over svelte.
  const kit = await findAdapterForContext(BUILTIN_UI_ADAPTERS, ctx({ deps: ["@sveltejs/kit", "svelte"] }));
  assert.equal(kit?.id, "sveltekit");
  // Plain react.
  const react = await findAdapterForContext(BUILTIN_UI_ADAPTERS, ctx({ deps: ["react"] }));
  assert.equal(react?.id, "react");
  // Remix via dependency pattern.
  const remix = await findAdapterForContext(BUILTIN_UI_ADAPTERS, ctx({ deps: ["@remix-run/node", "react"] }));
  assert.equal(remix?.id, "remix");
  // No UI deps → no match.
  const none = await findAdapterForContext(BUILTIN_UI_ADAPTERS, ctx({ deps: ["express"] }));
  assert.equal(none, null);
});

// ============================================================
// Detect rules
// ============================================================

test("manifest detect requires the file and (optional) contents match", async () => {
  const adapter = {
    version: 1, id: "flutter", framework: "Flutter", priority: 50,
    detect: { manifest: { file: "pubspec.yaml", contains: "(^|\\n)flutter:" } },
    routes: { strategy: "none" },
  };
  // File present + contains flutter: → match.
  assert.equal(
    await adapterMatches(adapter, ctx({ files: { "pubspec.yaml": "name: app\nflutter:\n  sdk: flutter\n" } })),
    true
  );
  // File present but no flutter: key → a plain Dart package, not Flutter.
  assert.equal(
    await adapterMatches(adapter, ctx({ files: { "pubspec.yaml": "name: dart_lib\n" } })),
    false
  );
  // No file → no match.
  assert.equal(await adapterMatches(adapter, ctx({ files: {} })), false);
});

test("glob detect matches when any file matches", async () => {
  const adapter = {
    version: 1, id: "dartish", framework: "Dartish", priority: 10,
    detect: { glob: "**/*.dart" }, routes: { strategy: "none" },
  };
  assert.equal(await adapterMatches(adapter, ctx({ files: { "lib/main.dart": "void main(){}" } })), true);
  assert.equal(await adapterMatches(adapter, ctx({ files: { "src/index.ts": "" } })), false);
});

test("an empty detect rule never matches", async () => {
  const adapter = { version: 1, id: "x", framework: "X", priority: 1, detect: {}, routes: { strategy: "none" } };
  assert.equal(await adapterMatches(adapter, ctx({ deps: ["react"], files: { "a.dart": "" } })), false);
});

// ============================================================
// Name derivation
// ============================================================

test("deriveAppName reads JSON and YAML-ish manifests", async () => {
  const node = BUILTIN_UI_ADAPTERS.find((a) => a.id === "react");
  assert.equal(
    await deriveAppName(node, ctx({ files: { "package.json": '{"name":"@acme/web"}' } }), "fallback"),
    "@acme/web"
  );
  const flutter = {
    version: 1, id: "flutter", framework: "Flutter", priority: 50,
    name: { file: "pubspec.yaml", key: "name" },
    detect: { manifest: { file: "pubspec.yaml" } }, routes: { strategy: "none" },
  };
  assert.equal(
    await deriveAppName(flutter, ctx({ files: { "pubspec.yaml": "name: my_flutter_app\nversion: 1.0.0\n" } }), "fallback"),
    "my_flutter_app"
  );
  // Missing manifest → fallback.
  assert.equal(await deriveAppName(flutter, ctx({ files: {} }), "fallback"), "fallback");
});

// ============================================================
// Validation
// ============================================================

test("validateUiAdapter rejects bad ids, missing detect signals, bad strategy", () => {
  assert.equal(validateUiAdapter({ id: "Bad ID", framework: "F", detect: { glob: "*" }, routes: { strategy: "none" } }).ok, false);
  assert.equal(validateUiAdapter({ id: "f", framework: "F", detect: {}, routes: { strategy: "none" } }).ok, false);
  assert.equal(validateUiAdapter({ id: "f", framework: "F", detect: { glob: "*" }, routes: { strategy: "made-up" } }).ok, false);
  // file-based without roots is invalid.
  assert.equal(validateUiAdapter({ id: "f", framework: "F", detect: { glob: "*" }, routes: { strategy: "file-based" } }).ok, false);
});

test("validateUiAdapter accepts a complete file-based adapter and defaults version/priority", () => {
  const r = validateUiAdapter({
    id: "flutter-pages",
    framework: "Flutter",
    detect: { manifest: { file: "pubspec.yaml", contains: "flutter:" } },
    name: { file: "pubspec.yaml", key: "name" },
    routes: { strategy: "file-based", roots: ["lib/pages"], include: ["**/*.dart"], indexBasename: "index" },
    components: { extensions: [".dart"], contains: "extends StatelessWidget", pascalCase: true },
  });
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.equal(r.value.version, 1);
  assert.equal(r.value.priority, 10);
  assert.equal(r.value.routes.strategy, "file-based");
});

// ============================================================
// Loading (builtins + user YAML)
// ============================================================

test("loadUiAdapters returns built-ins when no user adapters exist", async () => {
  const root = await workspace();
  try {
    const { adapters, errors } = await loadUiAdapters(root);
    assert.equal(errors.length, 0);
    assert.ok(adapters.length >= BUILTIN_UI_ADAPTERS.length);
    // Sorted by priority descending → Next first.
    assert.equal(adapters[0].id, "next");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a user YAML adapter is loaded and a same-id one overrides the built-in", async () => {
  const root = await workspace();
  try {
    const dir = path.join(root, ".atelier", "ui-adapters");
    await fs.mkdir(dir, { recursive: true });
    // A brand-new BYO framework.
    await fs.writeFile(
      path.join(dir, "flutter.yaml"),
      [
        "version: 1",
        "id: flutter",
        "framework: Flutter",
        "priority: 50",
        "detect:",
        "  manifest:",
        "    file: pubspec.yaml",
        "    contains: 'flutter:'",
        "name:",
        "  file: pubspec.yaml",
        "  key: name",
        "routes:",
        "  strategy: file-based",
        "  roots: [lib/pages, lib/screens]",
        "  include: ['**/*.dart']",
        "components:",
        "  extensions: ['.dart']",
        "  contains: 'extends StatelessWidget|extends StatefulWidget'",
        "",
      ].join("\n"),
      "utf8"
    );
    // Override a built-in (react) by id.
    await fs.writeFile(
      path.join(dir, "react.yaml"),
      ["id: react", "framework: React (custom)", "priority: 999", "detect:", "  dependency: react", "routes:", "  strategy: none", ""].join("\n"),
      "utf8"
    );

    const { adapters, errors } = await loadUiAdapters(root);
    assert.equal(errors.length, 0, JSON.stringify(errors.map((e) => e.error.message)));

    const flutter = adapters.find((a) => a.id === "flutter");
    assert.ok(flutter, "flutter adapter loaded");
    assert.equal(flutter.framework, "Flutter");
    assert.equal(flutter.builtin, false);

    const react = adapters.find((a) => a.id === "react");
    assert.equal(react.framework, "React (custom)");
    assert.equal(react.priority, 999);
    assert.equal(react.builtin, false);
    // Custom react now outranks next.
    assert.equal(adapters[0].id, "react");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a malformed user adapter is skipped and reported, not fatal", async () => {
  const root = await workspace();
  try {
    const dir = path.join(root, ".atelier", "ui-adapters");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "broken.yaml"), "id: broken\nframework: Broken\ndetect: {}\nroutes:\n  strategy: none\n", "utf8");
    const { adapters, errors } = await loadUiAdapters(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error.message, /detect/);
    // Built-ins still present.
    assert.ok(adapters.some((a) => a.id === "next"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
