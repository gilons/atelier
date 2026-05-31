/**
 * Public surface of @atelier/core.
 *
 * Atelier's job is to track the user's workspace state — sources,
 * documents (as agent-curated summaries), features, specs, repos,
 * discrepancies. It does NOT talk to source systems; agents do
 * (via MCP / browser extensions / whatever's already wired up).
 * So this barrel only re-exports workspace primitives + the data
 * model. No adapters, no transports, no parsers, no sync engine.
 */
export * from "./types.js";
export * from "./paths.js";
export * from "./yaml-io.js";
export * from "./validation.js";
export * from "./workspace.js";
export * from "./workspace-finder.js";
export * from "./git.js";
export * from "./repos.js";
export * from "./git-hosts.js";
export * from "./discovery.js";
export * from "./project-inspect.js";
export * from "./ui-apps.js";
export * from "./ui-routes.js";
export * from "./ui-connections.js";
export * from "./ui-kit.js";
export * from "./ui-screens.js";
export * from "./ui-overview.js";
export * from "./sources.js";
export * from "./sessions.js";
export * from "./features.js";
export * from "./items.js";
export * from "./documentation.js";
export * from "./tickets.js";
export * from "./stakeholders.js";
export * from "./agents.js";
export * from "./agent-builtins.js";
export * from "./design-disciplines.js";
export * from "./folder-index.js";
export * from "./index-tree.js";
export * from "./discrepancies.js";
export * from "./front-matter.js";
export * from "./specs.js";
export * from "./local-discovery.js";
export * from "./audio-config.js";
export * from "./design-config.js";
export * from "./design-palette.js";
export { ATELIER_VERSION } from "./version.js";
