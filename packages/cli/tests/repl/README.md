# REPL interface tests

PTY-driven tests that exercise the atelier REPL end-to-end —
including raw-mode pickers, readline-based prompts, and the
inline-suggestion `InputReader`. Each scenario maps to a bug we
hit during manual testing; codifying them here means the next
person finds out the same bug exists *before* it ships.

## Why a separate suite?

These tests spin up a real PTY (via
`@homebridge/node-pty-prebuilt-multiarch`) so atelier sees
`isTTY: true` and behaves the way it does for a human. That's
the only way to catch raw-mode handoff bugs (drain eating
chars, secret prompts echoing in clear text, picker not
rendering as a picker, etc.).

It also means these tests:

  - Don't run under piped stdin. `npm test` will skip them.
  - Are slower (~300ms each — process spawn dominates).
  - Need the build to be current. `npm run build` first.

## Running

```sh
npm run build
npm run test:repl
```

CI should treat this as a separate job from the unit suite —
both because of the PTY native dep and because slow PTY tests
shouldn't gate every unrelated change.

## Writing a new scenario

Each scenario maps to a single user-visible bug. Start by
writing the test as a narrative of what the user does:

```js
test("REPL: /foo bar should produce baz", async () => {
  const root = await makeWorkspace({ env: { OPTIONAL_PRELOADED: "x" } });
  const a = await launchAtelier({ cwd: root });
  try {
    await a.expect("atelier ❯");
    a.send("/foo bar\r");
    await a.expect("Some prompt the user should see");
    a.send("answer\r");
    // … assertions …
  } finally {
    await a.close();
    await rm(root);
  }
});
```

### Harness API quick reference

| Call | What it does |
|---|---|
| `await a.expect(pattern, { timeout? })` | Wait for a substring / RegExp / predicate to appear in the screen buffer. Times out with the screen tail in the message. |
| `await a.expectAny([p1, p2, …])` | First-to-match wins. Returns `{ index, value }` so you can branch on which one fired — useful for "should I see X, or did I get Y instead?" assertions. |
| `await a.expectPicker(["label1", "label2"])` | Confirm a multi/single-select picker is actually rendered with the given labels — checks both labels and the picker's "↑↓ navigate" help line. |
| `a.send(string)` | Write raw bytes to the PTY. |
| `a.enter()` / `a.arrowDown()` / `a.arrowUp()` / `a.ctrlC()` | Convenience for common keys. |
| `a.resize(cols, rows)` | Resize the virtual terminal. Useful for testing wrap behavior. |
| `a.assertNotPresent(needle)` | Throw if a substring appears anywhere on screen. The "secret should never appear in clear text" pattern. |
| `await a.waitForExit()` | Wait until the atelier process exits. |
| `await a.close()` | Tear down. Always call in `finally`. |

### Tips for stable PTY tests

  - **Use `await a.expect(...)` between every input.** Don't pipe
    a script of keystrokes without waiting; you'll hit the same
    raw/canonical mode handoff issues you're trying to test
    against.
  - **Strip ANSI in expectations**, not in your assertions. The
    harness already does this — `a.expect("Authenticate via?")`
    works without you encoding any escape sequences.
  - **Use `expectAny` for "this OR that, and which?" checks**
    instead of racing two separate `expect` calls.
  - **Don't expect exact byte-for-byte renders.** Pickers redraw
    on every keystroke; what's important is what ends up on
    screen, not how many escape sequences got there.
  - **Always `await a.close()` in `finally`** and `await rm(root)`
    or you'll leak PTY processes / tmp dirs.

## Files

| File | What it tests |
|---|---|
| `harness.js` | The PTY wrapper. Read this first. |
| `source-onboard-sharepoint.test.js` | The SharePoint onboarding flow — each test maps to a bug we hit on 2026-05-17/18 (picker not rendering, drain eating chars, secret leaking, URL wrap). |
