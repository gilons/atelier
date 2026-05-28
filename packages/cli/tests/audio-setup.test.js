import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectPackageManager,
  installPlanFor,
} from "../dist/audio-setup.js";

/**
 * Tests for the pure helpers in the audio-setup module.
 *
 * The wizard itself is interactive — it's not exercised here. The
 * pieces we DO test:
 *   - package-manager detection per platform (with stubbed PATH)
 *   - install-plan builder per (recorder, package-manager) pair
 */

// ============================================================
// detectPackageManager
// ============================================================

test("detectPackageManager(darwin) returns brew when on PATH", () => {
  const probe = (cmd) => cmd === "brew";
  assert.equal(detectPackageManager("darwin", probe), "brew");
});

test("detectPackageManager(darwin) returns null when brew is missing", () => {
  assert.equal(detectPackageManager("darwin", () => false), null);
});

test("detectPackageManager(linux) prefers apt over dnf/pacman", () => {
  const probe = (cmd) => cmd === "apt" || cmd === "dnf" || cmd === "pacman";
  assert.equal(detectPackageManager("linux", probe), "apt");
});

test("detectPackageManager(linux) falls back to dnf when only dnf is present", () => {
  const probe = (cmd) => cmd === "dnf";
  assert.equal(detectPackageManager("linux", probe), "dnf");
});

test("detectPackageManager(linux) returns pacman on Arch-style systems", () => {
  const probe = (cmd) => cmd === "pacman";
  assert.equal(detectPackageManager("linux", probe), "pacman");
});

test("detectPackageManager(win32) prefers winget over choco", () => {
  const probe = (cmd) => cmd === "winget" || cmd === "choco";
  assert.equal(detectPackageManager("win32", probe), "winget");
});

test("detectPackageManager(win32) returns choco when only choco is on PATH", () => {
  const probe = (cmd) => cmd === "choco";
  assert.equal(detectPackageManager("win32", probe), "choco");
});

test("detectPackageManager returns null when nothing is on PATH", () => {
  assert.equal(detectPackageManager("linux", () => false), null);
});

// ============================================================
// installPlanFor
// ============================================================

test("installPlanFor(sox, brew) is auto-runnable (no sudo)", () => {
  const plan = installPlanFor("sox", "brew");
  assert.equal(plan?.command, "brew install sox");
  assert.equal(plan?.autoRunnable, true);
});

test("installPlanFor(ffmpeg, brew) is auto-runnable", () => {
  const plan = installPlanFor("ffmpeg", "brew");
  assert.equal(plan?.command, "brew install ffmpeg");
  assert.equal(plan?.autoRunnable, true);
});

test("installPlanFor(sox, apt) needs sudo and is NOT auto-runnable", () => {
  const plan = installPlanFor("sox", "apt");
  assert.match(plan?.command ?? "", /^sudo apt-get install/);
  assert.equal(plan?.autoRunnable, false);
});

test("installPlanFor(sox, pacman) uses --noconfirm + sudo", () => {
  const plan = installPlanFor("sox", "pacman");
  assert.match(plan?.command ?? "", /^sudo pacman -S --noconfirm sox/);
  assert.equal(plan?.autoRunnable, false);
});

test("installPlanFor(sox, winget) points at the SoX winget id", () => {
  const plan = installPlanFor("sox", "winget");
  assert.match(plan?.command ?? "", /winget install ChrisBagwell\.SoX/);
});

test("installPlanFor(ffmpeg, winget) points at Gyan.FFmpeg", () => {
  const plan = installPlanFor("ffmpeg", "winget");
  assert.match(plan?.command ?? "", /winget install Gyan\.FFmpeg/);
});

test("installPlanFor with no package manager returns null", () => {
  assert.equal(installPlanFor("sox", null), null);
});
