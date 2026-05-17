import * as readline from "node:readline";

/**
 * Minimal interactive prompt helpers, dependency-free.
 *
 * Implementation note: `readline.question()` does not work reliably
 * with piped stdin — once the stream EOFs, queued lines that were
 * pre-supplied (`printf "a\nb\nc\n" | cli`) get swallowed and the
 * second `question()` hangs forever. So we drive readline by its
 * `line` event and queue lines ourselves, which gives consistent
 * behavior across TTY input, piped input, and tests.
 *
 * Sessions own their underlying interface. Create one with
 * `new PromptSession()` at the top of an interactive flow, thread it
 * through every prompt call, and `close()` at the end.
 */

export interface PromptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface PromptSessionOptions {
  io?: PromptIO;
}

interface QueuedResolver {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export class PromptSession {
  readonly io: PromptIO;
  private readonly rl: readline.Interface;
  /** Is stdin actually interactive? Drives terminal-mode + completion. */
  private readonly isTty: boolean;
  private readonly buffered: string[] = [];
  private readonly waiters: QueuedResolver[] = [];
  private closed = false;
  private streamEnded = false;

  constructor(opts: PromptSessionOptions = {}) {
    this.io = opts.io ?? { input: process.stdin, output: process.stdout };
    this.isTty = (this.io.input as NodeJS.ReadStream).isTTY === true;
    // PromptSession handles linear question/answer flows (onboarding
    // steps, multi-select sub-prompts). The REPL's main prompt uses
    // a separate `InputReader` for inline as-you-type suggestions.
    // Terminal mode here unlocks history + line editing for free.
    this.rl = readline.createInterface({
      input: this.io.input,
      output: this.io.output,
      terminal: this.isTty,
    });
    this.rl.on("line", (line) => {
      const w = this.waiters.shift();
      if (w) w.resolve(line);
      else this.buffered.push(line);
    });
    this.rl.on("close", () => {
      this.streamEnded = true;
      // Reject any waiters still hanging — better than deadlocking.
      while (this.waiters.length > 0) {
        const w = this.waiters.shift()!;
        w.reject(new Error("input stream ended before answering"));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
  }

  /**
   * Pause the underlying readline.Interface so raw-mode consumers
   * (the multi/single-select pickers) can take exclusive control of
   * stdin without contending with readline's keypress handlers.
   *
   * Without this, readline keeps its `data` listeners attached and
   * eats bytes the picker expects to see — symptoms include the
   * picker submitting an empty selection immediately because
   * readline forwarded a stale newline. Pair every `suspend()` with
   * a `resume()` in a `finally` block.
   */
  suspend(): void {
    this.rl.pause();
  }

  /** Counterpart to {@link suspend}. Safe to call repeatedly. */
  resume(): void {
    if (this.closed) return;
    this.rl.resume();
  }

  private nextLine(): Promise<string> {
    if (this.buffered.length > 0) {
      return Promise.resolve(this.buffered.shift()!);
    }
    if (this.streamEnded) {
      return Promise.reject(new Error("input stream ended before answering"));
    }
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Ask a free-text question. Returns the user's input (trimmed). */
  async ask(question: string, opts: { default?: string } = {}): Promise<string> {
    const suffix = opts.default ? ` [${opts.default}]` : "";
    const promptText = `${question}${suffix}: `;
    if (this.isTty) {
      // In terminal mode, hand the prompt to readline so it owns line
      // redraw, history navigation (↑/↓), and tab completion. Calling
      // setPrompt+prompt here is required — manually writing the prompt
      // breaks the redraw cycle.
      this.rl.setPrompt(promptText);
      this.rl.prompt();
    } else {
      this.io.output.write(promptText);
    }
    const line = await this.nextLine();
    // When stdin is piped (no terminal echo), the user's typed
    // newline doesn't appear in our output, so subsequent prompts
    // run on the same visible line. Add the newline ourselves when
    // stdout is non-TTY (matches the visual effect of an interactive
    // session) — TTY users get the same visual either way.
    const isTtyOut = (this.io.output as NodeJS.WriteStream).isTTY === true;
    if (!isTtyOut) this.io.output.write("\n");
    const trimmed = line.trim();
    return trimmed.length === 0 && opts.default ? opts.default : trimmed;
  }

  /**
   * Ask for a secret. Masks input echo with `*` in TTY mode. Falls
   * back to plain `ask()` when stdin isn't a TTY (CI, tests, piped
   * input) so scripted answers still work.
   */
  async askSecret(question: string): Promise<string> {
    const stdin = this.io.input as NodeJS.ReadStream;
    if (stdin.isTTY !== true) {
      return this.ask(question);
    }
    // TTY path: temporarily take over raw input so we can mask `*`.
    return new Promise((resolve) => {
      this.io.output.write(`${question}: `);
      this.rl.pause();
      stdin.setRawMode?.(true);
      stdin.resume();
      let value = "";
      const onData = (data: Buffer) => {
        const s = data.toString("utf8");
        for (const ch of s) {
          if (ch === "\n" || ch === "\r") {
            stdin.removeListener("data", onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            this.io.output.write("\n");
            this.rl.resume();
            resolve(value);
            return;
          }
          if (ch === "") {
            process.exit(130);
          }
          if (ch === "" || ch === "\b") {
            if (value.length > 0) {
              value = value.slice(0, -1);
              this.io.output.write("\b \b");
            }
            continue;
          }
          value += ch;
          this.io.output.write("*");
        }
      };
      stdin.on("data", onData);
    });
  }

  async pickOne<T>(
    question: string,
    options: Array<{ label: string; value: T; note?: string; recommended?: boolean }>
  ): Promise<T> {
    this.io.output.write(`${question}\n`);
    const recIdx = options.findIndex((o) => o.recommended);
    options.forEach((opt, i) => {
      const marker = opt.recommended ? " ←" : "";
      this.io.output.write(`  [${i + 1}] ${opt.label}${marker}\n`);
      if (opt.note) this.io.output.write(`      ${opt.note}\n`);
    });
    while (true) {
      const raw = await this.ask("Choose a number", {
        default: recIdx >= 0 ? String(recIdx + 1) : undefined,
      });
      const idx = parseInt(raw, 10);
      if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
        return options[idx - 1].value;
      }
      this.io.output.write(`  Please enter a number between 1 and ${options.length}.\n`);
    }
  }

  async confirm(question: string, opts: { default?: boolean } = {}): Promise<boolean> {
    const def = opts.default ?? true;
    const suffix = def ? "Y/n" : "y/N";
    const raw = (await this.ask(`${question} (${suffix})`)).toLowerCase();
    if (raw === "") return def;
    if (raw.startsWith("y")) return true;
    if (raw.startsWith("n")) return false;
    return def;
  }

  /**
   * Multi-select picker. Renders the options, accepts toggle commands
   * one prompt at a time, supports filter/search, and returns the
   * chosen subset when the user says "done" (or just enter).
   *
   * Input grammar (one per line):
   *   - `1`, `1,3,5`, `1-4`  → toggle those by index
   *   - `all`               → select every visible option
   *   - `none`              → deselect everything
   *   - `/<query>`           → filter the list to options whose label
   *                            contains the query (case-insensitive);
   *                            `/` alone clears the filter
   *   - `done` or empty     → finish, return the selected subset
   *   - `quit`              → return null (caller treats as cancel)
   *
   * Designed for ≤ ~50 options. For very long lists, paginate the
   * caller side.
   */
  async pickMany<T>(
    question: string,
    options: Array<{
      label: string;
      value: T;
      note?: string;
      /** Visually mark already-selected items (e.g. already registered). */
      preselected?: boolean;
      /** Visually mark unactionable items (e.g. already registered). */
      disabled?: boolean;
    }>
  ): Promise<T[] | null> {
    const selected = new Set<number>();
    options.forEach((o, i) => {
      if (o.preselected) selected.add(i);
    });
    let filter = "";
    while (true) {
      this.renderMultiSelect(question, options, selected, filter);
      const raw = (await this.ask("  Selection")).trim();
      if (raw === "" || raw.toLowerCase() === "done") {
        // Drop disabled items from the result — they're informational.
        return [...selected]
          .filter((i) => !options[i].disabled)
          .map((i) => options[i].value);
      }
      if (raw.toLowerCase() === "quit" || raw.toLowerCase() === "cancel") {
        return null;
      }
      if (raw.toLowerCase() === "all") {
        options.forEach((o, i) => {
          if (!o.disabled && matchesFilter(o.label, filter)) selected.add(i);
        });
        continue;
      }
      if (raw.toLowerCase() === "none") {
        selected.clear();
        continue;
      }
      if (raw.startsWith("/")) {
        filter = raw.slice(1).trim();
        continue;
      }
      // Toggle by index/range.
      const indices = parseToggleSpec(raw, options.length);
      if (indices.length === 0) {
        this.io.output.write(
          `  ${pad("invalid input")}— try numbers (1,3-5), 'all', 'none', '/text', 'done', or 'quit'\n`
        );
        continue;
      }
      for (const i of indices) {
        if (options[i].disabled) continue;
        if (selected.has(i)) selected.delete(i);
        else selected.add(i);
      }
    }
  }

  private renderMultiSelect<T>(
    question: string,
    options: Array<{
      label: string;
      value: T;
      note?: string;
      preselected?: boolean;
      disabled?: boolean;
    }>,
    selected: Set<number>,
    filter: string
  ): void {
    // Match the isTTY check used by ui.ts so NO_COLOR / piped output
    // doesn't get raw ANSI escape sequences.
    const isTty = (this.io.output as NodeJS.WriteStream).isTTY === true;
    const dim = isTty ? (s: string) => `\x1b[2m${s}\x1b[0m` : (s: string) => s;
    this.io.output.write("\n");
    this.io.output.write(`${question}\n`);
    if (filter) this.io.output.write(`  ${dim(`(filter: /${filter})`)}\n`);
    const idxWidth = String(options.length).length;
    let visible = 0;
    options.forEach((opt, i) => {
      if (!matchesFilter(opt.label, filter)) return;
      visible++;
      const num = String(i + 1).padStart(idxWidth);
      const mark = opt.disabled ? " - " : selected.has(i) ? " ✓ " : " · ";
      const labelText = opt.disabled ? dim(opt.label) : opt.label;
      const noteText = opt.note ? `  ${dim(opt.note)}` : "";
      this.io.output.write(`  [${num}]${mark}${labelText}${noteText}\n`);
    });
    if (visible === 0) {
      this.io.output.write(`  ${dim(`(no options match /${filter})`)}\n`);
    }
    this.io.output.write(
      `  ${dim("[1,3-5] toggle")}  ${dim("[/text] filter")}  ${dim("[all]")}  ${dim("[none]")}  ${dim("[done]")}  ${dim("[quit]")}\n`
    );
  }
}

function pad(s: string): string {
  return s.padEnd(14) + " ";
}


function matchesFilter(label: string, filter: string): boolean {
  if (!filter) return true;
  return label.toLowerCase().includes(filter.toLowerCase());
}

function parseToggleSpec(raw: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(\d+)-(\d+)$/.exec(trimmed);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
      for (let i = lo; i <= hi; i++) {
        if (i >= 1 && i <= max) out.add(i - 1);
      }
      continue;
    }
    const single = parseInt(trimmed, 10);
    if (!Number.isFinite(single)) return [];
    if (single >= 1 && single <= max) out.add(single - 1);
    else return [];
  }
  return [...out];
}
