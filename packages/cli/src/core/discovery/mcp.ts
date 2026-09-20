import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { CatalogRuntime } from "../catalog/types.js";
import { claudeConfigDir, claudeStatePath } from "../claude-config.js";
import {
  type ClaudePluginInstall,
  listClaudePlugins,
  resolveClaudePluginMcpRecords,
} from "./claude-plugins.js";
import { type ClaudeRuntimeToolInventory, listClaudeRuntimeTools } from "./claude-runtime.js";
import { type CodexRuntimeToolInventory, listCodexRuntimeTools } from "./codex-app-server.js";
import {
  type CodexMcpInventoryResult,
  type CodexPluginInstall,
  listCodexMcpServers,
  listCodexPlugins,
} from "./codex-plugins.js";

export type { ClaudePluginInstall } from "./claude-plugins.js";
export type { CodexPluginInstall } from "./codex-plugins.js";

export type McpRuntime = Extract<CatalogRuntime, "codex" | "claude-code">;

export interface ResolvedMcpServer {
  runtime: McpRuntime;
  name: string;
  scope: "global" | "project";
  scopeKey: string;
  sourcePath: string;
  originKey: string;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  url?: string;
  transport?: "stdio" | "http" | "sse";
  headers: Record<string, string>;
  enabledTools?: string[];
  disabledTools: string[];
  /** Exact callable prefix; plugin MCP servers are namespaced by Claude Code. */
  toolPrefix?: string;
  /** Tools already filtered and listed by the owning client runtime. */
  prelistedTools?: ListedMcpTool[];
  /** Runtime-side discovery failure for this server. */
  prelistError?: string;
}

