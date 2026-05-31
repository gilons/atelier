import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addRepo,
  detectApps,
  detectNavigation,
  detectUiKit,
} from "../dist/index.js";

/**
 * Bring-your-own-framework, end-to-end: a user-authored YAML adapter in
 * .atelier/ui-adapters/ teaches atelier to discover a non-JS (Flutter)
 * app — its existence, its file-based routes, and its widget
 * components — with zero changes to core code.
 */

async function ws() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-byo-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}
async function write(p, c) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf8");
}
async function gitRepo(umbrella, name) {
  await write(
    path.join(umbrella, name, ".git", "config"),
    `[remote "origin"]\n\turl = git@github.com:acme/${name}.git\n`
  );
  return path.join(umbrella, name);
}

const FLUTTER_ADAPTER_YAML = [
  "version: 1",
  "id: flutter",
  "framework: Flutter",
  "priority: 50",
  "detect:",
  "  manifest:",
  "    file: pubspec.yaml",
  "    contains: '(^|\\n)flutter:'",
  "name:",
  "  file: pubspec.yaml",
  "  key: name",
  "routes:",
  "  strategy: file-based",
  "  roots: [lib/pages]",
  "  include: ['**/*.dart']",
  "  indexBasename: home",
  "components:",
  "  dirs: [lib/widgets]",
  "  extensions: ['.dart']",
  "  pascalCase: false",
  "  contains: 'extends (StatelessWidget|StatefulWidget)'",
  "",
].join("\n");

async function flutterRepo(umbrella) {
  const app = await gitRepo(umbrella, "mobile");
  await write(
    path.join(app, "pubspec.yaml"),
    "name: acme_mobile\ndescription: A sample app\nflutter:\n  sdk: flutter\n"
  );
  // Routes under lib/pages (home collapses to "/").
  await write(path.join(app, "lib", "pages", "home.dart"), "class HomePage {}\n");
  await write(path.join(app, "lib", "pages", "settings.dart"), "class SettingsPage {}\n");
  await write(path.join(app, "lib", "pages", "profile", "edit.dart"), "class EditProfile {}\n");
  // Widget components under lib/widgets (snake_case files, widget classes).
  await write(
    path.join(app, "lib", "widgets", "primary_button.dart"),
    "class PrimaryButton extends StatelessWidget {}\n"
  );
  await write(
    path.join(app, "lib", "widgets", "user_card.dart"),
    "class UserCard extends StatefulWidget {}\n"
  );
  // A non-widget helper must NOT count as a component.
  await write(path.join(app, "lib", "widgets", "format_utils.dart"), "String fmt(x) => x;\n");
  return app;
}

test("a user YAML adapter makes a Flutter app discoverable (apps + nav + components)", async () => {
  const { umbrella, workspaceRoot } = await ws();
  try {
    await flutterRepo(umbrella);
    await addRepo(workspaceRoot, { pathInput: "../mobile", cwd: workspaceRoot });
    // The agent authors the adapter manifest.
    await write(
      path.join(workspaceRoot, ".atelier", "ui-adapters", "flutter.yaml"),
      FLUTTER_ADAPTER_YAML
    );

    // 1. App detection.
    const apps = await detectApps(workspaceRoot);
    assert.equal(apps.length, 1, JSON.stringify(apps));
    assert.equal(apps[0].framework, "Flutter");
    assert.equal(apps[0].name, "acme_mobile");
    assert.equal(apps[0].adapterId, "flutter");
    assert.equal(apps[0].ref, "app:mobile");

    // 2. Navigation from the file-based router (home → "/").
    const [nav] = await detectNavigation(workspaceRoot);
    assert.equal(nav.fileBased, true);
    const routes = nav.routes.map((r) => r.route).sort();
    assert.deepEqual(routes, ["/", "/profile/edit", "/settings"]);

    // 3. Components: the two widgets, not the helper.
    const kit = await detectUiKit(workspaceRoot);
    const widgetSource = kit.components.find((c) => c.dir === "lib/widgets");
    assert.ok(widgetSource, "lib/widgets recognized as a component source");
    assert.equal(widgetSource.count, 2);
    assert.deepEqual(widgetSource.samples.sort(), ["primary_button", "user_card"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

test("without the adapter, the same Flutter app is invisible (proves the adapter drives it)", async () => {
  const { umbrella, workspaceRoot } = await ws();
  try {
    await flutterRepo(umbrella);
    await addRepo(workspaceRoot, { pathInput: "../mobile", cwd: workspaceRoot });
    // No adapter authored → no built-in matches a Flutter pubspec.
    const apps = await detectApps(workspaceRoot);
    assert.deepEqual(apps, []);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
