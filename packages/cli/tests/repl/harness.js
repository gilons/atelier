import { spawn } from "@homebridge/node-pty-prebuilt-multiarch";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * PTY-backed test harness for atelier's interactive REPL.
 *
 * Why a PTY (not piped stdin)?
 *
 *   Most of the interactive flow lives in raw-mode pickers
 *   (`MultiSelectPicker`, `SingleSelectPicker`), readline-based
 *   `PromptSession`, and the inline-suggestion `InputReader`. All
 *   three only run on `isTTY === true`. Piping stdin disables them
 *   and the test sees a different code path than a human would —
 *   exactly the wrong place to look for raw-mode handoff bugs.
 *
 *   node-pty gives us a real PTY pair: atelier runs as if it were
 *   in a terminal, sees `isTTY: true`, raw mode toggles work, line
 *   discipline applies. That's the only way to catch the class of
 *   bugs we've been hitting (drain eating chars, secret echoing in
 *   plain text, picker not rendering, etc.).
 *
 * The API is deliberately small. Tests should read like a
 * scripted user session:
 *
 *     const a = await launchAtelier({ cwd });
 *     await a.expect(/atelier ❯/);
 *     await a.send("/source onboard sharepoint\r");
 *     await a.expect("Authenticate via?");
 *     await a.send("\r");
 *     await a.close();
 *
 * If something doesn't match within the default timeout, the call
 * rejects with the accumulated screen buffer in the message — so
 * test failures show what atelier was actually displaying when
 * the matcher gave up.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ATELIER_BIN = path.join(
  REPO_ROOT,
  "packages",
  "cli",
  "dist",
  "index.js"
);

/**
 * Default per-match timeout. Real atelier interactions take a few
 * hundred ms (token mint, fs scans). 5s is comfortable padding;
 * tests can override per-call.
 */
const DEFAULT_TIMEOUT_MS = 5000;

/** Trailing slice of the accumulated buffer shown in failure messages. */
const BUFFER_TAIL_FOR_ERRORS = 1500;

export async function launchAtelier(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = {
    ...process.env,
    ...(opts.env ?? {}),
    // Force colors off so the test matchers don't have to deal
    // with ANSI noise in user-visible text. The picker still
    // emits cursor-move escapes — those we strip via stripAnsi().
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };
  const term = spawn(process.execPath, [ATELIER_BIN, ...(opts.args ?? [])], {
    name: "xterm-256color",
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    cwd,
    env,
  });
  return new AtelierSession(term);
}

export class AtelierSession {
  constructor(term) {
    this.term = term;
    /** Accumulated stripped output. ANSI escapes removed. */
    this.buffer = "";
    /** Accumulated raw output, kept for debugging. */
    this.rawBuffer = "";
    /** Pending matchers in arrival order. */
    this._matchers = [];
    this._exited = false;
    this._exitCode = null;
    this._exitSignal = null;
    this.term.onData((chunk) => {
      this.rawBuffer += chunk;
      this.buffer += stripAnsi(chunk);
      this._drainMatchers();
    });
    this.term.onExit((e) => {
      this._exited = true;
      this._exitCode = e.exitCode;
      this._exitSignal = e.signal;
      this._drainMatchers();
    });
  }