export interface ResolveMcpServersOptions {
  runtime: McpRuntime;
  homeDir: string;
  projectDir: string | null;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ResolveMcpServersResult {
  servers: ResolvedMcpServer[];
  warnings: string[];
  claudePlugins?: ClaudePluginInstall[];
  codexPlugins?: CodexPluginInstall[];
  /** False when a config source could not be enumerated; missing cache partitions must stay stale. */
  authoritative?: boolean;
  /** False when active plugin skills could not be enumerated. */
  pluginCatalogAuthoritative?: boolean;
}

export interface ResolveMcpServersDependencies {
  listClaudePlugins?: (
    options: ResolveMcpServersOptions,
  ) => Promise<readonly ClaudePluginInstall[]>;
  listClaudeRuntimeTools?: (
    options: ResolveMcpServersOptions,
  ) => Promise<ClaudeRuntimeToolInventory>;
  listCodexPlugins?: (options: ResolveMcpServersOptions) => Promise<readonly CodexPluginInstall[]>;
  listCodexMcpServers?: (options: ResolveMcpServersOptions) => Promise<CodexMcpInventoryResult>;
  listCodexRuntimeTools?: (options: ResolveMcpServersOptions) => Promise<CodexRuntimeToolInventory>;
}

/** Resolve one host at a time. No availability is ever inferred from the other host. */
export async function resolveMcpServers(
  options: ResolveMcpServersOptions,
  dependencies: ResolveMcpServersDependencies = {},
): Promise<ResolveMcpServersResult> {
  return options.runtime === "codex"
    ? resolveCodexServers(options, dependencies)
    : resolveClaudeServers(options, dependencies);
}

async function resolveCodexServers(
  options: ResolveMcpServersOptions,
  dependencies: ResolveMcpServersDependencies,
): Promise<ResolveMcpServersResult> {
  const warnings: string[] = [];
  const byName = new Map<string, ResolvedMcpServer>();
  const codexHome = path.resolve(
    options.env["CODEX_HOME"]?.trim() || path.join(options.homeDir, ".codex"),
  );
  let codexPlugins: CodexPluginInstall[] | undefined;
  let pluginCatalogAuthoritative = true;
  try {
    const inventory =
      dependencies.listCodexPlugins === undefined
        ? await listCodexPlugins({
            codexHome,
            env: options.env,
            projectDir: options.projectDir,
            ...(options.projectDir === null ? {} : { cwd: options.projectDir }),
          })
        : {
            installs: [...(await dependencies.listCodexPlugins(options))],
            warnings: [],
            complete: true,
          };
    pluginCatalogAuthoritative = inventory.complete;
    if (inventory.complete) codexPlugins = inventory.installs;
    warnings.push(...inventory.warnings);
  } catch (error) {
    pluginCatalogAuthoritative = false;
    warnings.push(`Codex plugin discovery failed: ${(error as Error).message}`);
  }

  let runtimeTools: CodexRuntimeToolInventory;
  try {
    runtimeTools =
      dependencies.listCodexRuntimeTools === undefined
        ? await listCodexRuntimeTools({
            env: options.env,
            ...(options.projectDir === null ? {} : { cwd: options.projectDir }),
          })
        : await dependencies.listCodexRuntimeTools(options);
  } catch (error) {
    runtimeTools = {
      servers: [],
      warnings: [`Codex app-server tool inventory failed: ${(error as Error).message}`],
      complete: false,
    };
  }
  warnings.push(...runtimeTools.warnings);
  if (runtimeTools.complete) {
    const scope = options.projectDir === null ? "global" : "project";
    const scopeRoot = options.projectDir ?? codexHome;
    const scopeKey = `effective:${hash(scopeRoot)}`;
    const sourcePath = path.join(codexHome, "config.toml");
    for (const server of runtimeTools.servers) {
      const originKey = hash(`${scopeKey}\0${server.pluginId ?? "configured"}\0${server.name}`);
      byName.set(server.name, {
        runtime: "codex",
        name: server.name,
        scope,
        scopeKey,
        sourcePath,
        originKey,
        args: [],
        env: {},
        headers: {},
        disabledTools: [],
        prelistedTools: server.tools,
        ...(server.toolsError === null ? {} : { prelistError: server.toolsError }),
      });
    }
    return {
      servers: [...byName.values()].sort(byServerIdentity),
      warnings,
      ...(codexPlugins === undefined ? {} : { codexPlugins }),
      authoritative: true,
      pluginCatalogAuthoritative,
    };
  }

  let effective: CodexMcpInventoryResult;
  try {
    effective =
      dependencies.listCodexMcpServers === undefined
        ? await listCodexMcpServers({
            codexHome,
            env: options.env,
            projectDir: options.projectDir,
            ...(options.projectDir === null ? {} : { cwd: options.projectDir }),
          })
        : await dependencies.listCodexMcpServers(options);
  } catch (error) {
    effective = {
      servers: [],
      warnings: [`Codex MCP inventory failed: ${(error as Error).message}`],
      complete: false,
    };
  }
  warnings.push(...effective.warnings);
  if (effective.complete) {
    const scope = options.projectDir === null ? "global" : "project";
    const scopeRoot = options.projectDir ?? codexHome;
    const sourcePath = path.join(codexHome, "config.toml");
    for (const item of effective.servers) {
      if (!item.enabled) continue;
      if (hasDynamicHeaders(item.transport)) {
        warnings.push(
          `Codex MCP server ${item.name} uses a dynamic headers helper; Skillful will not execute authentication helpers`,
        );
        continue;
      }
      const target = normaliseTarget({
        runtime: "codex",
        name: item.name,
        scope,
        scopeKey: `effective:${hash(scopeRoot)}`,
        sourcePath,
        config: item.transport,
        processEnv: options.env,
      });
      if (target !== null) byName.set(item.name, target);
    }
    return {
      servers: [...byName.values()].sort(byServerIdentity),
      warnings,
      ...(codexPlugins === undefined ? {} : { codexPlugins }),
      // The CLI fallback cannot see app/plugin-only MCP surfaces, so absence is not authoritative.
      authoritative: false,
      pluginCatalogAuthoritative,
    };
  }

  const layers: Array<{ file: string; scope: "global" | "project"; scopeKey: string }> = [
    { file: path.join(codexHome, "config.toml"), scope: "global", scopeKey: "user" },
  ];
  if (options.projectDir !== null) {
    layers.push({
      file: path.join(options.projectDir, ".codex", "config.toml"),
      scope: "project",
      scopeKey: `project:${hash(options.projectDir)}`,
    });
  }

  for (const layer of layers) {
    const text = await readOptional(layer.file, warnings);
    if (text === null) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      warnings.push(`${layer.file}: invalid TOML: ${(error as Error).message}`);
      continue;
    }
    const servers = asRecord(parsed["mcp_servers"]);
    for (const [name, raw] of Object.entries(servers)) {
      const config = asRecord(raw);
      if (config["enabled"] === false) {
        byName.delete(name);
        continue;
      }
      if (hasDynamicHeaders(config)) {
        warnings.push(
          `${layer.file}: ${name} uses a dynamic headers helper; Skillful will not execute authentication helpers`,
        );
        continue;
      }
      const target = normaliseTarget({
        runtime: "codex",
        name,
        scope: layer.scope,
        scopeKey: layer.scopeKey,
        sourcePath: layer.file,
        config,
        processEnv: options.env,
      });
      if (target !== null) byName.set(name, target);
    }
  }
  let fallbackServers = [...byName.values()];
  if (options.projectDir !== null) {
    const effectiveScopeKey = `effective:${hash(options.projectDir)}`;
    fallbackServers = fallbackServers.map((server) => ({
      ...server,
      scope: "project",
      scopeKey: effectiveScopeKey,
      originKey: hash(`${server.originKey}\0${effectiveScopeKey}`),
    }));
  }
  return {
    servers: fallbackServers.sort(byServerIdentity),
    warnings,
    ...(codexPlugins === undefined ? {} : { codexPlugins }),
    authoritative: false,
    pluginCatalogAuthoritative,
  };
}

