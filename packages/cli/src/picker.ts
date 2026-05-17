import { decodeKeys, type Key } from "./input-keys.js";

/**
 * Raw-mode multi-select picker. Arrow keys move the highlight,
 * space toggles selection, Enter confirms.
 *
 * This is the modern terminal idiom — typing numbers to toggle rows
 * (the old line-mode `pickMany`) is friendly to scripted tests but
 * jarring to a human in a REPL. The flows that need real interactive
 * picking (`/repo discover`, future `/source onboard`-style choose
 * pages) go through this.
 *
 * UX:
 *
 *     Which orgs are relevant to this workspace?
 *       ❯ [✓] dinolabdev    6 cloned · 7 on GitHub
 *         [ ] gilons         1 cloned · 56 on GitHub
 *         [ ] Maxcutex       1 cloned · 52 on GitHub
 *       ↑↓ navigate · ⎵ toggle · ↵ confirm · / filter · esc cancel
 *
 * Keys:
 *
 *   ↑/↓    move highlight (skip over disabled rows)
 *   space  toggle the highlighted row
 *   enter  submit the current selection (even if empty)
 *   a/A    select every visible row
 *   n/N    clear every selection
 *   /      enter filter mode; subsequent chars build the filter
 *   esc    in filter mode → clear filter
 *          otherwise      → cancel + return null
 *   C-c    cancel + return null
 *   C-d    cancel + return null
 *
 * Only used on a real TTY. Piped stdin / non-TTY runs go through
 * the line-mode `PromptSession.pickMany` fallback instead.
 */

export interface PickerOption<T> {
  label: string;
  value: T;
  /** Short note shown next to the label (dim). */
  note?: string;
  /** Initial selection state. Defaults to false. */
  preselected?: boolean;
  /**
   * Visually marked but unselectable — used to show already-
   * registered repos in the discover wizard so the user can see
   * what's there without re-registering.
   */
  disabled?: boolean;
}

export type PickerResult<T> =
  | { type: "submitted"; values: T[] }
  | { type: "cancelled" };

export interface PickerOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Cap on visible rows. Defaults to terminal-height-aware. */
  maxVisible?: number;
}

export class MultiSelectPicker<T> {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly question: string;
  private readonly options: PickerOption<T>[];

  // State
  private highlight = 0;
  private selected: Set<number>;
  private filter = "";
  private filterMode = false;
  private hasRendered = false;
  private finished = false;
  private resolver: ((r: PickerResult<T>) => void) | null = null;
  private dataHandler: ((chunk: Buffer | string) => void) | null = null;

  // Computed
  private get maxVisible(): number {
    const rows = (this.output.rows ?? 24) | 0;
    // Reserve a few rows for the question + help + breathing room.
    return Math.max(3, Math.min(this.optsMaxVisible, rows - 6));
  }
  private optsMaxVisible: number;

  constructor(
    question: string,
    options: PickerOption<T>[],
    opts: PickerOptions = {}
  ) {
    this.question = question;
    this.options = options;
    this.input = opts.input ?? (process.stdin as NodeJS.ReadStream);
    this.output = opts.output ?? (process.stdout as NodeJS.WriteStream);
    this.optsMaxVisible = opts.maxVisible ?? 10;
    this.selected = new Set(
      options
        .map((o, i) => (o.preselected ? i : -1))
        .filter((i) => i >= 0)
    );
    // Start the highlight on the first non-disabled row.
    this.highlight = this.firstEnabledIndex();
  }

  run(): Promise<PickerResult<T>> {
    if (this.options.length === 0) {
      return Promise.resolve({ type: "submitted", values: [] });
    }
    return new Promise<PickerResult<T>>((resolve) => {
      this.resolver = resolve;
      try {
        this.input.setRawMode?.(true);
      } catch {
        /* not a TTY — caller shouldn't have invoked us */
      }
      this.input.resume();
      this.input.setEncoding("utf8");
      this.dataHandler = (chunk) => this.onData(String(chunk));
      this.input.on("data", this.dataHandler);
      this.input.once("end", () => this.finish({ type: "cancelled" }));
      this.render();
    });
  }

