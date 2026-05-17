/**
 * Tiny terminal UI helpers.
 *
 * Kept dependency-free — ANSI escapes only. If we add a real
 * rendering library later (chalk, ink, etc.), the rest of the
 * CLI imports through this module so the swap is one file.
 */

const isTty = process.stdout.isTTY === true;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function paint(code: string, s: string): string {
  if (!isTty) return s;
  return `${code}${s}${ANSI.reset}`;
}

// Braille spinner — same set EAS, npm, and friends use.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Tiny spinner. In a TTY, animates while the body runs. In a
 * non-TTY context (CI, piped output, tests), just prints
 * before/after lines so the log stays useful. Always returns the
 * resolved value of `body()` and re-throws on failure after
 * printing the error glyph.
 */
async function withSpinner<T>(label: string, body: () => Promise<T>): Promise<T> {
  if (!isTty) {
    process.stdout.write(`${paint(ANSI.dim, "·")} ${label}…\n`);
    try {
      const v = await body();
      process.stdout.write(`${paint(ANSI.green, "✓")} ${label}\n`);
      return v;
    } catch (err) {
      process.stdout.write(`${paint(ANSI.red, "✗")} ${label}\n`);
      throw err;
    }
  }
  let frame = 0;
  const render = () => {
    process.stdout.write(
      `\r${paint(ANSI.cyan, SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${label}…`
    );
    frame++;
  };
  render();
  const interval = setInterval(render, 80);
  const clear = () => {
    clearInterval(interval);
    process.stdout.write(`\r\x1b[2K`);
  };
  try {
    const v = await body();
    clear();
    process.stdout.write(`${paint(ANSI.green, "✓")} ${label}\n`);
    return v;
  } catch (err) {
    clear();
    process.stdout.write(`${paint(ANSI.red, "✗")} ${label}\n`);
    throw err;
  }
}

export const ui = {
  bold: (s: string) => paint(ANSI.bold, s),
  dim: (s: string) => paint(ANSI.dim, s),
  italic: (s: string) => paint(ANSI.italic, s),
  red: (s: string) => paint(ANSI.red, s),
  green: (s: string) => paint(ANSI.green, s),
  yellow: (s: string) => paint(ANSI.yellow, s),
  blue: (s: string) => paint(ANSI.blue, s),
  cyan: (s: string) => paint(ANSI.cyan, s),
  gray: (s: string) => paint(ANSI.gray, s),

  success(msg: string): void {
    process.stdout.write(`${paint(ANSI.green, "✓")} ${msg}\n`);
  },
  info(msg: string): void {
    process.stdout.write(`${paint(ANSI.cyan, "·")} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`${paint(ANSI.yellow, "!")} ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${paint(ANSI.red, "✗")} ${msg}\n`);
  },
  blank(): void {
    process.stdout.write("\n");
  },
  print(s: string): void {
    process.stdout.write(`${s}\n`);
  },

  /** Section header — bold + blue rule under a label. */
  heading(label: string): void {
    process.stdout.write(`\n${paint(ANSI.bold, label)}\n`);
  },

  /** Two-column key/value line ("  label:    value"). */
  field(label: string, value: string, labelWidth = 12): void {
    const padded = (label + ":").padEnd(labelWidth);
    process.stdout.write(`  ${paint(ANSI.dim, padded)} ${value}\n`);
  },

  /** Run `body` with a spinner; resolve to its return value. */
  spinner: withSpinner,
};
