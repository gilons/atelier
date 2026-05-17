import { decodeKeys, applyEdit, acceptSuggestion, type Key, type LineState } from "./input-keys.js";
import type { Completer, Suggestion } from "./suggestion.js";

/**
 * Raw-mode interactive line reader with as-you-type suggestions.
 *
 * The UX target is a Claude-Code / fish-shell-style inline menu:
 *
 *     atelier ❯ /sou
 *       › /source            — Manage documentation sources
 *         /source list       — List registered documentation sources
 *         /source onboard    — Interactively register a documentation source
 *         /source remove     — Unregister a documentation source by id
 *       ↑↓ navigate · ⇥/→ accept · ↵ submit · esc dismiss
 *
 * The menu refreshes on every keystroke. Up/down highlight a row,
 * Tab or → accept the highlight (replace the partial), and Enter
 * submits the line (if a row is highlighted, accept it first).
 *
 * Only used on a real TTY. Piped/non-TTY input falls back to the
 * line-based `PromptSession.ask()` — completion isn't useful
 * without a terminal you can rewrite.
 *
 * Implementation notes:
 *   - Renders are tracked by line count; each refresh moves the
 *     cursor up N lines and clears them with `\x1b[2K\r`, then
 *     redraws. ANSI-only, no curses-style screen library.
 *   - Cursor hidden during render, restored at the end so the
 *     visible cursor sits at the right column on the prompt line.
 *   - Multi-line user input is intentionally NOT supported in v1;
 *     a long line wraps but Up/Down treat the wrap as a single
 *     logical row. Add a real wrap-aware renderer if specs get
 *     long enough to need it.
 */

export interface InputReaderOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  prompt: string;
  completer: Completer;
  /** Max suggestions visible at once. Defaults to 8. */
  maxVisible?: number;
  /** Inject history for tests. Production REPL passes an empty array. */
  history?: string[];
}

export type InputResult =
  | { type: "submitted"; line: string }
  /** Ctrl-C / Ctrl-D / stream end with empty buffer. */
  | { type: "aborted" };

export class InputReader {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly prompt: string;
  private readonly completer: Completer;
  private readonly maxVisible: number;
  private readonly history: string[];

  private state: LineState = { buffer: "", cursor: 0 };
  private suggestions: Suggestion[] = [];
  private span = "";
  private highlight = -1;
  private historyIndex = -1; // -1 = current line; 0+ indexes history from newest
  /**
   * True once we've drawn at least one render. Before that, clearRender
   * is a no-op so we don't `\x1b[0J` over the welcome banner that was
   * printed before our prompt.
   */
  private hasRendered = false;
  private resolver: ((r: InputResult) => void) | null = null;
  private dataHandler: ((chunk: Buffer | string) => void) | null = null;
  private finished = false;

  constructor(opts: InputReaderOptions) {
    this.input = opts.input;
    this.output = opts.output;
    this.prompt = opts.prompt;
    this.completer = opts.completer;
    this.maxVisible = opts.maxVisible ?? 8;
    this.history = opts.history ?? [];
  }

  /**
   * Take over stdin in raw mode and resolve when the user submits
   * a line, presses Ctrl-C, or the stream ends.
   */
  read(): Promise<InputResult> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      try {
        this.input.setRawMode?.(true);
      } catch {
        /* not a TTY — the REPL shouldn't call us in that case, but
           don't blow up if it does. */
      }
      this.input.resume();
      this.input.setEncoding("utf8");
      this.dataHandler = (chunk: Buffer | string) => this.handle(String(chunk));
      this.input.on("data", this.dataHandler);
      const onEnd = () => this.finish({ type: "aborted" });
      this.input.once("end", onEnd);

