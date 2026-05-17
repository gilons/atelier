import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSourcesConfig,
  validateReposConfig,
  validateWorkspaceConfig,
} from "../dist/index.js";

test("validateSourcesConfig accepts a minimal valid config", () => {
  const r = validateSourcesConfig({ version: 1, sources: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { version: 1, sources: [] });
});

test("validateSourcesConfig accepts a config with a source", () => {
  const r = validateSourcesConfig({
    version: 1,
    sources: [
      { id: "company-notion", kind: "notion", name: "Company Notion", enabled: true },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.sources.length, 1);
  assert.equal(r.value.sources[0].kind, "notion");
});

test("validateSourcesConfig rejects unknown source kind", () => {
  const r = validateSourcesConfig({
    version: 1,
    sources: [{ id: "x", kind: "tiktok", name: "X", enabled: true }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.sources[0].kind"));
});

test("validateSourcesConfig rejects duplicate source ids", () => {
  const r = validateSourcesConfig({
    version: 1,
    sources: [
      { id: "dup", kind: "notion", name: "A", enabled: true },
      { id: "dup", kind: "confluence", name: "B", enabled: true },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.message.includes("duplicate")));
});

test("validateSourcesConfig rejects wrong version", () => {
  const r = validateSourcesConfig({ version: 2, sources: [] });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.version"));
});

test("validateReposConfig accepts an empty config", () => {
  const r = validateReposConfig({ version: 1, repos: [] });
  assert.equal(r.ok, true);
});

test("validateReposConfig rejects duplicate remotes", () => {
  const r = validateReposConfig({
    version: 1,
    repos: [
      { name: "api", remote: "git@github.com:org/api.git", enabled: true },
      { name: "api-copy", remote: "git@github.com:org/api.git", enabled: true },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.message.includes("duplicate")));
});

test("validateWorkspaceConfig rejects missing required fields", () => {
  const r = validateWorkspaceConfig({ version: 1 });
  assert.equal(r.ok, false);
  const paths = r.issues.map((i) => i.path);
  assert.ok(paths.includes("$.name"));
  assert.ok(paths.includes("$.createdAt"));
  assert.ok(paths.includes("$.atelierVersion"));
});

test("validateWorkspaceConfig accepts a complete config", () => {
  const r = validateWorkspaceConfig({
    version: 1,
    name: "Test",
    createdAt: "2026-05-16T00:00:00Z",
    atelierVersion: "0.0.1",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "Test");
});