async function resolveClaudeServers(
  options: ResolveMcpServersOptions,
  dependencies: ResolveMcpServersDependencies,
): Promise<ResolveMcpServersResult> {
  const warnings: string[] = [];
  const byName = new Map<string, ResolvedMcpServer>();
  const configDir = claudeConfigDir(options.homeDir, options.env);
  const claudeJsonPath = claudeStatePath(options.homeDir, options.env);
  const claudeDirMcp = path.join(configDir, "mcp.json");
  // File/SDK discovery is only a fail-closed fallback. Only the owning Claude client can provide
  // an authoritative effective inventory because it owns managed connectors and OAuth state.
  let authoritative = false;

  let claudePlugins: ClaudePluginInstall[] | undefined;
  let pluginCatalogAuthoritative = true;
  try {
    const inventory =
      dependencies.listClaudePlugins === undefined
        ? await listClaudePlugins({
            env: options.env,
            projectDir: options.projectDir,
            ...(options.projectDir === null ? {} : { cwd: options.projectDir }),
          })
        : {
            installs: [...(await dependencies.listClaudePlugins(options))],
            warnings: [],
            complete: true,
          };
    pluginCatalogAuthoritative = inventory.complete;
    if (inventory.complete) claudePlugins = inventory.installs;
    warnings.push(...inventory.warnings);
  } catch (error) {
    pluginCatalogAuthoritative = false;
    warnings.push(`Claude plugin discovery failed: ${(error as Error).message}`);
  }

  let runtimeTools: ClaudeRuntimeToolInventory;
  try {
    runtimeTools =
      dependencies.listClaudeRuntimeTools === undefined
        ? await listClaudeRuntimeTools({
            env: options.env,
            ...(options.projectDir === null ? {} : { cwd: options.projectDir }),
          })
        : await dependencies.listClaudeRuntimeTools(options);
  } catch (error) {
    runtimeTools = {
      servers: [],
      warnings: [`Claude runtime tool inventory failed: ${(error as Error).message}`],
      complete: false,
    };
  }
  warnings.push(...runtimeTools.warnings);
  const scope = options.projectDir === null ? "global" : "project";
  const scopeRoot = options.projectDir ?? configDir;
  const scopeKey = `effective:${hash(scopeRoot)}`;
  const runtimeSnapshotComplete =
    runtimeTools.complete && runtimeTools.servers.every((server) => server.toolsError === null);
  for (const server of runtimeTools.servers) {
    // Keep exact managed/OAuth tools even when another server was still pending. A pending
    // configured server is replaced below by its Claude-specific transport definition and probed
    // directly; a pending managed connector remains absent instead of being guessed.
    if (!runtimeSnapshotComplete && server.tools.length === 0) continue;
    byName.set(server.name, {
      runtime: "claude-code",
      name: server.name,
      scope,
      scopeKey,
      sourcePath: claudeJsonPath,
      originKey: hash(`${scopeKey}\0${server.source}\0${server.name}`),
      args: [],
      env: {},
      transport: "stdio",
      headers: {},
      disabledTools: [],
      toolPrefix: server.toolPrefix,
      prelistedTools: server.tools,
      ...(server.toolsError === null ? {} : { prelistError: server.toolsError }),
    });
  }
  if (runtimeSnapshotComplete) {
    return {
      servers: [...byName.values()].sort(byServerIdentity),
      warnings,
      ...(claudePlugins === undefined ? {} : { claudePlugins }),
      authoritative: true,
      pluginCatalogAuthoritative,
    };
  }
  if (runtimeTools.servers.some((server) => server.toolsError !== null)) {
    warnings.push(
      "Claude runtime init was not fully connected; probing only Claude-configured servers and retaining exact connected managed tools",
    );
  }

  const userState = await readJsonObject(claudeJsonPath, warnings);

  // User layer. The configured Claude state and mcp.json never cross into Codex.
  authoritative =
    addClaudeRecord(
      byName,
      asRecord(userState.value?.["mcpServers"]),
      {
        runtime: "claude-code",
        scope: "global",
        scopeKey: "user",
        sourcePath: claudeJsonPath,
        processEnv: options.env,
      },
      warnings,
    ) && authoritative;
  const compatibility = await readJsonObject(claudeDirMcp, warnings);
  authoritative =
    addClaudeRecord(
      byName,
      asRecord(compatibility.value?.["mcpServers"]),
      {
        runtime: "claude-code",
        scope: "global",
        scopeKey: "user",
        sourcePath: claudeDirMcp,
        processEnv: options.env,
      },
      warnings,
    ) && authoritative;

  if (options.projectDir !== null) {
    const projectKey = `project:${hash(options.projectDir)}`;
    const projects = asRecord(userState.value?.["projects"]);
    const local = asRecord(projects[options.projectDir]);
    const approved = new Set(asStringArray(local["enabledMcpjsonServers"]));
    const disabled = new Set(asStringArray(local["disabledMcpjsonServers"]));
    const projectFile = path.join(options.projectDir, ".mcp.json");
    const project = await readJsonObject(projectFile, warnings);
    const projectServers = asRecord(project.value?.["mcpServers"]);
    for (const [name, raw] of Object.entries(projectServers)) {
      if (!approved.has(name) || disabled.has(name)) continue;
      authoritative =
        addClaudeRecord(
          byName,
          { [name]: raw },
          {
            runtime: "claude-code",
            scope: "project",
            scopeKey: projectKey,
            sourcePath: projectFile,
            processEnv: options.env,
          },
          warnings,
        ) && authoritative;
    }

    // Claude's local, private project layer is stored under the canonical project path.
    authoritative =
      addClaudeRecord(
        byName,
        asRecord(local["mcpServers"]),
        {
          runtime: "claude-code",
          scope: "project",
          scopeKey: `local:${hash(options.projectDir)}`,
          sourcePath: claudeJsonPath,
          processEnv: options.env,
        },
        warnings,
      ) && authoritative;
  }

  try {
    const plugins = await resolveClaudePluginMcpRecords(claudePlugins ?? [], {
      configDir,
      projectDir: options.projectDir,
      env: options.env,
    });
    warnings.push(...plugins.warnings);
    if (plugins.warnings.length > 0) authoritative = false;
    for (const plugin of plugins.records) {
      if (hasDynamicHeaders(plugin.config)) {
        warnings.push(
          `${plugin.sourcePath}: ${plugin.name} uses a dynamic headers helper; Skillful will not execute authentication helpers`,
        );
        authoritative = false;
        continue;
      }
      const server = normaliseTarget({
        runtime: "claude-code",
        name: plugin.name,
        scope: plugin.scope,
        scopeKey: plugin.scopeKey,
        sourcePath: plugin.sourcePath,
        processEnv: options.env,
        config: plugin.config,
        toolPrefix: plugin.toolPrefix,
      });
      if (server !== null) byName.set(plugin.name, server);
      else authoritative = false;
    }
  } catch (error) {
    authoritative = false;
    warnings.push(`Claude plugin MCP discovery failed: ${(error as Error).message}`);
  }

  let servers = [...byName.values()];
  if (options.projectDir !== null) {
    const effectiveScopeKey = `effective:${hash(options.projectDir)}`;
    servers = servers.map((server) => ({
      ...server,
      scope: "project",
      scopeKey: effectiveScopeKey,
      originKey: hash(`${server.originKey}\0${effectiveScopeKey}`),
    }));
  }

  return {
    servers: servers.sort(byServerIdentity),
    warnings,
    ...(claudePlugins === undefined ? {} : { claudePlugins }),
    authoritative,
    pluginCatalogAuthoritative,
  };
}

