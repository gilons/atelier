import * as fs from "node:fs/promises";
import * as YAML from "yaml";

/**
 * Thin wrapper around the `yaml` library so command code never imports
 * it directly. Centralizing here means we can swap implementations later
 * without rippling through the rest of the codebase.
 *
 * All writes use a stable formatter so files diff cleanly in git.
 */

const STRINGIFY_OPTS: YAML.ToStringOptions = {
  lineWidth: 100,
  blockQuote: "literal",
  defaultStringType: "PLAIN",
  defaultKeyType: "PLAIN",
};

/** Read and parse a YAML file. Returns `null` if the file is missing. */
export async function readYamlFile<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return YAML.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write a value as YAML to disk.
 *
 * Includes a leading "# managed by Atelier" comment to discourage
 * accidental hand-edits without context. Users can still edit freely —
 * the comment is informational only.
 */
export async function writeYamlFile(
  filePath: string,
  value: unknown,
  header?: string
): Promise<void> {
  const body = YAML.stringify(value, STRINGIFY_OPTS);
  const lines: string[] = [];
  if (header) {
    for (const line of header.split("\n")) lines.push(`# ${line}`);
    lines.push("");
  }
  lines.push(body.trimEnd());
  lines.push("");
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
}