  /**
   * Wait for the screen buffer to contain `pattern`. `pattern` may
   * be a string (substring match), a RegExp, or a predicate
   * `(buffer) => boolean`. Returns the matched text. Rejects with a
   * timeout error showing the trailing screen state.
   */
  expect(pattern, opts = {}) {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const start = this.buffer.length;
      const test = compileMatcher(pattern);
      // Synchronous shortcut: if it's already on screen, resolve
      // immediately. Avoids racing with the next chunk emit.
      const initial = test(this.buffer);
      if (initial !== null) {
        return resolve(initial);
      }
      const timer = setTimeout(() => {
        const idx = this._matchers.indexOf(matcher);
        if (idx >= 0) this._matchers.splice(idx, 1);
        reject(
          new Error(
            `expect(${describeMatcher(pattern)}) timed out after ${timeout}ms.\n\n` +
              `--- screen tail ---\n` +
              this.buffer.slice(Math.max(0, this.buffer.length - BUFFER_TAIL_FOR_ERRORS))
          )
        );
      }, timeout);
      const matcher = {
        test,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        startOffset: start,
      };
      this._matchers.push(matcher);
    });
  }

  /** Convenience: wait for either of several patterns and return the index that matched. */
  async expectAny(patterns, opts = {}) {
    const tests = patterns.map(compileMatcher);
    const result = await this.expect((buf) => {
      for (let i = 0; i < tests.length; i++) {
        const r = tests[i](buf);
        if (r !== null) return { index: i, value: r };
      }
      return null;
    }, opts);
    return result;
  }

  /**
   * Wait for a multi-select / single-select picker to render with
   * all of the given option labels visible. Strips ANSI and
   * checks for substring presence — order doesn't matter, just
   * that every label is on screen.
   */
  expectPicker(optionLabels, opts = {}) {
    return this.expect((buf) => {
      for (const label of optionLabels) {
        if (!buf.includes(label)) return null;
      }
      // Confirm a picker is actually rendered by also looking for
      // its help line (a stable marker that distinguishes a
      // picker from a list rendered to stdout for some other
      // reason).
      if (
        !buf.includes("↑↓ navigate") &&
        !buf.includes("navigate")
      ) {
        return null;
      }
      return optionLabels;
    }, opts);
  }

  /** Send raw bytes to the PTY. */
  send(input) {
    this.term.write(input);
  }

  /** Convenience: send an arrow-down keystroke. */
  arrowDown() {
    this.send("\x1b[B");
  }
  /** Convenience: send an arrow-up keystroke. */
  arrowUp() {
    this.send("\x1b[A");
  }
  /** Convenience: send Enter. */
  enter() {
    this.send("\r");
  }
  /** Convenience: send Ctrl-C. */
  ctrlC() {
    this.send("\x03");
  }

  /** Resize the virtual terminal. Useful for testing wrap behavior. */
  resize(cols, rows) {
    this.term.resize(cols, rows);
  }

  /** Wait until the process exits. */
  waitForExit(opts = {}) {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    if (this._exited) {
      return Promise.resolve({
        code: this._exitCode,
        signal: this._exitSignal,
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`waitForExit timed out after ${timeout}ms`));
      }, timeout);
      this.term.onExit((e) => {
        clearTimeout(timer);
        resolve({ code: e.exitCode, signal: e.signal });
      });
    });
  }

  /**
   * Tear down the PTY. Sends Ctrl-C twice (to break out of any
   * picker / prompt), then kills if needed. Always called from
   * test teardown — leaks would orphan node processes.
   */
  async close() {
    if (this._exited) return;
    try {
      this.send("\x03");
      await sleep(50);
      this.send("\x03");
      await sleep(50);
    } catch {
      /* ignore */
    }
    if (!this._exited) {
      try {
        this.term.kill();
      } catch {
        /* already dead */
      }
    }
  }

  /**
   * Assert that a substring is NOT present anywhere in the screen
   * buffer. Useful for "the secret should never appear in clear
   * text" kinds of checks.
   */
  assertNotPresent(needle, msg) {
    if (this.buffer.includes(needle)) {
      throw new Error(
        (msg ?? `Unexpected substring "${needle}" found in screen output`) +
          `\n\n--- screen tail ---\n` +
          this.buffer.slice(Math.max(0, this.buffer.length - BUFFER_TAIL_FOR_ERRORS))
      );
    }
  }

  /**
   * Re-run every pending matcher against the current buffer.
   * Called every time new data arrives (and on exit so timeouts
   * fire promptly with the final buffer state).
   */
  _drainMatchers() {
    if (this._matchers.length === 0) return;
    for (let i = 0; i < this._matchers.length; i++) {
      const m = this._matchers[i];
      const r = m.test(this.buffer);
      if (r !== null) {
        this._matchers.splice(i, 1);
        i--;
        m.resolve(r);
      }
    }
  }
}

// ============================================================
// Matcher normalization
// ============================================================

function compileMatcher(pattern) {
  if (typeof pattern === "string") {
    return (buf) => (buf.includes(pattern) ? pattern : null);
  }
  if (pattern instanceof RegExp) {
    return (buf) => {
      const m = pattern.exec(buf);
      return m ? m[0] : null;
    };
  }
  if (typeof pattern === "function") {
    return pattern;
  }
  throw new Error(
    `expect() pattern must be a string, RegExp, or function; got ${typeof pattern}`
  );
}

function describeMatcher(pattern) {
  if (typeof pattern === "string") return JSON.stringify(pattern);
  if (pattern instanceof RegExp) return pattern.toString();
  return "<predicate fn>";
}

// ============================================================
// ANSI strip — keeps printable text, drops cursor moves + colors
// ============================================================

/**
 * Strip ANSI escape sequences (CSI / OSC / SS3 etc.). The
 * accumulated buffer is what test matchers see; we strip so
 * `expect("Authenticate via?")` works without having to encode
 * the surrounding colour/cursor codes.
 *
 * Deliberately conservative regex — covers everything atelier's
 * UI emits but doesn't try to be a perfectly correct VT100
 * implementation. (We're not building a terminal emulator; just
 * looking at the human-readable text.)
 */
function stripAnsi(s) {
  // CSI (\x1b[ ... letter), OSC (\x1b] ... BEL or ST), single-
  // character escapes (\x1b<letter>), and the `\b` (backspace)
  // used by some prompts to erase characters.
  return s.replace(
    /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[A-Za-z]|\b/g,
    ""
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
