import { createHash } from "node:crypto";
import path from "node:path";
import { findProjectRoot } from "../catalog/project-scope.js";
import { type CatalogEntry, normaliseDescription } from "../catalog/types.js";
import { claudeConfigDir } from "../claude-config.js";
import {
  beginCapabilityRefreshMarker,
  type CapabilityCache,
  type CapabilityRefreshError,
  completeCapabilityRefreshMarkers,
  defaultCapabilityCachePath,
  loadCapabilityCache,
  saveCapabilityCache,
  updateCapabilityPartition,
  withCapabilityCacheLock,
} from "./cache.js";
import { resolveClaudePluginCatalogEntries } from "./claude-plugins.js";
import { resolveCodexPluginCatalogEntries } from "./codex-plugins.js";
import { discoverInstalledCliCommands, type InstalledCliDiscoveryResult } from "./installed-cli.js";
import {
  canonicalMcpToolName,
  filterMcpTools,
  type ListedMcpTool,
  type McpRuntime,
  type ResolvedMcpServer,
  type ResolveMcpServersOptions,
  type ResolveMcpServersResult,
  resolveMcpServers,
} from "./mcp.js";
import { listMcpToolsFromServer } from "./mcp-client.js";
import { replaceControlCharacters } from "./text.js";

const DISCOVERY_RUNTIMES = ["codex", "claude-code"] as const;

export interface RefreshCapabilitiesOptions {
  homeDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  runtimes?: readonly McpRuntime[];
  includeCli?: boolean;
  includeMcp?: boolean;
  cachePath?: string;
  /** Bound lock contention separately from discovery work so an async host can terminate safely. */
  lockWaitMs?: number;
}

export interface RefreshFailure {
  partition: string;
  runtime?: McpRuntime;
  server?: string;
  code: CapabilityRefreshError["code"];
  message: string;
}

export interface RefreshReport {
  cachePath: string;
  refreshedAt: string;
  partitionsUpdated: number;
  entriesWritten: number;
  warnings: string[];
  failures: RefreshFailure[];
}

export interface RefreshDependencies {
  now?: () => Date;
  discoverCli?: typeof discoverInstalledCliCommands;
  resolveMcpServers?: (options: ResolveMcpServersOptions) => Promise<ResolveMcpServersResult>;
  listMcpTools?: (server: ResolvedMcpServer) => Promise<ListedMcpTool[]>;
}

/**
 * The only live-discovery entry point. The prompt hook never calls this function.
 * Each MCP server is a transaction: one failure cannot erase another server's inventory.
 */
export async function refreshCapabilities(
  options: RefreshCapabilitiesOptions,
  dependencies: RefreshDependencies = {},
): Promise<RefreshReport> {
  const cachePath = options.cachePath ?? defaultCapabilityCachePath(options.homeDir, options.env);
  const projectDir = await findProjectRoot(options.cwd, options.homeDir);
  const workspaceKey = projectDir === null ? undefined : hash(path.resolve(projectDir));
  const marker = beginCapabilityRefreshMarker(cachePath, {
    startedAt: new Date().toISOString(),
    runtimes: [...(options.runtimes ?? DISCOVERY_RUNTIMES)],
    includeCli: options.includeCli ?? true,
    includeMcp: options.includeMcp ?? true,
    ...(workspaceKey === undefined ? {} : { workspaceKey }),
  });
  const report = await withCapabilityCacheLock(
    cachePath,
    () =>
      refreshCapabilitiesUnlocked(
        { ...options, cachePath },
        dependencies,
        projectDir,
        workspaceKey,
        marker,
      ),
    { maxWaitMs: options.lockWaitMs ?? 15_000 },
  );
  return report;
}