  // ============================================================
  // Keystroke handling
  // ============================================================

  private onData(chunk: string): void {
    if (this.finished) return;
    const keys = decodeKeys(chunk);
    for (const key of keys) {
      if (this.finished) return;
      this.dispatch(key);
    }
  }

  private dispatch(key: Key): void {
    // Cancellation is the same regardless of mode.
    if (key.type === "ctrl-c" || key.type === "ctrl-d") {
      return this.cancel();
    }

    // Filter-mode input: typing builds the filter; Esc clears.
    if (this.filterMode) {
      return this.dispatchInFilterMode(key);
    }

    switch (key.type) {
      case "up":
        this.highlight = this.moveHighlight(-1);
        return this.render();

      case "down":
        this.highlight = this.moveHighlight(1);
        return this.render();

      case "char":
        if (key.value === " ") {
          this.toggleHighlighted();
          return this.render();
        }
        if (key.value === "a" || key.value === "A") {
          this.selectAllVisible();
          return this.render();
        }
        if (key.value === "n" || key.value === "N") {
          this.selected.clear();
          return this.render();
        }
        if (key.value === "/") {
          this.filterMode = true;
          this.filter = "";
          return this.render();
        }
        // Unhandled char: ignore.
        return;

      case "enter":
        return this.submit();

      case "escape":
        return this.cancel();

      default:
        // Arrow left/right, ctrl-a/e, etc. — no-ops in pick mode.
        return;
    }
  }

  private dispatchInFilterMode(key: Key): void {
    switch (key.type) {
      case "escape":
        // Esc out of filter mode: clear filter, return to nav mode.
        this.filter = "";
        this.filterMode = false;
        this.highlight = this.firstEnabledIndex();
        return this.render();

      case "enter":
        // Enter inside filter just exits filter mode (keep filter).
        this.filterMode = false;
        return this.render();

      case "backspace":
        this.filter = this.filter.slice(0, -1);
        // Reset highlight to first visible (might have changed).
        if (!this.isVisible(this.highlight)) {
          this.highlight = this.firstVisibleEnabledIndex();
        }
        return this.render();

      case "char":
        this.filter += key.value;
        if (!this.isVisible(this.highlight)) {
          this.highlight = this.firstVisibleEnabledIndex();
        }
        return this.render();

      case "up":
        this.highlight = this.moveHighlight(-1);
        return this.render();

      case "down":
        this.highlight = this.moveHighlight(1);
        return this.render();

      default:
        return;
    }
  }

  // ============================================================
  // State helpers
  // ============================================================

  private toggleHighlighted(): void {
    if (this.highlight < 0 || this.highlight >= this.options.length) return;
    const opt = this.options[this.highlight];
    if (opt.disabled) return;
    if (this.selected.has(this.highlight)) {
      this.selected.delete(this.highlight);
    } else {
      this.selected.add(this.highlight);
    }
  }

  private selectAllVisible(): void {
    for (let i = 0; i < this.options.length; i++) {
      if (this.options[i].disabled) continue;
      if (!this.isVisible(i)) continue;
      this.selected.add(i);
    }
  }

  /** Move highlight by `step`, skipping disabled rows + non-visible. */
  private moveHighlight(step: number): number {
    if (this.options.length === 0) return -1;
    let i = this.highlight;
    for (let n = 0; n < this.options.length; n++) {
      i = (i + step + this.options.length) % this.options.length;
      if (!this.options[i].disabled && this.isVisible(i)) return i;
    }
    return this.highlight;
  }

  private firstEnabledIndex(): number {
    for (let i = 0; i < this.options.length; i++) {
      if (!this.options[i].disabled) return i;
    }
    return 0;
  }

  private firstVisibleEnabledIndex(): number {
    for (let i = 0; i < this.options.length; i++) {
      if (this.options[i].disabled) continue;
      if (this.isVisible(i)) return i;
    }
    return -1;
  }

  private isVisible(index: number): boolean {
    if (!this.filter) return true;
    const opt = this.options[index];
    const needle = this.filter.toLowerCase();
    return (
      opt.label.toLowerCase().includes(needle) ||
      (opt.note?.toLowerCase().includes(needle) ?? false)
    );
  }

