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
export * from "./sources.js";
export * from "./features.js";
export * from "./docs.js";
export * from "./discrepancies.js";
export * from "./front-matter.js";
export * from "./source-adapters.js";
export * from "./local-folder-adapter.js";
export * from "./mcp-config.js";
export * from "./mcp-adapter.js";
export * from "./sync.js";
export * from "./specs.js";
export * from "./http-transport.js";
export * from "./cli-transport.js";
export * from "./onboarding.js";
export * from "./classify.js";
export * from "./local-discovery.js";
// Register the built-in adapters (side-effect imports).
import "./adapters/notion.js";
import "./adapters/sharepoint.js";
import "./adapters/github-discussions.js";
export { NotionAdapter, notionOnboarding } from "./adapters/notion.js";
export {
  SharePointAdapter,
  sharepointOnboarding,
  renderVttAsMarkdown,
  type SharePointScope,
} from "./adapters/sharepoint.js";
export {
  GitHubDiscussionsAdapter,
  githubDiscussionsOnboarding,
  type GitHubDiscussionsScope,
} from "./adapters/github-discussions.js";
export { ATELIER_VERSION } from "./version.js";
