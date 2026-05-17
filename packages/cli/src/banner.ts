import { ui } from "./ui.js";

/**
 * ASCII logo + welcome flourish for the REPL.
 *
 * Standard figlet-style block letters for "Atelier", colored cyan when
 * the terminal supports it. The width is 31 characters so it fits in
 * any reasonable terminal (we still gate on cols ≥ 60 so phones /
 * narrow side panes don't get cropped art).
 *
 * Layout:
 *
 *       _   _       _ _
 *      / \ | |_ ___| (_) ___ _ __
 *     / _ \| __/ _ \ | |/ _ \ '__|
 *    / ___ \ ||  __/ | |  __/ |
 *   /_/   \_\__\___|_|_|\___|_|
 *
 *      a planning companion for the spec-driven era  ·  v0.0.1
 */

const LOGO_LINES = [
  "    _   _       _ _              ",
  "   / \\ | |_ ___| (_) ___ _ __    ",
  "  / _ \\| __/ _ \\ | |/ _ \\ '__|   ",
  " / ___ \\ ||  __/ | |  __/ |      ",
  "/_/   \\_\\__\\___|_|_|\\___|_|      ",
];

const MIN_COLS_FOR_LOGO = 60;

/**
 * Render the welcome banner. Falls back to a single-line greeting on
 * narrow terminals so the layout never wraps mid-art.
 */
export function renderBanner(version: string, tagline: string): void {
  const cols = (process.stdout.columns ?? 80) | 0;
  if (cols < MIN_COLS_FOR_LOGO) {
    ui.print(`${ui.bold(ui.cyan("Atelier"))} ${ui.dim(`v${version}`)} — ${ui.dim(tagline)}`);
    ui.blank();
    return;
  }
  ui.blank();
  for (const line of LOGO_LINES) {
    ui.print(ui.cyan(line));
  }
  ui.blank();
  ui.print(`  ${ui.dim(tagline)}  ${ui.dim("·")}  ${ui.dim(`v${version}`)}`);
  ui.blank();
}
