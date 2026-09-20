import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  collectMarkdownRecursive,
  collectSkillFiles,
  readMarkdownItem,
  readSkillParts,
} from "../catalog/collect.js";
import { type CatalogEntry, catalogId, normaliseDescription } from "../catalog/types.js";
import { SpawnTrustedCommandRunner, type TrustedCommandRunner } from "./installed-cli.js";
import { replaceControlCharacters } from "./text.js";
import { trustedExecutableOnPath } from "./trusted-executable.js";

export type ClaudePluginScope = "user" | "project" | "local" | "managed" | "synced";

export interface ClaudePluginInstall {
  id: string;
  scope: ClaudePluginScope;
  enabled: boolean;
  installPath: string;
  projectPath?: string | null;
}

export interface ClaudePluginInventoryOptions {
  env: Readonly<Record<string, string | undefined>>;
  projectDir?: string | null;
  cwd?: string;
}

export interface ClaudePluginInventoryResult {
  installs: ClaudePluginInstall[];
  warnings: string[];
  complete: boolean;
}

export interface ClaudePluginMcpOptions {
  configDir: string;
  projectDir: string | null;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ClaudePluginMcpRecord {
  name: string;
  scope: "global" | "project";
  scopeKey: string;
  sourcePath: string;
  toolPrefix: string;
  config: Record<string, unknown>;
}

export interface ClaudePluginMcpResult {
  records: ClaudePluginMcpRecord[];
  warnings: string[];
}

export interface ClaudePluginCatalogResult {
  entries: CatalogEntry[];
  warnings: string[];
}

/** Ask Claude Code for its effective plugin inventory instead of reverse-engineering its registry. */
export async function listClaudePlugins(
  options: ClaudePluginInventoryOptions,
  runner: TrustedCommandRunner = new SpawnTrustedCommandRunner(options.env),
): Promise<ClaudePluginInventoryResult> {
  const executable = await trustedExecutableOnPath("claude", options.env["PATH"], options);
  if (executable === null) {
    return {
      installs: [],
      warnings: ["Claude plugin MCP discovery skipped: claude is not executable on PATH"],
      complete: false,
    };
  }
  try {
    const result = await runner.run({
      executable,
      args: ["plugin", "list", "--json"],
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      const detail = bounded(result.stderr);
      return {
        installs: [],
        warnings: [
          `Claude plugin inventory exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
        ],
        complete: false,
      };
    }
    return { installs: parseClaudePluginList(result.stdout), warnings: [], complete: true };
  } catch (error) {
    return {
      installs: [],
      warnings: [`Claude plugin inventory failed: ${(error as Error).message}`],
      complete: false,
    };
  }
}

export function parseClaudePluginList(raw: string): ClaudePluginInstall[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end < start)
    throw new Error("Claude plugin inventory did not contain a JSON array");
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Claude plugin inventory is not an array");
  return parsed.map((item, index) => {
    const record = asRecord(item);
    const id = asString(record["id"]);
    const scope = pluginScope(record["scope"]);
    const installPath = asString(record["installPath"]);
    if (
      id === undefined ||
      scope === undefined ||
      installPath === undefined ||
      typeof record["enabled"] !== "boolean"
    ) {
      throw new Error(`Claude plugin inventory item ${index} is missing required fields`);
    }
    const projectPath = asString(record["projectPath"]);
    return {
      id,
      scope,
      enabled: record["enabled"] === true,
      installPath: path.resolve(installPath),
      ...(projectPath === undefined ? {} : { projectPath: path.resolve(projectPath) }),
    };
  });
}

export async function resolveClaudePluginMcpRecords(
  installs: readonly ClaudePluginInstall[],
  options: ClaudePluginMcpOptions,
): Promise<ClaudePluginMcpResult> {
  const warnings: string[] = [];
  const records: ClaudePluginMcpRecord[] = [];
  for (const install of effectiveInstalls(installs, options.projectDir)) {
    records.push(...(await recordsForInstall(install, options, warnings)));
  }
  records.sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
  return { records, warnings };
}

/** Read passive metadata only from the effective plugin versions reported by Claude Code. */
export async function resolveClaudePluginCatalogEntries(
  installs: readonly ClaudePluginInstall[],
  options: ClaudePluginMcpOptions,
): Promise<ClaudePluginCatalogResult> {
  const warnings: string[] = [];
  const entries: CatalogEntry[] = [];
  for (const install of effectiveInstalls(installs, options.projectDir)) {
    const manifestPath = path.join(install.installPath, ".claude-plugin", "plugin.json");
    const manifest = await readJson(manifestPath, warnings);
    const pluginName = asString(manifest?.["name"]) ?? install.id.split("@")[0] ?? install.id;
    const roots = componentRoots(install.installPath, manifest?.["skills"], "skills", warnings);
    const scope = install.scope === "project" || install.scope === "local" ? "project" : "global";
    for (const root of roots) {
      for (const skill of await collectSkillFiles(root, { maxDepth: 3, limit: 500 })) {
        const item = await readSkillParts(skill.file, skill.dir);
        const name = `/${pluginName}:${item.name}`;
        entries.push({
          id: catalogId("claude-code", "skill", name, scope),
          kind: "skill",
          name,
          description: normaliseDescription(item.description),
          ...(item.whenToUse === undefined
            ? {}
            : { whenToUse: normaliseDescription(item.whenToUse) }),
          runtime: "claude-code",
          scope,
          sourcePath: skill.file,
          meta: { via: "plugin", plugin: install.id },
          ...(item.degraded ? { degraded: true } : {}),
        });
      }
    }
    for (const root of componentRoots(
      install.installPath,
      manifest?.["commands"],
      "commands",
      warnings,
    )) {
      for (const file of await collectMarkdownRecursive(root, { maxDepth: 3, limit: 500 })) {
        const item = await readMarkdownItem(file);
        if (item === null) continue;
        const relative = path.relative(root, file).replace(/\.md$/i, "").split(path.sep).join(":");
        const name = `/${pluginName}:${relative}`;
        entries.push({
          id: catalogId("claude-code", "command", name, scope),
          kind: "command",
          name,
          description: normaliseDescription(item.description),
          ...(item.whenToUse === undefined
            ? {}
            : { whenToUse: normaliseDescription(item.whenToUse) }),
          runtime: "claude-code",
          scope,
          sourcePath: file,
          meta: { via: "plugin", plugin: install.id },
          ...(item.degraded ? { degraded: true } : {}),
        });
      }
    }
    for (const root of componentRoots(
      install.installPath,
      manifest?.["agents"],
      "agents",
      warnings,
    )) {
      for (const file of await collectMarkdownRecursive(root, { maxDepth: 3, limit: 500 })) {
        const item = await readMarkdownItem(file);
        if (item === null) continue;
        const name = `${pluginName}:${item.name}`;
        entries.push({
          id: catalogId("claude-code", "agent", name, scope),
          kind: "agent",
          name,
          description: normaliseDescription(item.description),
          ...(item.whenToUse === undefined
            ? {}
            : { whenToUse: normaliseDescription(item.whenToUse) }),
          runtime: "claude-code",
          scope,
          sourcePath: file,
          meta: { via: "plugin", plugin: install.id },
          ...(item.degraded ? { degraded: true } : {}),
        });
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
  return { entries, warnings };
}

function effectiveInstalls(
  installs: readonly ClaudePluginInstall[],
  projectDir: string | null,
): ClaudePluginInstall[] {
  const selected = new Map<string, ClaudePluginInstall>();
  for (const install of installs) {
    if (!install.enabled || !scopeApplies(install, projectDir)) continue;
    const previous = selected.get(install.id);
    if (previous === undefined || scopePriority(install.scope) > scopePriority(previous.scope)) {
      selected.set(install.id, install);
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function scopeApplies(install: ClaudePluginInstall, projectDir: string | null): boolean {
  if (install.scope !== "project" && install.scope !== "local") return true;
  if (projectDir === null || install.projectPath === undefined || install.projectPath === null)
    return false;
  return path.resolve(install.projectPath) === path.resolve(projectDir);
}

function scopePriority(scope: ClaudePluginScope): number {
  if (scope === "local") return 5;
  if (scope === "project") return 4;
  if (scope === "user") return 3;
  if (scope === "managed") return 2;
  return 1;
}

function componentRoots(
  pluginRoot: string,
  configured: unknown,
  fallback: string,
  warnings: string[],
): string[] {
  const items =
    configured === undefined ? [fallback] : Array.isArray(configured) ? configured : [configured];
  const roots: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const resolved = path.resolve(pluginRoot, item);
    const relative = path.relative(path.resolve(pluginRoot), resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      roots.push(resolved);
    } else {
      warnings.push(`${pluginRoot}: plugin component path escapes its install root: ${item}`);
    }
  }
  return roots;
}

async function recordsForInstall(
  install: ClaudePluginInstall,
  options: ClaudePluginMcpOptions,
  warnings: string[],
): Promise<ClaudePluginMcpRecord[]> {
  const manifestPath = path.join(install.installPath, ".claude-plugin", "plugin.json");
  const manifest = await readJson(manifestPath, warnings);
  const pluginName = asString(manifest?.["name"]) ?? install.id.split("@")[0] ?? install.id;
  const configured = manifest?.["mcpServers"];
  const sources =
    configured === undefined
      ? [
          {
            value: await readJson(path.join(install.installPath, ".mcp.json"), warnings),
            sourcePath: path.join(install.installPath, ".mcp.json"),
          },
        ]
      : await resolveConfiguredSources(configured, install.installPath, manifestPath, warnings);
  const scope = install.scope === "project" || install.scope === "local" ? "project" : "global";
  const pluginData = path.join(options.configDir, "plugins", "data", safePluginId(install.id));
  const projectRoot = options.projectDir ?? options.env["PWD"] ?? path.dirname(install.installPath);
  const variables: Readonly<Record<string, string | undefined>> = {
    ...options.env,
    CLAUDE_PLUGIN_ROOT: install.installPath,
    CLAUDE_PLUGIN_DATA: pluginData,
    CLAUDE_PROJECT_DIR: projectRoot,
  };
  const out: ClaudePluginMcpRecord[] = [];

  for (const source of sources) {
    const servers = serverRecord(source.value);
    for (const [serverName, raw] of Object.entries(servers)) {
      const config = expandMcpConfig(asRecord(raw), variables);
      const scopedName = `plugin:${pluginName}:${serverName}`;
      out.push({
        name: scopedName,
        scope,
        scopeKey: `plugin:${install.scope}:${hash(install.id)}${scope === "project" ? `:${hash(projectRoot)}` : ""}`,
        sourcePath: source.sourcePath,
        toolPrefix: `mcp__plugin_${toolPart(pluginName)}_${toolPart(serverName)}__`,
        config,
      });
    }
  }
  return out;
}

async function resolveConfiguredSources(
  configured: unknown,
  pluginRoot: string,
  manifestPath: string,
  warnings: string[],
): Promise<Array<{ value: Record<string, unknown> | null; sourcePath: string }>> {
  const items = Array.isArray(configured) ? configured : [configured];
  const sources: Array<{ value: Record<string, unknown> | null; sourcePath: string }> = [];
  for (const item of items) {
    if (typeof item === "string") {
      const sourcePath = path.resolve(pluginRoot, item);
      sources.push({ value: await readJson(sourcePath, warnings), sourcePath });
      continue;
    }
    if (Object.keys(asRecord(item)).length > 0) {
      sources.push({ value: asRecord(item), sourcePath: manifestPath });
    }
  }
  return sources;
}

function serverRecord(value: Record<string, unknown> | null): Record<string, unknown> {
  if (value === null) return {};
  const wrapped = asRecord(value["mcpServers"]);
  return Object.keys(wrapped).length > 0 ? wrapped : value;
}

function expandMcpConfig(
  config: Record<string, unknown>,
  variables: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const out = { ...config };
  for (const key of ["command", "cwd", "url"] as const) {
    if (typeof out[key] === "string") out[key] = expand(out[key], variables);
  }
  if (Array.isArray(out["args"])) {
    out["args"] = out["args"].map((item) =>
      typeof item === "string" ? expand(item, variables) : item,
    );
  }
  for (const key of ["env", "headers", "http_headers"] as const) {
    const values = asRecord(out[key]);
    if (Object.keys(values).length === 0) continue;
    out[key] = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        typeof value === "string" ? expand(value, variables) : value,
      ]),
    );
  }
  return out;
}

function expand(value: string, variables: Readonly<Record<string, string | undefined>>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g,
    (whole, name: string, fallback: string | undefined) => {
      const replacement = variables[name];
      return replacement === undefined || replacement === "" ? (fallback ?? whole) : replacement;
    },
  );
}

async function readJson(file: string, warnings: string[]): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(parsed)) {
      warnings.push(`${file}: expected a JSON object at the document root`);
      return null;
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      warnings.push(`${file}: invalid or unreadable JSON: ${(error as Error).message}`);
    return null;
  }
}

function pluginScope(value: unknown): ClaudePluginScope | undefined {
  return value === "user" ||
    value === "project" ||
    value === "local" ||
    value === "managed" ||
    value === "synced"
    ? value
    : undefined;
}

function safePluginId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

function toolPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function bounded(value: string, limit = 300): string {
  const oneLine = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
