import { buildScreens } from "./ui-screens.js";
import { detectConnections } from "./ui-connections.js";
import { detectUiKit } from "./ui-kit.js";

/**
 * One-shot UI overview — aggregates every UI detector (apps, screens,
 * connections, kit) into a single picture. The deterministic "lay of
 * the land" the ui-design agent reads at the start of a cold run, and
 * a quick health view for the user.
 */

export interface UiAppOverview {
  ref: string;
  name: string;
  framework: string;
  /** Screens (routes) detected; 0 for code-routed apps. */
  screens: number;
  /** False when routing lives in code (the agent enumerates screens). */
  fileBased: boolean;
}

export interface UiOverview {
  apps: UiAppOverview[];
  totalScreens: number;
  /** Cross-app connection edges (shared internal packages). */
  connections: number;
  /** Of those, how many look like a shared design system. */
  designSystemConnections: number;
  /** Component-source directories detected. */
  componentSources: number;
  /** Total component files across those sources. */
  totalComponents: number;
  /** Design-token sources (Tailwind config, tokens.json, theme files). */
  tokenSources: number;
}

export async function buildUiOverview(workspaceRoot: string): Promise<UiOverview> {
  const [screens, connections, kit] = await Promise.all([
    buildScreens(workspaceRoot),
    detectConnections(workspaceRoot),
    detectUiKit(workspaceRoot),
  ]);

  const apps: UiAppOverview[] = screens.map((s) => ({
    ref: s.app.ref,
    name: s.app.name,
    framework: s.app.framework,
    screens: s.total,
    fileBased: s.fileBased,
  }));

  return {
    apps,
    totalScreens: apps.reduce((n, a) => n + a.screens, 0),
    connections: connections.edges.length,
    designSystemConnections: connections.edges.filter((e) => e.designSystem).length,
    componentSources: kit.components.length,
    totalComponents: kit.components.reduce((n, c) => n + c.count, 0),
    tokenSources: kit.tokens.length,
  };
}