      this.refresh();
    });
  }

  // ============================================================
  // Keystroke handling
  // ============================================================

  private handle(chunk: string): void {
    if (this.finished) return;
    const keys = decodeKeys(chunk);
    for (const key of keys) {
      if (this.finished) return;
      this.dispatch(key);
    }
  }

  private dispatch(key: Key): void {
    switch (key.type) {
      case "ctrl-c":
        // Abort cleanly. Print a newline so the prompt looks clean
        // after the cancellation.
        this.clearRender();
        this.output.write("\n");
        return this.finish({ type: "aborted" });

      case "ctrl-d":
        if (this.state.buffer.length === 0) {
          this.clearRender();
          this.output.write("\n");
          return this.finish({ type: "aborted" });
        }
        // Otherwise treat as delete-forward — Unix convention.
        this.state = applyEdit(this.state, { type: "delete-forward" });
        return this.refresh();

      case "enter": {
        // If a suggestion is highlighted, accept it first.
        if (this.highlight >= 0 && this.highlight < this.suggestions.length) {
          this.state = acceptSuggestion(
            this.state,
            this.span,
            this.suggestions[this.highlight].value
          );
          this.highlight = -1;
          this.refresh();
          return;
        }
        this.clearRender();
        // Echo the final line so the scrollback shows what was run.
        this.output.write(`${this.prompt}${this.state.buffer}\n`);
        return this.finish({ type: "submitted", line: this.state.buffer });
      }

      case "tab":
      case "right": {
        // Accept the highlighted suggestion (or the first one if
        // none highlighted yet).
        if (this.suggestions.length === 0) {
          // Plain right-arrow with no suggestions = cursor move.
          if (key.type === "right") {
            this.state = applyEdit(this.state, key);
            return this.refresh({ skipCompleter: true });
          }
          return; // Tab with no suggestions: no-op.
        }
        const idx = this.highlight < 0 ? 0 : this.highlight;
        this.state = acceptSuggestion(this.state, this.span, this.suggestions[idx].value);
        this.highlight = -1;
        return this.refresh();
      }

      case "up":
        if (this.suggestions.length > 0) {
          this.highlight =
            this.highlight <= 0 ? this.suggestions.length - 1 : this.highlight - 1;
          return this.refresh({ skipCompleter: true });
        }
        // No suggestions — walk history.
        return this.historyPrev();

      case "down":
        if (this.suggestions.length > 0) {
          this.highlight =
            this.highlight < 0 || this.highlight >= this.suggestions.length - 1
              ? 0
              : this.highlight + 1;
          return this.refresh({ skipCompleter: true });
        }
        return this.historyNext();

      case "escape":
        // Dismiss the suggestion menu for this keystroke. The next
        // edit will re-fetch suggestions, so escape is a "shut up
        // for a moment" gesture, not a hard disable.
        this.suggestions = [];
        this.highlight = -1;
        return this.refresh({ skipCompleter: true });

      case "left":
      case "home":
      case "end":
      case "ctrl-a":
      case "ctrl-e":
        // Pure cursor moves — don't re-run completer.
        this.state = applyEdit(this.state, key);
        return this.refresh({ skipCompleter: true });

      case "char":
      case "backspace":
      case "delete-forward":
      case "ctrl-k":
      case "ctrl-u":
      case "ctrl-w":
        this.state = applyEdit(this.state, key);
        this.highlight = -1; // any edit resets the highlighted row
        return this.refresh();

      case "unknown":
        return;
    }
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    const next = Math.min(this.history.length - 1, this.historyIndex + 1);
    this.historyIndex = next;
    const entry = this.history[this.history.length - 1 - next];
    this.state = { buffer: entry, cursor: entry.length };
    this.refresh();
  }

  private historyNext(): void {
    if (this.historyIndex <= 0) {
      this.historyIndex = -1;
      this.state = { buffer: "", cursor: 0 };
      return this.refresh();
    }
    this.historyIndex--;
    const entry = this.history[this.history.length - 1 - this.historyIndex];
    this.state = { buffer: entry, cursor: entry.length };
    this.refresh();
  }

  // ============================================================
  // Render
  // ============================================================

  /**
   * Re-run the completer, then clear and redraw the prompt + menu.
   */
  private refresh(opts: { skipCompleter?: boolean } = {}): void {
    if (!opts.skipCompleter) {
      const result = this.completer(this.state.buffer, this.state.cursor);
      this.span = result.span;
      this.suggestions = result.items;
      if (this.highlight >= this.suggestions.length) this.highlight = -1;
    }
    this.clearRender();
    this.render();
  }

  /**
   * Erase the prompt line and everything we drew below it.
   *
   * After every `render()` the cursor sits on the prompt line at the
   * user's logical column. To clear, we move to column 0 of that line
   * (`\r`) and then emit `\x1b[0J` — "erase from cursor to end of
   * screen". This wipes the prompt line + any suggestion menu we drew
   * underneath in one shot, without any line counting that can drift
   * after an off-by-one.
   *
   * Crucially, this only erases things *at or below* the cursor —
   * everything above (the welcome banner, prior REPL output) is left
   * alone, which fixes the "welcome message vanishes on first
   * keystroke" bug.
   *
   * No-op before the very first render so we don't `\x1b[0J` over the
   * welcome banner that was printed just before us.
   */
  private clearRender(): void {
    if (!this.hasRendered) return;
    this.output.write("\r\x1b[0J");
  }

  private render(): void {
    const items = this.visibleSuggestions();
    // Hide the cursor during the multi-step draw so the user doesn't
    // see it skipping across the menu lines.
    this.output.write("\x1b[?25l");

    // 1) Prompt line — written as one piece, cursor lands at end of buffer.
    this.output.write(this.prompt + this.state.buffer);

    if (items.length > 0) {
      // 2) Suggestion menu beneath the prompt. Each suggestion gets
      //    its own line. We always lead with `\n` so we never
      //    accidentally write a suggestion ON the prompt line.
      const labelWidth = Math.min(
        40,
        items.reduce((m, s) => Math.max(m, displayOf(s.suggestion).length), 0)
      );
      for (const item of items) {
        const highlighted = item.absoluteIndex === this.highlight;
        const marker = highlighted ? cyan("›") : " ";
        const label = pad(displayOf(item.suggestion), labelWidth);
        const labelOut = highlighted ? bold(label) : label;
        const desc = item.suggestion.description
          ? "  " + dim("— " + item.suggestion.description)
          : "";
        this.output.write(`\n  ${marker} ${labelOut}${desc}`);
      }
      // 3) Help line.
      this.output.write(
        "\n  " + dim("↑↓ navigate · ⇥/→ accept · ↵ submit · esc dismiss")
      );

      // Walk the cursor back up to the prompt line. We wrote exactly
      // `items.length + 1` newlines (one per suggestion + one for the
      // help line), so the cursor is that many lines below the prompt.
      const linesBelow = items.length + 1;
      this.output.write(`\x1b[${linesBelow}A`);
    }

    // Park the cursor at the user's logical column on the prompt line.
    this.output.write("\r");
    const col = visibleWidth(this.prompt) + this.state.cursor;
    if (col > 0) this.output.write(`\x1b[${col}C`);

    // Show the cursor again now that we're parked.
    this.output.write("\x1b[?25h");
    this.hasRendered = true;
  }

  /**
   * Clip the suggestion list to fit `maxVisible`, centering on the
   * highlighted row so the user always sees what's selected.
   */
  private visibleSuggestions(): Array<{ suggestion: Suggestion; absoluteIndex: number }> {
    const total = this.suggestions.length;
    if (total === 0) return [];
    const max = this.maxVisible;
    if (total <= max) {
      return this.suggestions.map((s, i) => ({ suggestion: s, absoluteIndex: i }));
    }
    // Scroll window around `highlight`.
    let start = Math.max(0, this.highlight - Math.floor(max / 2));
    let end = start + max;
    if (end > total) {
      end = total;
      start = total - max;
    }
    return this.suggestions
      .slice(start, end)
      .map((s, i) => ({ suggestion: s, absoluteIndex: start + i }));
  }

  // ============================================================
  // Teardown
  // ============================================================

  private finish(result: InputResult): void {
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
    this.input.pause();
    // Make absolutely sure the cursor is visible after we bail.
    this.output.write("\x1b[?25h");
    this.resolver?.(result);
    this.resolver = null;
  }
}

// ============================================================
// Small string helpers — kept local so the input reader has zero
// ui.ts coupling (it writes raw ANSI directly because timing and
// cursor moves matter).
// ============================================================

function displayOf(s: Suggestion): string {
  return s.display ?? s.value;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

/**
 * Visible-width approximation — strips ANSI escape sequences so the
 * cursor math after a colored prompt lands on the right column.
 * Doesn't account for double-width emoji; the prompt is ASCII so
 * it doesn't matter today.
 */
function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
