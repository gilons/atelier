import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addProject,
  registerSource,
  loadSourcesConfig,
  addRepo,
  loadReposConfig,
  addFeature,
  loadFeature,
  serializeFeatureFile,
  parseFeatureFile,
  addDesign,
  loadDesign,
  createSpec,
  loadSpec,
  addDoc,
  addTicket,
  addStakeholder,
  loadStakeholder,
  updateFeature,
  setSourceProject,
  buildWorkspaceMap,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-projfacet-"));
  const root = path.join(umbrella, "planning");
  await fs.mkdir(root);
  await initWorkspace(root, { name: "Test" });
  await addProject(root, { name: "Acme", id: "acme" });
  await addProject(root, { name: "Beta", id: "beta" });
  return { umbrella, root };
}

async function makeRepo(umbrella, name, remote) {
  const dir = path.join(umbrella, name);
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`, "utf8");
  return dir;
}

test("source carries project and it round-trips", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "notion", name: "Notion", project: "acme" });
    await registerSource(root, { id: "shared", name: "Shared" }); // global
    const cfg = await loadSourcesConfig(root);
    assert.equal(cfg.sources.find((s) => s.id === "notion").project, "acme");
    assert.equal(cfg.sources.find((s) => s.id === "shared").project, undefined);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("repo carries project and it round-trips", async () => {
  const { umbrella, root } = await workspace();
  try {
    await makeRepo(umbrella, "api", "git@github.com:acme/api.git");
    await addRepo(root, { pathInput: "../api", cwd: root, project: "acme" });
    const cfg = await loadReposConfig(root);
    assert.equal(cfg.repos[0].project, "acme");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("feature project round-trips through front matter", async () => {
  const { umbrella, root } = await workspace();
  try {
    const f = await addFeature(root, { name: "Billing", project: "acme", skipReferenceValidation: true });
    assert.equal(f.project, "acme");
    const reloaded = await loadFeature(root, f.id);
    assert.equal(reloaded.project, "acme");
    // serialized front matter contains the project key
    const text = serializeFeatureFile(reloaded);
    assert.match(text, /^project: acme$/m);
    // parse round-trips
    assert.equal(parseFeatureFile(text, "x.md").project, "acme");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("global feature has no project key in front matter", async () => {
  const { umbrella, root } = await workspace();
  try {
    const f = await addFeature(root, { name: "Shared Thing", skipReferenceValidation: true });
    assert.equal(f.project, undefined);
    const text = serializeFeatureFile(await loadFeature(root, f.id));
    assert.doesNotMatch(text, /^project:/m);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("design project round-trips", async () => {
  const { umbrella, root } = await workspace();
  try {
    await addDesign(root, { discipline: "ui-design", id: "home", title: "Home", project: "beta" });
    const d = await loadDesign(root, "ui-design", "home");
    assert.equal(d.project, "beta");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("spec project round-trips in the manifest", async () => {
  const { umbrella, root } = await workspace();
  try {
    const { manifest } = await createSpec(root, {
      title: "Export",
      type: "new-feature",
      id: "2099-01-01-export",
      project: "acme",
      skipReferenceValidation: true,
    });
    assert.equal(manifest.project, "acme");
    assert.equal((await loadSpec(root, "2099-01-01-export")).project, "acme");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("stakeholder project round-trips; global default has no key", async () => {
  const { umbrella, root } = await workspace();
  try {
    const tagged = await addStakeholder(root, { name: "Acme PM", id: "acme-pm", project: "acme" });
    assert.equal(tagged.project, "acme");
    assert.equal((await loadStakeholder(root, "acme-pm")).project, "acme");
    const global = await addStakeholder(root, { name: "Internal Eng", id: "internal-eng" });
    assert.equal(global.project, undefined);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("doc/ticket project override beats the source's project", async () => {
  const { umbrella, root } = await workspace();
  try {
    // A shared (global) source.
    await registerSource(root, { id: "shared-jira", name: "Shared Jira" });
    // One ticket overridden to acme, one left to inherit (global).
    const overridden = await addTicket(root, {
      source: "shared-jira",
      ticketId: "ACME-1",
      title: "Acme ticket",
      project: "acme",
    });
    assert.equal(overridden.project, "acme");
    const inherited = await addTicket(root, {
      source: "shared-jira",
      ticketId: "GEN-1",
      title: "General ticket",
    });
    assert.equal(inherited.project, undefined);
    // Doc override too.
    const doc = await addDoc(root, {
      source: "shared-jira",
      docId: "ACME-DOC",
      title: "Acme doc",
      project: "acme",
    });
    assert.equal(doc.project, "acme");
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("map scopes stakeholders, and doc/ticket overrides win over source", async () => {
  const { umbrella, root } = await workspace();
  try {
    await addStakeholder(root, { name: "Acme PM", id: "acme-pm", project: "acme" });
    await addStakeholder(root, { name: "Internal Eng", id: "internal-eng" }); // global
    await addStakeholder(root, { name: "Beta PM", id: "beta-pm", project: "beta" });

    // Shared (global) source; one ticket overridden to acme.
    await registerSource(root, { id: "shared-jira", name: "Shared Jira" });
    await addTicket(root, { source: "shared-jira", ticketId: "ACME-1", title: "Acme ticket", project: "acme" });
    await addTicket(root, { source: "shared-jira", ticketId: "GEN-1", title: "General ticket" }); // global

    function section(map, dir) {
      return (map.children ?? []).find((c) => c.relPath === dir);
    }

    const acme = await buildWorkspaceMap(root, { depth: 2, scope: { kind: "project", id: "acme" } });
    // Stakeholders: acme PM + global internal eng, not beta PM.
    const people = (section(acme, "stakeholders").children ?? []).map((c) => c.name).sort();
    assert.deepEqual(people, ["Acme PM", "Internal Eng"]);
    // Tickets: the acme-overridden one + the global one (both in acme scope).
    const tix = (section(acme, "tickets").children ?? []).map((c) => c.name).sort();
    assert.deepEqual(tix, ["shared-jira:ACME-1", "shared-jira:GEN-1"]);

    // Beta scope: only the global ticket (acme override excluded), only global person.
    const beta = await buildWorkspaceMap(root, { depth: 2, scope: { kind: "project", id: "beta" } });
    const betaTix = (section(beta, "tickets").children ?? []).map((c) => c.name).sort();
    assert.deepEqual(betaTix, ["shared-jira:GEN-1"]);
    const betaPeople = (section(beta, "stakeholders").children ?? []).map((c) => c.name).sort();
    assert.deepEqual(betaPeople, ["Beta PM", "Internal Eng"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("updateFeature reassigns project in place and clears with null", async () => {
  const { umbrella, root } = await workspace();
  try {
    const f = await addFeature(root, { name: "Thing", id: "thing", project: "acme", skipReferenceValidation: true });
    assert.equal(f.project, "acme");
    const moved = await updateFeature(root, "thing", { project: "beta" });
    assert.equal(moved.project, "beta");
    assert.equal((await loadFeature(root, "thing")).project, "beta");
    const cleared = await updateFeature(root, "thing", { project: null });
    assert.equal(cleared.project, undefined);
    assert.equal((await loadFeature(root, "thing")).project, undefined);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("setSourceProject reassigns a source (docs inherit the new project)", async () => {
  const { umbrella, root } = await workspace();
  try {
    await registerSource(root, { id: "kb", name: "KB", project: "acme" });
    await addDoc(root, { source: "kb", docId: "d1", title: "Doc" }); // inherits acme
    const moved = await setSourceProject(root, "kb", "beta");
    assert.equal(moved.project, "beta");
    // The doc has no override, so its effective project follows the source.
    const cleared = await setSourceProject(root, "kb", null);
    assert.equal(cleared.project, undefined);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("map scopes sections to a project plus global", async () => {
  const { umbrella, root } = await workspace();
  try {
    // Acme + Beta + global features
    await addFeature(root, { name: "Acme Feature", id: "acme-feat", project: "acme", skipReferenceValidation: true });
    await addFeature(root, { name: "Beta Feature", id: "beta-feat", project: "beta", skipReferenceValidation: true });
    await addFeature(root, { name: "Shared Feature", id: "shared-feat", skipReferenceValidation: true });

    // Sources: one acme, one global; docs inherit
    await registerSource(root, { id: "acme-src", name: "Acme Source", project: "acme" });
    await registerSource(root, { id: "global-src", name: "Global Source" });
    await addDoc(root, { source: "acme-src", docId: "d1", title: "Acme Doc" });
    await addDoc(root, { source: "global-src", docId: "d2", title: "Global Doc" });
    await addTicket(root, { source: "acme-src", ticketId: "T-1", title: "Acme Ticket" });

    function section(map, dir) {
      return (map.children ?? []).find((c) => c.relPath === dir);
    }

    // All scope: everything present
    const all = await buildWorkspaceMap(root, { depth: 2, scope: { kind: "all" } });
    const allFeatures = section(all, "features");
    assert.equal(allFeatures.children.length, 3);

    // Acme scope: acme + global features, not beta
    const acme = await buildWorkspaceMap(root, { depth: 2, scope: { kind: "project", id: "acme" } });
    const acmeFeatureNames = section(acme, "features").children.map((c) => c.name).sort();
    assert.deepEqual(acmeFeatureNames, ["Acme Feature", "Shared Feature"]);

    // Acme scope docs: the acme-src doc + ... global-src doc is global, so both show
    const acmeDocs = section(acme, "documentation").children.map((c) => c.name).sort();
    assert.deepEqual(acmeDocs, ["acme-src:d1", "global-src:d2"]);

    // Beta scope: beta + global features, NOT acme; tickets empty (acme-only ticket source)
    const beta = await buildWorkspaceMap(root, { depth: 2, scope: { kind: "project", id: "beta" } });
    const betaFeatureNames = section(beta, "features").children.map((c) => c.name).sort();
    assert.deepEqual(betaFeatureNames, ["Beta Feature", "Shared Feature"]);
    const betaDocs = section(beta, "documentation").children.map((c) => c.name).sort();
    assert.deepEqual(betaDocs, ["global-src:d2"]); // acme doc excluded
    // An empty section carries no `children` array (builder omits it).
    const betaTickets = section(beta, "tickets").children ?? [];
    assert.equal(betaTickets.length, 0); // acme-src ticket excluded
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
