import path from "node:path";

/** Resolve the user configuration root exactly as Claude Code does. */
export function claudeConfigDir(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env["CLAUDE_CONFIG_DIR"]?.trim();
  return override === undefined || override === ""
    ? path.join(homeDir, ".claude")
    : path.resolve(override);
}

/** Claude Code keeps its state file beside the configured directory when that root is overridden. */
export function claudeStatePath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env["CLAUDE_CONFIG_DIR"]?.trim();
  return override === undefined || override === ""
    ? path.join(homeDir, ".claude.json")
    : path.join(path.resolve(override), ".claude.json");
}