interface TargetContext {
  runtime: McpRuntime;
  scope: "global" | "project";
  scopeKey: string;
  sourcePath: string;
  processEnv: Readonly<Record<string, string | undefined>>;
  toolPrefix?: string;
}

function addClaudeRecord(
  target: Map<string, ResolvedMcpServer>,
  record: Record<string, unknown>,
  context: TargetContext,
  warnings: string[],
): boolean {
  let complete = true;
  for (const [name, raw] of Object.entries(record)) {
    const server = normaliseTarget({ ...context, name, config: asRecord(raw) });
    if (server !== null) target.set(name, server);
    else {
      warnings.push(`${context.sourcePath}: MCP server ${name} has no supported command or URL`);
      complete = false;
    }
  }
  return complete;
}

function normaliseTarget(
  context: TargetContext & { name: string; config: Record<string, unknown> },
): ResolvedMcpServer | null {
  let unresolved = false;
  const expand = (value: string): string =>
    value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g,
      (whole, name: string, fallback: string | undefined) => {
        const replacement = context.processEnv[name];
        if (replacement !== undefined && replacement !== "") return replacement;
        if (fallback !== undefined) return fallback;
        unresolved = true;
        return whole;
      },
    );
  const expandedString = (value: unknown): string | undefined => {
    const raw = asString(value);
    if (raw === undefined) return undefined;
    return asString(expand(raw));
  };
  const command = expandedString(context.config["command"]);
  const url = expandedString(context.config["url"]);
  if (command === undefined && url === undefined) return null;
  const args = asStringArray(context.config["args"]).map(expand);
  const configuredEnv = Object.fromEntries(
    Object.entries(asStringRecord(context.config["env"])).map(([name, value]) => [
      name,
      expand(value),
    ]),
  );
  for (const name of localEnvVarNames(context.config["env_vars"])) {
    const value = context.processEnv[name];
    if (value !== undefined) configuredEnv[name] = value;
    else unresolved = true;
  }
  const headers = Object.fromEntries(
    Object.entries({
      ...asStringRecord(context.config["headers"]),
      ...asStringRecord(context.config["http_headers"]),
    }).map(([name, value]) => [name, expand(value)]),
  );
  const envHeaderNames = asStringRecord(context.config["env_http_headers"]);
  for (const [header, envName] of Object.entries(envHeaderNames)) {
    const value = context.processEnv[envName];
    if (value !== undefined) headers[header] = value;
    else unresolved = true;
  }
  const bearerEnv = asString(context.config["bearer_token_env_var"]);
  if (bearerEnv !== undefined && context.processEnv[bearerEnv] !== undefined) {
    headers["Authorization"] = `Bearer ${context.processEnv[bearerEnv]}`;
  } else if (bearerEnv !== undefined) {
    unresolved = true;
  }
  const cwd = expandedString(context.config["cwd"]);
  if (unresolved) return null;

  const configuredTransport =
    asString(context.config["type"]) ?? asString(context.config["transport"]);
  const transport =
    command !== undefined ? "stdio" : configuredTransport === "sse" ? "sse" : "http";

  const enabled = asStringArrayOrUndefined(context.config["enabled_tools"]);
  const disabled = asStringArray(context.config["disabled_tools"]);
  const disabledSet = new Set(disabled);
  const enabledTools = enabled?.filter((name) => !disabledSet.has(name));

  const redactedIdentity = {
    runtime: context.runtime,
    name: context.name,
    scopeKey: context.scopeKey,
    command,
    args,
    url,
    cwd,
    transport,
    envKeys: Object.keys(configuredEnv).sort(),
    headerKeys: Object.keys(headers).sort(),
    enabledTools,
    disabledTools: disabled,
    ...(context.toolPrefix === undefined ? {} : { toolPrefix: context.toolPrefix }),
  };

  return {
    runtime: context.runtime,
    name: context.name,
    scope: context.scope,
    scopeKey: context.scopeKey,
    sourcePath: context.sourcePath,
    originKey: hash(`${context.sourcePath}\0${JSON.stringify(redactedIdentity)}`),
    ...(command === undefined ? {} : { command }),
    args,
    ...(cwd === undefined ? {} : { cwd }),
    env: configuredEnv,
    ...(url === undefined ? {} : { url }),
    transport,
    headers,
    ...(enabledTools === undefined ? {} : { enabledTools }),
    disabledTools: disabled,
    ...(context.toolPrefix === undefined ? {} : { toolPrefix: context.toolPrefix }),
  };
}