async function refreshCapabilitiesUnlocked(
  options: RefreshCapabilitiesOptions & { cachePath: string },
  dependencies: RefreshDependencies,
  projectDir: string | null,
  workspaceKey: string | undefined,
  marker: ReturnType<typeof beginCapabilityRefreshMarker>,
): Promise<RefreshReport> {
  const now = dependencies.now?.() ?? new Date();
  const refreshedAt = now.toISOString();
  const runtimes = options.runtimes ?? DISCOVERY_RUNTIMES;
  const includeCli = options.includeCli ?? true;
  const includeMcp = options.includeMcp ?? true;
  const cachePath = options.cachePath;
  const loaded = loadCapabilityCache(cachePath);
  const cache = loaded.cache;
  const warnings = [...loaded.warnings];
  const failures: RefreshFailure[] = [];
  let partitionsUpdated = 0;
  let entriesWritten = 0;

  // Once a persisted cache is known to be corrupt, a partial refresh must not silently make the
  // unrefreshed client's broad config-only MCP fallbacks routable again.
  if (loaded.invalid) preserveInvalidCacheMcpSentinels(cache, workspaceKey, refreshedAt);

  // Fail closed across abrupt host termination: old entries stop routing before any live probes
  // begin, and every completed partition is checkpointed independently below.
  checkpointRefreshStart(cache, runtimes, includeCli, includeMcp, workspaceKey, refreshedAt);
  saveCapabilityCache(cachePath, cache);
  // The marker protects the interval before the lock/checkpoint. From here on the persisted
  // per-partition statuses are authoritative and completed partitions may publish independently.
  completeCapabilityRefreshMarkers(cachePath, marker);

  if (includeCli) {
    const cli = await (dependencies.discoverCli ?? discoverInstalledCliCommands)({
      cwd: options.cwd,
      projectDir,
      env: options.env,
    });
    warnings.push(...cli.warnings);
    for (const runtime of runtimes) {
      for (const scope of ["global", "project"] as const) {
        const key =
          scope === "global"
            ? `cli:installed:${runtime}`
            : `cli:project:${runtime}:${workspaceKey ?? "none"}`;
        const source = scope === "global" ? "cli-installed" : "cli-project";
        if (cli.complete) {
          const entries = cliEntries(cli, runtime, scope, refreshedAt);
          updateCapabilityPartition(cache, {
            key,
            runtime,
            source,
            ...(scope === "project" && workspaceKey !== undefined ? { workspaceKey } : {}),
            status: "fresh",
            refreshedAt,
            entries,
            inputFingerprint: hash(entries.map((entry) => entry.sourcePath).join("\n")),
          });
          entriesWritten += entries.length;
        } else {
          const error: CapabilityRefreshError = {
            code: "transport",
            message: "CLI inventory was incomplete; retaining the last known commands",
            at: refreshedAt,
          };
          updateCapabilityPartition(cache, {
            key,
            runtime,
            source,
            ...(scope === "project" && workspaceKey !== undefined ? { workspaceKey } : {}),
            status: "failed",
            refreshedAt,
            entries: [],
            error,
          });
          failures.push({ partition: key, runtime, code: error.code, message: error.message });
        }
        partitionsUpdated += 1;
        saveCapabilityCache(cachePath, cache);
      }
    }
  }

  if (includeMcp) {
    for (const runtime of runtimes) {
      const resolved = await (dependencies.resolveMcpServers ?? resolveMcpServers)({
        runtime,
        homeDir: options.homeDir,
        projectDir,
        env: options.env,
      });
      warnings.push(...resolved.warnings);
      let pluginCatalogComplete = resolved.pluginCatalogAuthoritative !== false;
      if (
        runtime === "claude-code" &&
        resolved.claudePlugins !== undefined &&
        pluginCatalogComplete
      ) {
        const plugins = await resolveClaudePluginCatalogEntries(resolved.claudePlugins, {
          configDir: claudeConfigDir(options.homeDir, options.env),
          projectDir,
          env: options.env,
        });
        warnings.push(...plugins.warnings);
        pluginCatalogComplete &&= plugins.warnings.length === 0;
        if (pluginCatalogComplete) {
          const key = `claude-plugin:effective:${workspaceKey ?? "global"}`;
          updateCapabilityPartition(cache, {
            key,
            runtime,
            source: "claude-plugin",
            ...(workspaceKey === undefined ? {} : { workspaceKey }),
            status: "fresh",
            refreshedAt,
            entries: plugins.entries,
            inputFingerprint: hash(
              plugins.entries.map((entry) => `${entry.id}\0${entry.sourcePath}`).join("\n"),
            ),
          });
          partitionsUpdated += 1;
          entriesWritten += plugins.entries.length;
          if (workspaceKey === undefined) delete cache.partitions["claude-plugin:global"];
          saveCapabilityCache(cachePath, cache);
        }
      }
      if (runtime === "codex" && resolved.codexPlugins !== undefined && pluginCatalogComplete) {
        const plugins = await resolveCodexPluginCatalogEntries(resolved.codexPlugins);
        warnings.push(...plugins.warnings);
        pluginCatalogComplete &&= plugins.warnings.length === 0;
        if (pluginCatalogComplete) {
          const key = `codex-plugin:effective:${workspaceKey ?? "global"}`;
          updateCapabilityPartition(cache, {
            key,
            runtime,
            source: "codex-plugin",
            ...(workspaceKey === undefined ? {} : { workspaceKey }),
            status: "fresh",
            refreshedAt,
            entries: plugins.entries,
            inputFingerprint: hash(
              plugins.entries.map((entry) => `${entry.id}\0${entry.sourcePath}`).join("\n"),
            ),
          });
          partitionsUpdated += 1;
          entriesWritten += plugins.entries.length;
          saveCapabilityCache(cachePath, cache);
        }
      }
      if (!pluginCatalogComplete) {
        const result = markPluginPartitionsFailed(
          cache,
          runtime,
          workspaceKey,
          refreshedAt,
          failures,
        );
        partitionsUpdated += result;
        if (result === 0) {
          failures.push({
            partition: `${runtime}-plugin:inventory`,
            runtime,
            code: "config",
            message: `${runtime} plugin inventory was incomplete`,
          });
        }
      }
      const inventoryKey = `mcp:${runtime}:inventory:${workspaceKey ?? "global"}`;
      const liveKeys = new Set<string>([inventoryKey]);
      for (const server of resolved.servers) liveKeys.add(mcpPartitionKey(server));
      await mapLimit(resolved.servers, 4, async (server) => {
        const key = mcpPartitionKey(server);
        try {
          if (server.prelistError !== undefined) throw new Error(server.prelistError);
          const raw =
            server.prelistedTools ??
            (await (dependencies.listMcpTools ?? listMcpToolsFromServer)(server));
          const entries = mcpToolEntries(server, filterMcpTools(raw, server), refreshedAt);
          updateCapabilityPartition(cache, {
            key,
            runtime,
            source: "mcp",
            ...(workspaceKey === undefined ? {} : { workspaceKey }),
            status: "fresh",
            refreshedAt,
            entries,
            inputFingerprint: server.originKey,
          });
          partitionsUpdated += 1;
          entriesWritten += entries.length;
        } catch (error) {
          const classified = classifyRefreshError(error, refreshedAt);
          updateCapabilityPartition(cache, {
            key,
            runtime,
            source: "mcp",
            ...(workspaceKey === undefined ? {} : { workspaceKey }),
            status: "failed",
            refreshedAt,
            entries: [],
            inputFingerprint: server.originKey,
            error: classified,
          });
          failures.push({
            partition: key,
            runtime,
            server: server.name,
            code: classified.code,
            message: classified.message,
          });
          partitionsUpdated += 1;
        } finally {
          saveCapabilityCache(cachePath, cache);
        }
      });

      // Configuration removal is authoritative. Do not keep a deleted server as stale.
      for (const [key, partition] of Object.entries(cache.partitions)) {
        if (partition.source === "mcp" && partition.runtime === runtime && !liveKeys.has(key)) {
          if (partition.workspaceKey !== workspaceKey) continue;
          if (resolved.authoritative !== false) {
            delete cache.partitions[key];
            saveCapabilityCache(cachePath, cache);
            continue;
          }
          const classified: CapabilityRefreshError = {
            code: "config",
            message: "MCP configuration inventory was incomplete; retaining the last known tools",
            at: refreshedAt,
          };
          updateCapabilityPartition(cache, {
            ...partition,
            status: "failed",
            refreshedAt,
            entries: [],
            error: classified,
          });
          failures.push({
            partition: key,
            runtime,
            code: classified.code,
            message: classified.message,
          });
          partitionsUpdated += 1;
          saveCapabilityCache(cachePath, cache);
        }
      }
      const inventoryComplete = resolved.authoritative !== false;
      const inventoryError: CapabilityRefreshError | undefined = inventoryComplete
        ? undefined
        : {
            code: "config",
            message: `${runtime} MCP inventory was incomplete`,
            at: refreshedAt,
          };
      updateCapabilityPartition(cache, {
        key: inventoryKey,
        runtime,
        source: "mcp",
        ...(workspaceKey === undefined ? {} : { workspaceKey }),
        status: inventoryComplete ? "fresh" : "failed",
        refreshedAt,
        entries: [],
        ...(inventoryError === undefined ? {} : { error: inventoryError }),
      });
      partitionsUpdated += 1;
      if (inventoryError !== undefined) {
        failures.push({
          partition: inventoryKey,
          runtime,
          code: inventoryError.code,
          message: inventoryError.message,
        });
      }
      saveCapabilityCache(cachePath, cache);
    }
  }

  saveCapabilityCache(cachePath, cache);
  return { cachePath, refreshedAt, partitionsUpdated, entriesWritten, warnings, failures };
}

