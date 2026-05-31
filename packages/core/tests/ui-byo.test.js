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
 * The "bring your own UI framework" surface, end-to-end:
 *   1. native non-JS support (Flutter is a built-in adapter),
 *   2. a fully custom framework taught purely via a user YAML adapter,
 *   3. a user adapter overriding a built-in to add a routing convention.
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

async function flutterRepo(umbrella) {
  const app = await gitRepo(umbrella, "mobile");
  await write(
    path.join(app, "pubspec.yaml"),
    "name: acme_mobile\ndescription: A sample app\nflutter:\n  sdk: flutter\n"
  );
  await write(path.join(app, "lib", "main.dart"), "void main() {}\n");
  await write(path.join(app, "lib", "pages", "home.dart"), "class HomePage {}\n");
  await write(path.join(app, "lib", "pages", "settings.dart"), "class SettingsPage {}\n");
  await write(path.join(app, "lib", "pages", "profile", "edit.dart"), "class EditProfile {}\n");
  await write(
    path.join(app, "lib", "widgets", "primary_button.dart"),
    "class PrimaryButton extends StatelessWidget {}\n"
  );
  await write(
    path.join(app, "lib", "widgets", "user_card.dart"),
    "class UserCard extends StatefulWidget {}\n"
  );
  await write(path.join(app, "lib", "widgets", "format_utils.dart"), "String fmt(x) => x;\n");
  return app;
}

// ============================================================
// 1. Native non-JS support — Flutter is a built-in adapter.
// ============================================================

test("native: a Flutter app is detected with zero config (built-in adapter)", async () => {
  const { umbrella, workspaceRoot } = await ws();
  try {
    await flutterRepo(umbrella);
    await addRepo(workspaceRoot, { pathInput: "../mobile", cwd: workspaceRoot });

    const apps = await detectApps(workspaceRoot);
    assert.equal(apps.length, 1, JSON.stringify(apps));
    assert.equal(apps[0].framework, "Flutter");
    assert.equal(apps[0].name, "acme_mobile");
    assert.equal(apps[0].adapterId, "flutter");

    // Flutter navigation is code-defined → the agent reads it, not atelier.
    const [nav] = await detectNavigation(workspaceRoot);
    assert.equal(nav.fileBased, false);
    assert.equal(nav.routes.length, 0);

    // Widget components are deterministic (the two widgets, not the helper).
    const kit = await detectUiKit(workspaceRoot);
    const widgets = kit.components.find((c) => c.dir === "lib/widgets");
    assert.ok(widgets, "lib/widgets recognized");
    assert.equal(widgets.count, 2);
    assert.deepEqual(widgets.samples.sort(), ["primary_button", "user_card"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// 2. Bring your own — a custom framework taught only via YAML.
// ============================================================

const LATTICE_ADAPTER_YAML = [
  "version: 1",
  "id: lattice",
  "framework: Lattice",
  "priority: 50",
  "detect:",
  "  manifest:",
  "    file: lattice.config",
  "name:",
  "  file: lattice.config",
  "  key: app",
  "routes:",
  "  strategy: file-based",
  "  roots: [views]",
  "  include: ['**/*.lat']",
  "  indexBasename: index",
  "components:",
  "  dirs: [widgets]",
  "  extensions: ['.lat']",
  "  pascalCase: false",
  "  contains: 'component'",
  "",
].join("\n");

async function latticeRepo(umbrella) {
  const app = await gitRepo(umbrella, "kiosk");
  await write(path.join(app, "lattice.config"), "app: acme_kiosk\nversion: 2\n");
  await write(path.join(app, "views", "index.lat"), "view Home\n");
  await write(path.join(app, "views", "checkout.lat"), "view Checkout\n");
  await write(path.join(app, "views", "account", "billing.lat"), "view Billing\n");
  await write(path.join(app, "widgets", "money_field.lat"), "component MoneyField\n");
  await write(path.join(app, "widgets", "helpers.lat"), "fn helper() {}\n");
  return app;
}

test("BYO: a custom framework is taught entirely via a user YAML adapter", async () => {
  const { umbrella, workspaceRoot } = await ws();
  try {
    await latticeRepo(umbrella);
    await addRepo(workspaceRoot, { pathInput: "../kiosk", cwd: workspaceRoot });

    // No built-in knows "Lattice": invisible until the agent authors one.
    assert.deepEqual(await detectApps(workspaceRoot), []);

    await write(
      path.join(workspaceRoot, ".atelier", "ui-adapters", "lattice.yaml"),
      LATTICE_ADAPTER_YAML
    );

    const apps = await detectApps(workspaceRoot);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "Lattice");
    assert.equal(apps[0].name, "acme_kiosk");

    const [nav] = await detectNavigation(workspaceRoot);
    assert.equal(nav.fileBased, true);
    assert.deepEqual(nav.routes.map((r) => r.route).sort(), ["/", "/account/billing", "/checkout"]);

    const kit = await detectUiKit(workspaceRoot);
    const widgets = kit.components.find((c) => c.dir === "widgets");
    assert.ok(widgets, "widgets/ recognized");
    assert.equal(widgets.count, 1); // money_field (component), not helpers
    assert.deepEqual(widgets.samples, ["money_field"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});

// ============================================================
// 3. Override — a user adapter teaches a built-in a routing convention.
// ============================================================

test("override: a user adapter can add a routing convention to a built-in", async () => {
  const { umbrella, workspaceRoot } = await ws();
  try {
    await flutterRepo(umbrella);
    await addRepo(workspaceRoot, { pathInput: "../mobile", cwd: workspaceRoot });

    // This team keeps screens under lib/pages — teach atelier that.
    await write(
      path.join(workspaceRoot, ".atelier", "ui-adapters", "flutter.yaml"),
      [
        "id: flutter",
        "framework: Flutter",
        "priority: 60",
        "detect:",
        "  manifest:",
        "    file: pubspec.yaml",
        "    contains: 'flutter:'",
        "name:",
        "  file: pubspec.yaml",
        "  key: name",
        "routes:",
        "  strategy: file-based",
        "  roots: [lib/pages]",
        "  include: ['**/*.dart']",
        "  indexBasename: home",
        "",
      ].join("\n")
    );

    const apps = await detectApps(workspaceRoot);
    assert.equal(apps[0].framework, "Flutter");

    const [nav] = await detectNavigation(workspaceRoot);
    assert.equal(nav.fileBased, true);
    assert.deepEqual(nav.routes.map((r) => r.route).sort(), ["/", "/profile/edit", "/settings"]);
  } finally {
    await fs.rm(umbrella, { recursive: true, force: true });
  }
});