/** Exact host-visible name. Claude plugin tools carry the plugin and server namespace. */
export function canonicalMcpToolName(server: ResolvedMcpServer, toolName: string): string {
  return `${server.toolPrefix ?? `mcp__${server.name}__`}${toolName}`;
}

export interface ListedMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  title?: string;
}

export interface McpToolPage {
  tools: ListedMcpTool[];
  nextCursor?: string;
}

export interface McpListLimits {
  maxPages?: number;
  maxTools?: number;
  maxBytes?: number;
}

/** Collect an MCP list with opaque-cursor correctness and hard resource ceilings. */
export async function collectMcpTools(
  page: (cursor: string | undefined) => Promise<McpToolPage>,
  limits: McpListLimits = {},
): Promise<ListedMcpTool[]> {
  const maxPages = limits.maxPages ?? 25;
  const maxTools = limits.maxTools ?? 2_000;
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024;
  const seen = new Set<string>();
  const tools: ListedMcpTool[] = [];
  let cursor: string | undefined;
  let bytes = 0;

  for (let index = 0; index < maxPages; index += 1) {
    const result = await page(cursor);
    bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > maxBytes) throw new Error(`MCP tools/list exceeded ${maxBytes} bytes`);
    tools.push(...result.tools);
    if (tools.length > maxTools) throw new Error(`MCP tools/list exceeded ${maxTools} tools`);
    if (result.nextCursor === undefined) return tools;
    if (seen.has(result.nextCursor))
      throw new Error(`MCP tools/list cursor cycle at ${JSON.stringify(result.nextCursor)}`);
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`MCP tools/list exceeded ${maxPages} pages`);
}