function preserveInvalidCacheMcpSentinels(
  cache: CapabilityCache,
  workspaceKey: string | undefined,
  refreshedAt: string,
): void {
  cache.mcpSuppressedRuntimes = [...DISCOVERY_RUNTIMES];
  for (const runtime of DISCOVERY_RUNTIMES) {
    updateCapabilityPartition(cache, {
      key: `mcp:${runtime}:inventory:${workspaceKey ?? "global"}`,
      runtime,
      source: "mcp",
      ...(workspaceKey === undefined ? {} : { workspaceKey }),
      status: "failed",
      refreshedAt,
      entries: [],
      error: {
        code: "protocol",
        message: "The previous capability cache was invalid; exact MCP inventory is unavailable",
        at: refreshedAt,
      },
    });
  }
}

function checkpointRefreshStart(
  cache: CapabilityCache,
  runtimes: readonly McpRuntime[],
  includeCli: boolean,
  includeMcp: boolean,
  workspaceKey: string | undefined,
  refreshedAt: string,
): void {
  for (const partition of Object.values(cache.partitions)) {
    if (!runtimes.includes(partition.runtime as McpRuntime)) continue;
    const cliSource = partition.source === "cli-installed" || partition.source === "cli-project";
    const mcpSource =
      partition.source === "mcp" ||
      partition.source === "claude-plugin" ||
      partition.source === "codex-plugin";
    if ((cliSource && !includeCli) || (mcpSource && !includeMcp)) continue;
    if (!cliSource && !mcpSource) continue;
    if (mcpSource && partition.workspaceKey !== workspaceKey) continue;
    if (
      cliSource &&
      partition.workspaceKey !== undefined &&
      partition.workspaceKey !== workspaceKey
    )
      continue;
    partition.status = "stale";
    partition.refreshedAt = refreshedAt;
    partition.entries = partition.entries.map((entry) =>
      entry.details === undefined
        ? entry
        : { ...entry, details: { ...entry.details, availability: "stale" } },
    );
    partition.error = {
      code: "busy",
      message: "Capability refresh started but this partition has not completed yet",
      at: refreshedAt,
    };
  }
  if (includeMcp) {
    for (const runtime of runtimes) {
      const inventoryKey = `mcp:${runtime}:inventory:${workspaceKey ?? "global"}`;
      if (cache.partitions[inventoryKey] !== undefined) continue;
      updateCapabilityPartition(cache, {
        key: inventoryKey,
        runtime,
        source: "mcp",
        ...(workspaceKey === undefined ? {} : { workspaceKey }),
        status: "stale",
        refreshedAt,
        entries: [],
        error: {
          code: "busy",
          message: "Capability refresh started but the MCP inventory has not completed yet",
          at: refreshedAt,
        },
      });
    }
  }
  cache.updatedAt = refreshedAt;
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await action(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function markPluginPartitionsFailed(
  cache: CapabilityCache,
  runtime: McpRuntime,
  workspaceKey: string | undefined,
  refreshedAt: string,
  failures: RefreshFailure[],
): number {
  const source = runtime === "codex" ? "codex-plugin" : "claude-plugin";
  let updated = 0;
  for (const [key, partition] of Object.entries(cache.partitions)) {
    if (partition.source !== source || partition.runtime !== runtime) continue;
    if (partition.workspaceKey !== workspaceKey) continue;
    const error: CapabilityRefreshError = {
      code: "config",
      message: `${runtime} plugin inventory was incomplete; retaining the last known capabilities`,
      at: refreshedAt,
    };
    updateCapabilityPartition(cache, {
      ...partition,
      status: "failed",
      refreshedAt,
      entries: [],
      error,
    });
    failures.push({ partition: key, runtime, code: error.code, message: error.message });
    updated += 1;
  }
  return updated;
}

function cliEntries(
  discovery: InstalledCliDiscoveryResult,
  runtime: McpRuntime,
  scope: "global" | "project",
  observedAt: string,
): CatalogEntry[] {
  return discovery.commands
    .filter((item) => item.scope === scope)
    .map((item) => ({
      id: `${runtime}:cli-command:${scope}:${escapeId(item.name)}:${hash(item.executableRealPath)}`,
      kind: "cli-command" as const,
      name: item.name,
      description: item.description,
      runtime,
      scope,
      sourcePath: item.executablePath,
      details: {
        type: "cli-command" as const,
        executablePath: item.executablePath,
        executableRealPath: item.executableRealPath,
        commandPath: item.commandPath,
        invocationHint:
          item.scope === "project"
            ? [item.executablePath, ...item.commandPath.slice(1)].map(shellQuote).join(" ")
            : item.commandPath.map(shellQuote).join(" "),
        metadataSource: item.metadataSource,
        installManager: item.manager,
        packageName: item.packageName,
        ...(item.version === undefined ? {} : { version: item.version }),
        availability: "available" as const,
        observedAt,
      },
      meta: {
        installManager: item.manager,
        packageName: item.packageName,
        autocompleteSource: item.autocompleteSource,
      },
    }));
}

function mcpToolEntries(
  server: ResolvedMcpServer,
  tools: readonly ListedMcpTool[],
  observedAt: string,
): CatalogEntry[] {
  return tools.map((tool) => {
    const canonicalName = canonicalMcpToolName(server, tool.name);
    return {
      id: `${server.runtime}:mcp-tool:${server.scope}:${server.originKey}:${escapeId(server.name)}:${escapeId(tool.name)}`,
      kind: "mcp-tool",
      name: canonicalName,
      description: normaliseDescription(
        tool.description ?? tool.title ?? `MCP tool ${canonicalName}`,
      ),
      runtime: server.runtime,
      scope: server.scope,
      sourcePath: server.sourcePath,
      details: {
        type: "mcp-tool",
        client: server.runtime,
        server: server.name,
        tool: tool.name,
        scopeKey: server.scopeKey,
        configOrigin: server.sourcePath,
        canonicalName,
        availability: "available",
        observedAt,
      },
    };
  });
}

function mcpPartitionKey(server: ResolvedMcpServer): string {
  return `mcp:${server.runtime}:${server.scopeKey}:${server.originKey}:${escapeId(server.name)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function classifyRefreshError(error: unknown, at: string): CapabilityRefreshError {
  const message = sanitiseError(error instanceof Error ? error.message : String(error));
  const lower = message.toLowerCase();
  const code: CapabilityRefreshError["code"] =
    lower.includes("timeout") || lower.includes("abort")
      ? "timeout"
      : lower.includes("401") ||
          lower.includes("403") ||
          lower.includes("auth") ||
          lower.includes("unauthorized")
        ? "auth"
        : lower.includes("limit") || lower.includes("exceeded")
          ? "limit"
          : lower.includes("config") || lower.includes("url")
            ? "config"
            : "transport";
  return { code, message, at };
}

function sanitiseError(value: string): string {
  return replaceControlCharacters(
    value.replace(
      /(authorization|token|secret|password|api[-_]?key)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    ),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
