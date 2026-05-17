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

interface QueuedResolver {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export class PromptSession {
  readonly io: PromptIO;
  private readonly rl: readline.Interface;
  private readonly buffered: string[] = [];
  private readonly waiters: QueuedResolver[] = [];
  private closed = false;
  private streamEnded = false;

  constructor(io: PromptIO = { input: process.stdin, output: process.stdout }) {
    this.io = io;
    this.rl = readline.createInterface({
      input: io.input,
      output: io.output,
      // We never want readline to echo / move the cursor itself —
      // our prompts already print the question line.
      terminal: false,
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
    this.io.output.write(`${question}${suffix}: `);
    const line = await this.nextLine();
    // When stdin is piped (no terminal echo), the user's typed
    // newline doesn't appear in our output, so subsequent prompts
    // run on the same visible line. Add the newline ourselves when
    // stdout is non-TTY (matches the visual effect of an interactive
    // session) — TTY users get the same visual either way.
    const isTty = (this.io.output as NodeJS.WriteStream).isTTY === true;
    if (!isTty) this.io.output.write("\n");
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
}
