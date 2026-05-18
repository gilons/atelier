import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Open a URL in a chromeless desktop-style window when possible,
 * falling back to the user's default browser otherwise.
 *
 * Chrome (and Chromium-family browsers) support `--app=<url>` —
 * the page opens in its own window with no URL bar, no tabs, no
 * extension chrome. To the user it looks and feels like a small
 * native desktop app, even though it's actually a regular tab
 * under the hood. This is the cheapest path to a "native window"
 * experience without committing to a Tauri/Electron toolchain.
 *
 * Why we try Chromium-family browsers in priority order rather
 * than just opening `xdg-open`/`open`:
 *
 *   - The user's default browser might be Safari/Firefox, which
 *     don't have an equivalent flag. Their version would land
 *     in a normal tab.
 *   - We want the chromeless window when it's available.
 *
 * Fallback chain:
 *   1. Chrome / Chromium / Edge / Brave / Vivaldi / Arc on PATH
 *      with `--app=<url>` + window-size hint.
 *   2. macOS `open -a` for an app bundle when PATH lookups miss
 *      (Chrome installed but the wrapper isn't on PATH).
 *   3. Platform-default `open` / `xdg-open` / `start` — opens a
 *      normal tab. Less native but the user can still edit.
 */

export interface OpenOptions {
  /**
   * Initial window size as "W,H". Default 440x390 — about half the
   * area of a comfortable web app window. The editor fits in this
   * footprint (toolbar wraps if needed; the contenteditable body
   * scrolls). Users can resize from the OS chrome.
   */
  windowSize?: string;
}

export interface OpenResult {
  /** How we ended up opening the URL. Surface this to the user. */
  mode:
    | "chrome-app"
    | "edge-app"
    | "brave-app"
    | "chromium-app"
    | "vivaldi-app"
    | "arc-app"
    | "macos-open"
    | "linux-xdg-open"
    | "windows-start";
  /** Underlying child. May be detached and already exited. */
  child?: ChildProcess;
}

interface ChromiumCandidate {
  mode: OpenResult["mode"];
  /** Either a PATH-resolved command name OR an absolute path. */
  command: string;
  /**
   * Path is "macos-bundle" → use `open -a` (the command is a .app
   * bundle name, not an executable). Otherwise it's a normal binary.
   */
  invocation: "exec" | "macos-bundle";
}

/**
 * Try to spawn `url` in a Chromium-family `--app=` window. Returns
 * the launcher mode + child handle, or null when no compatible
 * browser was found.
 *
 * Forces a fresh Chrome process tree via `--user-data-dir`. Without
 * that, if the user already has a Chrome window open, the new
 * `--app=` window inherits the existing instance's geometry and
 * silently ignores `--window-size`. With a unique per-session
 * data dir, Chrome boots a clean process that honors every flag
 * we pass — including `--window-size` and `--window-position`.
 *
 * The data dir lives under `os.tmpdir()`; we don't bother
 * cleaning it up because the OS handles tmpdir lifecycle (macOS
 * clears on reboot, Linux distros usually do the same). Each
 * session gets a fresh dir so resizes from one session don't
 * leak into the next.
 */
export async function openUrlInDesktopWindow(
  url: string,
  opts: OpenOptions = {}
): Promise<OpenResult> {
  const windowSize = opts.windowSize ?? "440,390";
  const platform = process.platform;
  const candidates = chromiumCandidates(platform);

  // Fresh per-session profile so --window-size actually wins.
  const userDataDir = await makeEphemeralUserDataDir();

  for (const c of candidates) {
    if (c.invocation === "macos-bundle") {
      // macOS: `open -a "Google Chrome" --args --app=...` lets us
      // pass flags to the app being opened. -n forces a new
      // instance so an existing Chrome window doesn't capture
      // the --app request as a normal tab.
      try {
        await fs.access(c.command);
      } catch {
        continue;
      }
      const child = spawn(
        "open",
        [
          "-n",
          "-a",
          c.command,
          "--args",
          `--app=${url}`,
          `--user-data-dir=${userDataDir}`,
          `--window-size=${windowSize}`,
          // Position the window somewhere reasonable rather than
          // letting Chrome stack it on top of an existing instance.
          "--window-position=200,150",
          // Suppress first-run noise (welcome page, default-browser
          // prompt) since this is a transient editor profile.
          "--no-first-run",
          "--no-default-browser-check",
        ],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      return { mode: c.mode, child };
    }
    // PATH-style binary. Probe with `which`-equivalent before
    // spawning so we can fall through cleanly if it isn't there.
    if (!(await isOnPath(c.command))) continue;
    const child = spawn(
      c.command,
      [
        `--app=${url}`,
        `--user-data-dir=${userDataDir}`,
        `--window-size=${windowSize}`,
        "--window-position=200,150",
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    return { mode: c.mode, child };
  }

  // Fallback: open in the user's default handler. This won't be
  // chromeless but it does let the user complete the flow.
  return openInDefaultHandler(url, platform);
}

/**
 * Create a fresh, empty Chrome profile directory under
 * `os.tmpdir()`. Returns its absolute path. We don't clean it
 * up — the OS handles tmpdir eviction and each new session
 * generates a new dir, so leftover dirs are bounded by how
 * often the user runs `/doc add`.
 */
async function makeEphemeralUserDataDir(): Promise<string> {
  const suffix = crypto.randomBytes(6).toString("hex");
  const dir = path.join(os.tmpdir(), `atelier-editor-${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function chromiumCandidates(platform: NodeJS.Platform): ChromiumCandidate[] {
  if (platform === "darwin") {
    return [
      // .app bundles via `open -a`. Probe by checking the
      // bundle's existence rather than PATH — the binary
      // inside the bundle is rarely on PATH but the bundle is
      // at a well-known location.
      { mode: "chrome-app",   invocation: "macos-bundle", command: "/Applications/Google Chrome.app" },
      { mode: "chrome-app",   invocation: "macos-bundle", command: bundlePath("Google Chrome.app") },
      { mode: "edge-app",     invocation: "macos-bundle", command: "/Applications/Microsoft Edge.app" },
      { mode: "edge-app",     invocation: "macos-bundle", command: bundlePath("Microsoft Edge.app") },
      { mode: "brave-app",    invocation: "macos-bundle", command: "/Applications/Brave Browser.app" },
      { mode: "brave-app",    invocation: "macos-bundle", command: bundlePath("Brave Browser.app") },
      { mode: "chromium-app", invocation: "macos-bundle", command: "/Applications/Chromium.app" },
      { mode: "vivaldi-app",  invocation: "macos-bundle", command: "/Applications/Vivaldi.app" },
      { mode: "arc-app",      invocation: "macos-bundle", command: "/Applications/Arc.app" },
      // Also probe PATH for chrome.exe-style aliases users may
      // have installed via package managers.
      { mode: "chrome-app",   invocation: "exec",         command: "google-chrome" },
      { mode: "chromium-app", invocation: "exec",         command: "chromium" },
    ];
  }
  if (platform === "linux") {
    return [
      { mode: "chrome-app",   invocation: "exec", command: "google-chrome" },
      { mode: "chrome-app",   invocation: "exec", command: "google-chrome-stable" },
      { mode: "chromium-app", invocation: "exec", command: "chromium" },
      { mode: "chromium-app", invocation: "exec", command: "chromium-browser" },
      { mode: "edge-app",     invocation: "exec", command: "microsoft-edge" },
      { mode: "brave-app",    invocation: "exec", command: "brave-browser" },
      { mode: "vivaldi-app",  invocation: "exec", command: "vivaldi" },
    ];
  }
  if (platform === "win32") {
    return [
      { mode: "chrome-app",   invocation: "exec", command: "chrome.exe" },
      { mode: "edge-app",     invocation: "exec", command: "msedge.exe" },
      { mode: "brave-app",    invocation: "exec", command: "brave.exe" },
    ];
  }
  return [];
}

function bundlePath(name: string): string {
  return path.join(os.homedir(), "Applications", name);
}

/**
 * Cross-platform "is this command runnable from PATH?" probe.
 * Uses `which` on POSIX, `where` on Windows. We swallow stderr
 * so callers don't see noise when the lookup misses.
 */
async function isOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = spawn(probe, [command], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function openInDefaultHandler(
  url: string,
  platform: NodeJS.Platform
): OpenResult {
  if (platform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return { mode: "macos-open", child };
  }
  if (platform === "win32") {
    // `start ""` quirks: the first argument is the window title.
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { mode: "windows-start", child };
  }
  // Linux + everything else: try xdg-open.
  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
  return { mode: "linux-xdg-open", child };
}

/**
 * Human-friendly label for a launch mode. Used in the CLI status
 * line so the user can see how their editor was opened.
 */
export function describeLaunchMode(mode: OpenResult["mode"]): string {
  switch (mode) {
    case "chrome-app":   return "Chrome (chromeless window)";
    case "edge-app":     return "Edge (chromeless window)";
    case "brave-app":    return "Brave (chromeless window)";
    case "chromium-app": return "Chromium (chromeless window)";
    case "vivaldi-app":  return "Vivaldi (chromeless window)";
    case "arc-app":      return "Arc (chromeless window)";
    case "macos-open":
    case "linux-xdg-open":
    case "windows-start":
      return "default browser (no chromeless mode found — install Chrome or Edge for a more native window)";
  }
}
