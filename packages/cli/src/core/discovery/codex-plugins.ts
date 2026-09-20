import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectSkillFiles, readSkillParts } from "../catalog/collect.js";
import { type CatalogEntry, catalogId, normaliseDescription } from "../catalog/types.js";
import { SpawnTrustedCommandRunner, type TrustedCommandRunner } from "./installed-cli.js";
import { replaceControlCharacters } from "./text.js";
import { trustedExecutableOnPath } from "./trusted-executable.js";

export interface CodexPluginInstall {
  id: string;
  name: string;
  marketplaceName: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  source: "local" | "remote";
  installPath: string;
}

export interface CodexPluginInventoryOptions {
  codexHome: string;
  env: Readonly<Record<string, string | undefined>>;
  projectDir?: string | null;
  cwd?: string;
}

export interface CodexPluginInventoryResult {
  installs: CodexPluginInstall[];
  warnings: string[];
  complete: boolean;
}

export interface CodexPluginCatalogResult {
  entries: CatalogEntry[];
  warnings: string[];
}

export interface CodexMcpInventoryServer {
  name: string;
  enabled: boolean;
  transport: Record<string, unknown>;
}

export interface CodexMcpInventoryResult {
  servers: CodexMcpInventoryServer[];
  warnings: string[];
  complete: boolean;
}

/** Ask Codex for the effective plugin set in the current workspace. */
export async function listCodexPlugins(
  options: CodexPluginInventoryOptions,
  runner: TrustedCommandRunner = new SpawnTrustedCommandRunner(options.env),
): Promise<CodexPluginInventoryResult> {
  const executable = await trustedExecutableOnPath("codex", options.env["PATH"], options);
  if (executable === null) {
    return {
      installs: [],
      warnings: ["Codex plugin discovery skipped: codex is not executable on PATH"],
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
          `Codex plugin inventory exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
        ],
        complete: false,
      };
    }
    return {
      installs: parseCodexPluginList(result.stdout, options.codexHome),
      warnings: [],
      complete: true,
    };
  } catch (error) {
    return {
      installs: [],
      warnings: [`Codex plugin inventory failed: ${(error as Error).message}`],
      complete: false,
    };
  }
}

/** Ask Codex for its resolved MCP transports instead of reimplementing config precedence. */
export async function listCodexMcpServers(
  options: CodexPluginInventoryOptions,
  runner: TrustedCommandRunner = new SpawnTrustedCommandRunner(options.env),
): Promise<CodexMcpInventoryResult> {
  const executable = await trustedExecutableOnPath("codex", options.env["PATH"], options);
  if (executable === null) {
    return {
      servers: [],
      warnings: ["Codex MCP inventory skipped: codex is not executable on PATH"],
      complete: false,
    };
  }
  try {
    const result = await runner.run({
      executable,
      args: ["mcp", "list", "--json"],
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      const detail = bounded(result.stderr);
      return {
        servers: [],
        warnings: [
          `Codex MCP inventory exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
        ],
        complete: false,
      };
    }
    return { servers: parseCodexMcpList(result.stdout), warnings: [], complete: true };
  } catch (error) {
    return {
      servers: [],
      warnings: [`Codex MCP inventory failed: ${(error as Error).message}`],
      complete: false,
    };
  }
}

export function parseCodexPluginList(raw: string, codexHome: string): CodexPluginInstall[] {
  const parsed: unknown = JSON.parse(raw.trim());
  const installed = asRecord(parsed)["installed"];
  if (!Array.isArray(installed))
    throw new Error("Codex plugin inventory does not contain an installed array");
  return installed.map((item, index) => {
    const record = asRecord(item);
    const id = asString(record["pluginId"]);
    const name = asString(record["name"]);
    const marketplaceName = asString(record["marketplaceName"]);
    const version = asString(record["version"]);
    const source = asRecord(record["source"]);
    const sourceKind =
      source["source"] === "local" || source["source"] === "remote" ? source["source"] : undefined;
    if (
      id === undefined ||
      name === undefined ||
      marketplaceName === undefined ||
      version === undefined ||
      sourceKind === undefined ||
      typeof record["installed"] !== "boolean" ||
      typeof record["enabled"] !== "boolean"
    ) {
      throw new Error(`Codex plugin inventory item ${index} is missing required fields`);
    }
    const localPath = asString(source["path"]);
    let installPath: string;
    if (sourceKind === "local") {
      if (localPath === undefined) {
        throw new Error(`Codex local plugin inventory item ${index} has no source path`);
      }
      installPath = path.resolve(localPath);
    } else {
      installPath = path.join(
        path.resolve(codexHome),
        "plugins",
        "cache",
        marketplaceName,
        name,
        version,
      );
    }
    return {
      id,
      name,
      marketplaceName,
      version,
      installed: record["installed"] === true,
      enabled: record["enabled"] === true,
      source: sourceKind,
      installPath,
    };
  });
}

export function parseCodexMcpList(raw: string): CodexMcpInventoryServer[] {
  const parsed: unknown = JSON.parse(raw.trim());
  if (!Array.isArray(parsed)) throw new Error("Codex MCP inventory is not an array");
  return parsed.flatMap((item) => {
    const record = asRecord(item);
    const name = asString(record["name"]);
    const transport = asRecord(record["transport"]);
    if (name === undefined || Object.keys(transport).length === 0) return [];
    return [{ name, enabled: record["enabled"] === true, transport }];
  });
}

/** Read passive skill metadata only from the exact active versions Codex reported. */
export async function resolveCodexPluginCatalogEntries(
  installs: readonly CodexPluginInstall[],
): Promise<CodexPluginCatalogResult> {
  const warnings: string[] = [];
  const entries: CatalogEntry[] = [];
  for (const install of installs.filter((item) => item.installed && item.enabled)) {
    const manifest = await readCodexManifest(install.installPath, warnings);
    const pluginName = asString(manifest.value?.["name"]) ?? install.name;
    const roots = manifest.portable
      ? [path.join(install.installPath, "skills")]
      : componentRoots(install.installPath, manifest.value?.["skills"], "skills", warnings);
    for (const root of roots) {
      for (const skill of await collectSkillFiles(root, { maxDepth: 3, limit: 500 })) {
        const item = await readSkillParts(skill.file, skill.dir);
        const name = `${pluginName}:${item.name}`;
        entries.push({
          id: catalogId("codex", "skill", name, "global"),
          kind: "skill",
          name,
          description: normaliseDescription(item.description),
          ...(item.whenToUse === undefined
            ? {}
            : { whenToUse: normaliseDescription(item.whenToUse) }),
          runtime: "codex",
          scope: "global",
          sourcePath: skill.file,
          meta: { via: "plugin", plugin: install.id },
          ...(item.degraded ? { degraded: true } : {}),
        });
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
  return { entries, warnings };
}

async function readCodexManifest(
  pluginRoot: string,
  warnings: string[],
): Promise<{ value: Record<string, unknown> | null; portable: boolean }> {
  const portablePath = path.join(pluginRoot, "plugin.json");
  const portable = await readJson(portablePath, warnings);
  if (portable !== null) return { value: portable, portable: true };
  return {
    value: await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), warnings),
    portable: false,
  };
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

async function readJson(file: string, warnings: string[]): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return asRecord(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      warnings.push(`${file}: invalid or unreadable JSON: ${(error as Error).message}`);
    return null;
  }
}

function bounded(value: string, limit = 300): string {
  const oneLine = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