  private submit(): void {
    const values: T[] = [];
    for (const i of this.selected) {
      // Filtered-out rows still count toward selection — the user
      // explicitly toggled them. (Filter is for navigating large
      // lists, not pruning the result.)
      if (this.options[i].disabled) continue;
      values.push(this.options[i].value);
    }
    this.clearRender();
    this.echoFinal(values);
    this.finish({ type: "submitted", values });
  }

  private cancel(): void {
    this.clearRender();
    this.output.write("\x1b[?25h"); // make sure cursor's visible
    this.finish({ type: "cancelled" });
  }

  // ============================================================
  // Render
  // ============================================================

  private clearRender(): void {
    if (!this.hasRendered) return;
    this.output.write("\r\x1b[0J");
  }

  /**
   * Echo a one-line summary of what was picked so the scrollback
   * shows what the user submitted (the menu itself is gone).
   *
   * We deliberately don't repeat the question text here: in REPL
   * mode the terminal sometimes scrolls the question header above
   * the visible area before render() ends, so `clearRender` can
   * miss it. Repeating the question in the echo then shows it
   * twice — once from the surviving render header, once from the
   * echo. A bare `→ value` line is unambiguous and looks fine
   * whether or not the header was cleared.
   */
  private echoFinal(values: T[]): void {
    const summary =
      values.length === 0
        ? dim(this.output, "(nothing selected)")
        : values.length === 1
          ? labelOf(this.options[[...this.selected][0]])
          : `${values.length} item(s)`;
    this.output.write(`  ${cyan(this.output, "→")} ${summary}\n`);
  }

  private render(): void {
    this.clearRender();
    this.output.write("\x1b[?25l"); // hide cursor during multi-line draw

    // 1) Question header
    this.output.write(this.question);
    if (this.filterMode) {
      this.output.write("  " + dim(this.output, `(filter: ${this.filter}_)`));
    } else if (this.filter) {
      this.output.write("  " + dim(this.output, `(filter: ${this.filter})`));
    }
    this.output.write("\n");

    // 2) Visible rows, windowed around the highlight.
    const visibleIndices = this.computeVisibleWindow();
    const labelWidth = Math.min(
      40,
      visibleIndices.reduce((m, i) => Math.max(m, labelOf(this.options[i]).length), 0)
    );
    const termWidth = this.output.columns ?? 80;
    const fixedWidth = 2 + 4 + labelWidth + 2; // "  " + "[x] " + label + "  "
    const maxNoteWidth = Math.max(10, termWidth - fixedWidth - 1);

    let rowsDrawn = 0;
    for (const i of visibleIndices) {
      const opt = this.options[i];
      const isHighlighted = i === this.highlight;
      const isSelected = this.selected.has(i);
      const isDisabled = opt.disabled === true;
      const marker = isHighlighted ? cyan(this.output, "❯") : " ";
      const checkbox = isDisabled
        ? dim(this.output, "[-]")
        : isSelected
          ? cyan(this.output, "[✓]")
          : "[ ]";
      const labelText = padOrTrunc(labelOf(opt), labelWidth);
      const label = isDisabled
        ? dim(this.output, labelText)
        : isHighlighted
          ? bold(this.output, labelText)
          : labelText;
      let note = opt.note ?? "";
      if (note.length > maxNoteWidth) {
        note = note.slice(0, Math.max(1, maxNoteWidth - 1)) + "…";
      }
      const noteOut = note ? "  " + dim(this.output, note) : "";
      this.output.write(`\n  ${marker} ${checkbox} ${label}${noteOut}`);
      rowsDrawn++;
    }
    if (rowsDrawn === 0) {
      this.output.write(
        "\n  " + dim(this.output, "(no matches — backspace to edit the filter)")
      );
      rowsDrawn = 1;
    }

    // 3) Scroll indicator if needed
    const total = this.countVisible();
    if (visibleIndices.length < total) {
      this.output.write(
        "\n  " +
          dim(
            this.output,
            `(showing ${visibleIndices.length} of ${total} — ↑↓ to scroll)`
          )
      );
      rowsDrawn++;
    }

    // 4) Help line
    this.output.write("\n  " + this.helpLine());
    rowsDrawn++;

    // Walk cursor back up to just below the question header, where
    // the user-visible cursor doesn't really matter (we hid it). On
    // submit/cancel, clearRender + final echo runs from this anchor.
    this.output.write(`\x1b[${rowsDrawn + 1}A`);
    this.output.write("\r");
    this.hasRendered = true;
  }