/** Apply Codex's allowlist first and denylist second. Claude targets normally have neither. */
export function filterMcpTools(
  tools: readonly ListedMcpTool[],
  server: ResolvedMcpServer,
): ListedMcpTool[] {
  const allowed =
    server.enabledTools === undefined
      ? tools
      : tools.filter((tool) => server.enabledTools?.includes(tool.name));
  const denied = new Set(server.disabledTools);
  return allowed.filter((tool) => !denied.has(tool.name));
}

async function readOptional(file: string, warnings: string[]): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") warnings.push(`${file}: ${(error as Error).message}`);
    return null;
  }
}

async function readJsonObject(
  file: string,
  warnings: string[],
): Promise<{ value: Record<string, unknown> | null; complete: boolean }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null, complete: true };
    warnings.push(`${file}: ${(error as Error).message}`);
    return { value: null, complete: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${file}: JSON root is not an object`);
      return { value: null, complete: false };
    }
    return { value: parsed as Record<string, unknown>, complete: true };
  } catch (error) {
    warnings.push(`${file}: invalid JSON: ${(error as Error).message}`);
    return { value: null, complete: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asStringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? asStringArray(value) : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function localEnvVarNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    const record = asRecord(item);
    if (
      typeof record["name"] === "string" &&
      (record["source"] === undefined || record["source"] === "local")
    ) {
      out.push(record["name"]);
    }
  }
  return out;
}

function hasDynamicHeaders(config: Record<string, unknown>): boolean {
  return (
    asString(config["headersHelper"]) !== undefined ||
    asString(config["headers_helper"]) !== undefined ||
    asString(config["http_headers_helper"]) !== undefined
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function byServerIdentity(a: ResolvedMcpServer, b: ResolvedMcpServer): number {
  return a.name.localeCompare(b.name) || a.originKey.localeCompare(b.originKey);
}
