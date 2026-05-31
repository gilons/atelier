import { detectNavigation, type RouteEntry } from "./ui-routes.js";

/**
 * Screen inventory — the design checklist.
 *
 * An app's routes are the screens it needs designed. This reframes the
 * route map ({@link detectNavigation}) as a per-app, section-grouped
 * inventory of screens — the deterministic "what should exist in the
 * design tool" list. The ui-design agent ensures the tool has a frame
 * per screen and flags drift (screens with no frame, frames with no
 * screen).
 */

export interface Screen {
  /** The route this screen corresponds to, e.g. "/blog/[slug]". */
  route: string;
  /** A human label, e.g. "Home", "blog / [slug]". */
  label: string;
  /** True when the route has a dynamic segment. */
  dynamic: boolean;
}

export interface ScreenSection {
  /** Top-level area, e.g. "blog", or "(root)" for top-level screens. */
  section: string;
  screens: Screen[];
}

export interface AppScreens {
  app: { ref: string; name: string; framework: string };
  /** False when routing lives in code (the agent reads screens itself). */
  fileBased: boolean;
  sections: ScreenSection[];
  /** Total screens across all sections. */
  total: number;
}

function labelFor(route: string): string {
  if (route === "/") return "Home";
  const segs = route.split("/").filter(Boolean);
  return segs.join(" / ");
}

function sectionFor(route: string): string {
  const segs = route.split("/").filter(Boolean);
  return segs.length === 0 ? "(root)" : segs[0];
}

function groupScreens(routes: RouteEntry[]): ScreenSection[] {
  const bySection = new Map<string, Screen[]>();
  for (const r of routes) {
    const section = sectionFor(r.route);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push({ route: r.route, label: labelFor(r.route), dynamic: r.dynamic });
  }
  return [...bySection.entries()]
    .sort((a, b) => {
      // "(root)" first, then alphabetical.
      if (a[0] === "(root)") return -1;
      if (b[0] === "(root)") return 1;
      return a[0].localeCompare(b[0]);
    })
    .map(([section, screens]) => ({
      section,
      screens: screens.sort((x, y) => x.route.localeCompare(y.route)),
    }));
}

/**
 * Build the screen inventory for every app (or one, by ref/name/repo).
 */
export async function buildScreens(
  workspaceRoot: string,
  opts: { app?: string } = {}
): Promise<AppScreens[]> {
  const navs = await detectNavigation(workspaceRoot, { app: opts.app });
  return navs.map((n) => ({
    app: { ref: n.app.ref, name: n.app.name, framework: n.app.framework },
    fileBased: n.fileBased,
    sections: groupScreens(n.routes),
    total: n.routes.length,
  }));
}