  private helpLine(): string {
    const colorize = (s: string) => dim(this.output, s);
    if (this.filterMode) {
      return colorize(
        "type to filter · ↵ exit filter · esc clear · ⎈c cancel"
      );
    }
    return colorize(
      "↑↓ navigate · ⎵ toggle · ↵ confirm · a all · n none · / filter · esc cancel"
    );
  }

  /** Choose which options to display this render, windowed around the highlight. */
  private computeVisibleWindow(): number[] {
    const all = this.allVisibleIndices();
    const max = this.maxVisible;
    if (all.length <= max) return all;
    // Center on the highlight (or as close as possible).
    const hlPos = all.indexOf(this.highlight);
    const half = Math.floor(max / 2);
    let start = Math.max(0, hlPos - half);
    let end = start + max;
    if (end > all.length) {
      end = all.length;
      start = end - max;
    }
    return all.slice(start, end);
  }

  private allVisibleIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.options.length; i++) {
      if (this.isVisible(i)) out.push(i);
    }
    return out;
  }

  private countVisible(): number {
    return this.allVisibleIndices().length;
  }

  private finish(result: PickerResult<T>): void {
    if (this.finished) return;
    this.finished = true;
    if (this.dataHandler) {
      this.input.off("data", this.dataHandler);
      this.dataHandler = null;
    }
    try {
      this.input.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    // Note: we deliberately do NOT call input.pause() here. The
    // picker is typically embedded in a larger flow (a wizard or a
    // /source onboard run) that shares the same stdin via a
    // PromptSession. Pausing stdin after the picker finishes leaves
    // the session's readline starved — the next `ask()` call hangs
    // or, worse, surfaces "input stream ended before answering"
    // which the REPL catches as a clean exit. The caller owns the
    // stdin lifecycle; we just hand control back.
    this.output.write("\x1b[?25h"); // restore cursor
    this.resolver?.(result);
    this.resolver = null;
  }
}

// ============================================================
// ANSI helpers — local copies so the picker has zero ui.ts
// coupling, since it writes raw escapes directly for cursor + line
// control and needs to match isTTY semantics on its own output.
// ============================================================

