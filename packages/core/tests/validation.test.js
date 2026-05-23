import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSourcesConfig,
  validateReposConfig,
  validateWorkspaceConfig,
} from "../dist/index.js";

test("validateSourcesConfig accepts a minimal valid config", () => {
  const r = validateSourcesConfig({ version: 2, sources: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { version: 2, sources: [] });
});

test("validateSourcesConfig accepts a config with a source (new agent-driven shape)", () => {
  const r = validateSourcesConfig({
    version: 2,
    sources: [
      {
        id: "company-notion",
        name: "Company Notion",
        enabled: true,
        config: { mcp_server: "notion-mcp", workspace: "acme" },
        setupFile: "sources/company-notion/setup.md",
      },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.sources.length, 1);
  assert.equal(r.value.sources[0].name, "Company Notion");
  assert.deepEqual(r.value.sources[0].config, {
    mcp_server: "notion-mcp",
    workspace: "acme",
  });
});

test("validateSourcesConfig rejects sources missing required fields", () => {
  const r = validateSourcesConfig({
    version: 2,
    sources: [{ id: "x" /* no name, no enabled */ }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.sources[0].name"));
  assert.ok(r.issues.some((i) => i.path === "$.sources[0].enabled"));
});

test("validateSourcesConfig rejects duplicate source ids", () => {
  const r = validateSourcesConfig({
    version: 2,
    sources: [
      { id: "dup", name: "A", enabled: true },
      { id: "dup", name: "B", enabled: true },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.message.includes("duplicate")));
});

test("validateSourcesConfig rejects the legacy version 1 schema", () => {
  // V1 is the pre-agent model that had kind/transport/credentials.
  // The validator points the user at a clear error rather than
  // silently dropping fields it no longer knows about.
  const r = validateSourcesConfig({ version: 1, sources: [] });
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
