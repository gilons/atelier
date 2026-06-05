import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSourcesConfig,
  validateReposConfig,
  validateProjectsConfig,
  validateWorkspaceConfig,
} from "../dist/index.js";

test("validateSourcesConfig accepts a minimal valid config", () => {
  const r = validateSourcesConfig({ version: 3, sources: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { version: 3, sources: [] });
});

test("validateSourcesConfig accepts a config with a source (connector shape)", () => {
  const r = validateSourcesConfig({
    version: 3,
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

test("validateSourcesConfig ignores a legacy category field (sources are connectors)", () => {
  const r = validateSourcesConfig({
    version: 3,
    sources: [
      { id: "kb", name: "Knowledge", category: "docs", enabled: true },
      { id: "figma", name: "Design", category: "tickets", enabled: true },
    ],
  });
  // category is no longer part of the model — it's accepted (so old
  // files load) but stripped from the validated value.
  assert.equal(r.ok, true);
  assert.equal(r.value.sources[0].category, undefined);
  assert.equal(r.value.sources[1].category, undefined);
});

test("validateSourcesConfig rejects sources missing required fields", () => {
  const r = validateSourcesConfig({
    version: 3,
    sources: [{ id: "x" /* no name, no enabled */ }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.sources[0].name"));
  assert.ok(r.issues.some((i) => i.path === "$.sources[0].enabled"));
});

test("validateSourcesConfig rejects duplicate source ids", () => {
  const r = validateSourcesConfig({
    version: 3,
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

test("validateProjectsConfig accepts an empty config", () => {
  const r = validateProjectsConfig({ version: 1, projects: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { version: 1, projects: [] });
});

test("validateProjectsConfig accepts a valid project", () => {
  const r = validateProjectsConfig({
    version: 1,
    projects: [
      {
        id: "acme",
        name: "Acme Corp",
        client: "Acme Inc",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.projects[0].client, "Acme Inc");
});

test("validateProjectsConfig rejects reserved and malformed ids", () => {
  const r = validateProjectsConfig({
    version: 1,
    projects: [
      { id: "all", name: "X", createdAt: "t", updatedAt: "t" },
      { id: "Bad Id", name: "Y", createdAt: "t", updatedAt: "t" },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.message.includes("reserved")));
  assert.ok(r.issues.some((i) => i.path === "$.projects[1].id"));
});

test("validateProjectsConfig rejects duplicate ids", () => {
  const r = validateProjectsConfig({
    version: 1,
    projects: [
      { id: "dup", name: "A", createdAt: "t", updatedAt: "t" },
      { id: "dup", name: "B", createdAt: "t", updatedAt: "t" },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.message.includes("duplicate")));
});

test("validateProjectsConfig rejects a missing projects array", () => {
  const r = validateProjectsConfig({ version: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.projects"));
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