function dim(output: NodeJS.WriteStream, s: string): string {
  return output.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

function bold(output: NodeJS.WriteStream, s: string): string {
  return output.isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}

function cyan(output: NodeJS.WriteStream, s: string): string {
  return output.isTTY ? `\x1b[36m${s}\x1b[0m` : s;
}

function labelOf<T>(opt: PickerOption<T>): string {
  return opt.label;
}

function padOrTrunc(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// ============================================================
// Single-select raw-mode picker
// ============================================================

/**
 * Like {@link MultiSelectPicker} but for "pick one" prompts. Same
 * keyboard idiom — Up/Down to move, Enter to confirm — but there's
 * no toggle (space does nothing), and Enter on the highlighted row
 * is the submit gesture.
 *
 * Used for source-onboard's transport selection, the wizard's
 * `choices`-bearing prompts, and anywhere else a one-of menu is
 * needed in the REPL.
 */
export interface SingleSelectOption<T> {
  label: string;
  value: T;
  note?: string;
  /**
   * Marks an option as the default. The highlight starts on this
   * one and the user can press Enter without moving.
   */
  recommended?: boolean;
}

export type SingleSelectResult<T> =
  | { type: "submitted"; value: T }
  | { type: "cancelled" };

export interface SingleSelectOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  maxVisible?: number;
}

export class SingleSelectPicker<T> {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly question: string;
  private readonly options: SingleSelectOption<T>[];

  private highlight: number;
  private filter = "";
  private filterMode = false;
  private hasRendered = false;
  private finished = false;
  private resolver: ((r: SingleSelectResult<T>) => void) | null = null;
  private dataHandler: ((chunk: Buffer | string) => void) | null = null;
  private optsMaxVisible: number;

  private get maxVisible(): number {
    const rows = (this.output.rows ?? 24) | 0;
    return Math.max(3, Math.min(this.optsMaxVisible, rows - 6));
  }

  constructor(
    question: string,
    options: SingleSelectOption<T>[],
    opts: SingleSelectOptions = {}
  ) {
    this.question = question;
    this.options = options;
    this.input = opts.input ?? (process.stdin as NodeJS.ReadStream);
    this.output = opts.output ?? (process.stdout as NodeJS.WriteStream);
    this.optsMaxVisible = opts.maxVisible ?? 10;
    // Start on the recommended option, or the first one.
    const recIdx = options.findIndex((o) => o.recommended);
    this.highlight = recIdx >= 0 ? recIdx : 0;
  }

  run(): Promise<SingleSelectResult<T>> {
    if (this.options.length === 0) {
      return Promise.resolve({ type: "cancelled" });
    }
    return new Promise<SingleSelectResult<T>>((resolve) => {
      this.resolver = resolve;
      try {
        this.input.setRawMode?.(true);
      } catch {
        /* not a TTY */
      }
      this.input.resume();
      this.input.setEncoding("utf8");
      this.dataHandler = (chunk) => this.onData(String(chunk));
      this.input.on("data", this.dataHandler);
      this.input.once("end", () => this.finish({ type: "cancelled" }));
      this.render();
    });
  }

  private onData(chunk: string): void {
    if (this.finished) return;
    for (const key of decodeKeys(chunk)) {
      if (this.finished) return;
      this.dispatch(key);
    }
  }

  private dispatch(key: Key): void {
    if (key.type === "ctrl-c" || key.type === "ctrl-d") {
      return this.cancel();
    }

    if (this.filterMode) {
      return this.dispatchInFilterMode(key);
    }

    switch (key.type) {
      case "up":
        this.highlight = this.moveHighlight(-1);
        return this.render();
      case "down":
        this.highlight = this.moveHighlight(1);
        return this.render();
      case "char":
        if (key.value === "/") {
          this.filterMode = true;
          this.filter = "";
          return this.render();
        }
        // Single-letter shortcut: jump to the first option whose
        // label starts with that letter. Same idea as filesystem
        // navigators — type 'n' to land on "notion".
        if (/^[a-zA-Z0-9]$/.test(key.value)) {
          const idx = this.options.findIndex((o, i) =>
            o.label.toLowerCase().startsWith(key.value.toLowerCase()) &&
            i !== this.highlight
          );
          if (idx >= 0) {
            this.highlight = idx;
            return this.render();
          }
        }
        return;
      case "enter":
        return this.submit();
      case "escape":
        return this.cancel();
      default:
        return;
    }
  }

  private dispatchInFilterMode(key: Key): void {
    switch (key.type) {
      case "escape":
        this.filter = "";
        this.filterMode = false;
        this.highlight = this.firstVisibleIndex();
        return this.render();
      case "enter":
        // Submit straight from filter mode — the user has narrowed
        // and now picks the highlighted row.
        return this.submit();
      case "backspace":
        this.filter = this.filter.slice(0, -1);
        if (!this.isVisible(this.highlight)) {
          this.highlight = this.firstVisibleIndex();
        }
        return this.render();
      case "char":
        this.filter += key.value;
        if (!this.isVisible(this.highlight)) {
          this.highlight = this.firstVisibleIndex();
        }
        return this.render();
      case "up":
        this.highlight = this.moveHighlight(-1);
        return this.render();
      case "down":
        this.highlight = this.moveHighlight(1);
        return this.render();
      default:
        return;
    }
  }

  private moveHighlight(step: number): number {
    if (this.options.length === 0) return -1;
    let i = this.highlight;
    for (let n = 0; n < this.options.length; n++) {
      i = (i + step + this.options.length) % this.options.length;
      if (this.isVisible(i)) return i;
    }
    return this.highlight;
  }

  private firstVisibleIndex(): number {
    for (let i = 0; i < this.options.length; i++) {
      if (this.isVisible(i)) return i;
    }
    return 0;
  }

  private isVisible(index: number): boolean {
    if (!this.filter) return true;
    const opt = this.options[index];
    const needle = this.filter.toLowerCase();
    return (
      opt.label.toLowerCase().includes(needle) ||
      (opt.note?.toLowerCase().includes(needle) ?? false)
    );
  }

  private submit(): void {
    if (this.highlight < 0 || !this.isVisible(this.highlight)) {
      // No valid selection — refuse to submit.
      return;
    }
    const value = this.options[this.highlight].value;
    this.clearRender();
    // See note on echoFinal in MultiSelectPicker — we don't repeat
    // the question text here because clearRender may not have
    // wiped it (terminal scroll), and a double-print of the
    // question looks broken. A bare `→ value` is unambiguous.
    this.output.write(
      `  ${cyan(this.output, "→")} ${this.options[this.highlight].label}\n`
    );
    this.finish({ type: "submitted", value });
  }

  private cancel(): void {
    this.clearRender();
    this.output.write("\x1b[?25h");
    this.finish({ type: "cancelled" });
  }

  private clearRender(): void {
    if (!this.hasRendered) return;
    this.output.write("\r\x1b[0J");
  }

  private render(): void {
    this.clearRender();
    this.output.write("\x1b[?25l");
    this.output.write(this.question);
    if (this.filterMode) {
      this.output.write("  " + dim(this.output, `(filter: ${this.filter}_)`));
    } else if (this.filter) {
      this.output.write("  " + dim(this.output, `(filter: ${this.filter})`));
    }
    this.output.write("\n");

    const visibleIndices = this.computeVisibleWindow();
    const labelWidth = Math.min(
      40,
      visibleIndices.reduce(
        (m, i) => Math.max(m, this.options[i].label.length),
        0
      )
    );
    const termWidth = this.output.columns ?? 80;
    const fixedWidth = 2 + 2 + labelWidth + 2;
    const maxNoteWidth = Math.max(10, termWidth - fixedWidth - 1);

    let rowsDrawn = 0;
    for (const i of visibleIndices) {
      const opt = this.options[i];
      const isHighlighted = i === this.highlight;
      const marker = isHighlighted ? cyan(this.output, "❯") : " ";
      const labelText = padOrTrunc(opt.label, labelWidth);
      const label = isHighlighted ? bold(this.output, labelText) : labelText;
      let note = opt.note ?? "";
      if (note.length > maxNoteWidth) {
        note = note.slice(0, Math.max(1, maxNoteWidth - 1)) + "…";
      }
      const noteOut = note ? "  " + dim(this.output, note) : "";
      this.output.write(`\n  ${marker} ${label}${noteOut}`);
      rowsDrawn++;
    }
    if (rowsDrawn === 0) {
      this.output.write(
        "\n  " + dim(this.output, "(no matches — backspace to edit the filter)")
      );
      rowsDrawn = 1;
    }
    const totalVisible = this.allVisibleIndices().length;
    if (visibleIndices.length < totalVisible) {
      this.output.write(
        "\n  " +
          dim(
            this.output,
            `(showing ${visibleIndices.length} of ${totalVisible} — ↑↓ to scroll)`
          )
      );
      rowsDrawn++;
    }

    this.output.write("\n  " + this.helpLine());
    rowsDrawn++;

    this.output.write(`\x1b[${rowsDrawn + 1}A`);
    this.output.write("\r");
    this.hasRendered = true;
  }

  private helpLine(): string {
    const colorize = (s: string) => dim(this.output, s);
    if (this.filterMode) {
      return colorize("type to filter · ↵ confirm · esc clear · ⎈c cancel");
    }
    return colorize("↑↓ navigate · ↵ confirm · / filter · esc cancel");
  }

  private computeVisibleWindow(): number[] {
    const all = this.allVisibleIndices();
    const max = this.maxVisible;
    if (all.length <= max) return all;
    const hlPos = all.indexOf(this.highlight);
    const half = Math.floor(max / 2);
    let start = Math.max(0, hlPos - half);
    let end = start + max;
    if (end > all.length) {
      end = all.length;
      start = end - max;
    }
    return all.slice(start, end);
  }

  private allVisibleIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.options.length; i++) {
      if (this.isVisible(i)) out.push(i);
    }
    return out;
  }

  private finish(result: SingleSelectResult<T>): void {
    if (this.finished) return;
    this.finished = true;
    if (this.dataHandler) {
      this.input.off("data", this.dataHandler);
      this.dataHandler = null;
    }
    try {
      this.input.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    // See MultiSelectPicker.finish — do NOT pause stdin here.
    // Caller (wizard / source-onboard) keeps reading via its
    // PromptSession; pausing would strangle the next ask().
    this.output.write("\x1b[?25h");
    this.resolver?.(result);
    this.resolver = null;
  }
}

// ============================================================
// Top-level helper: TTY → raw-mode picker, non-TTY → line fallback
// ============================================================

/**
 * Show a multi-select picker. Returns the selected values or `null`
 * if the user cancelled.
 *
 *   - On a real TTY: uses the raw-mode {@link MultiSelectPicker}.
 *     User navigates with arrows, toggles with space, submits with
 *     Enter. The natural shape.
 *   - Otherwise (piped stdin, tests, CI): falls back to the
 *     line-based `PromptSession.pickMany` so scripts and tests can
 *     still drive the flow with `1` / `done` / `all`.
 *
 * Falling back rather than refusing is important: existing test
 * suites pipe answers in. Forcing raw mode there would break them
 * without adding any value (the user-facing UX is the same).
 *
 * `fallbackSession`, when non-null, lets the line-based fallback
 * reuse an existing PromptSession. Required in non-TTY REPL mode
 * (otherwise a second readline interface would race the first for
 * stdin — see `repl.ts` for the full story).
 */
export async function pickMany<T>(
  question: string,
  options: PickerOption<T>[],
  fallbackSession: import("./prompt.js").PromptSession | null = null
): Promise<T[] | null> {
  const isTty =
    (process.stdin as NodeJS.ReadStream).isTTY === true &&
    (process.stdout as NodeJS.WriteStream).isTTY === true;

  if (isTty) {
    const picker = new MultiSelectPicker(question, options);
    const result = await picker.run();
    return result.type === "submitted" ? result.values : null;
  }

  // Non-TTY fallback: line-based.
  const { PromptSession } = await import("./prompt.js");
  let session = fallbackSession;
  let mustClose = false;
  if (!session) {
    session = new PromptSession();
    mustClose = true;
  }
  try {
    return await session.pickMany(question, options);
  } finally {
    if (mustClose) session.close();
  }
}

/**
 * Show a single-select picker. Returns the chosen value or `null`
 * if cancelled.
 *
 *   - TTY: {@link SingleSelectPicker} (arrow nav + Enter).
 *   - non-TTY: line-based fallback via PromptSession.pickOne.
 *
 * Same `fallbackSession` semantics as {@link pickMany}: pass the
 * REPL's fallback session in non-TTY mode so the helper doesn't
 * race a second readline interface for stdin.
 */
export async function pickOne<T>(
  question: string,
  options: SingleSelectOption<T>[],
  fallbackSession: import("./prompt.js").PromptSession | null = null
): Promise<T | null> {
  const isTty =
    (process.stdin as NodeJS.ReadStream).isTTY === true &&
    (process.stdout as NodeJS.WriteStream).isTTY === true;

  if (isTty) {
    const picker = new SingleSelectPicker(question, options);
    const result = await picker.run();
    return result.type === "submitted" ? result.value : null;
  }

  const { PromptSession } = await import("./prompt.js");
  let session = fallbackSession;
  let mustClose = false;
  if (!session) {
    session = new PromptSession();
    mustClose = true;
  }
  try {
    return await session.pickOne(question, options);
  } finally {
    if (mustClose) session.close();
  }
}

