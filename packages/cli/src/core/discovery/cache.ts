import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  mkdir as mkdirAsync,
  open as openAsync,
  readFile as readFileAsync,
  rename as renameAsync,
  stat as statAsync,
  unlink as unlinkAsync,
} from "node:fs/promises";
import path from "node:path";
import {
  CATALOG_KINDS,
  CATALOG_RUNTIMES,
  CATALOG_SCOPES,
  type CatalogEntry,
  type CatalogRuntime,
} from "../catalog/types.js";
import { replaceControlCharacters } from "./text.js";

export const CAPABILITY_CACHE_VERSION = 2;

export type CapabilityPartitionSource =
  | "cli-installed"
  | "cli-project"
  | "cli-help"
  | "mcp"
  | "claude-plugin"
  | "codex-plugin";
export type CapabilityPartitionStatus = "fresh" | "stale" | "failed" | "disabled";

export interface CapabilityRefreshError {
  code: "auth" | "timeout" | "transport" | "protocol" | "trust" | "limit" | "config" | "busy";
  message: string;
  at: string;
}

export interface CapabilityPartition {
  key: string;
  runtime: CatalogRuntime;
  source: CapabilityPartitionSource;
  workspaceKey?: string;
  status: CapabilityPartitionStatus;
  refreshedAt: string;
  entries: CatalogEntry[];
  inputFingerprint?: string;
  error?: CapabilityRefreshError;
}

export interface CapabilityCache {
  version: typeof CAPABILITY_CACHE_VERSION;
  updatedAt: string;
  partitions: Record<string, CapabilityPartition>;
  /** Workspace-independent tombstone left after an unreadable cache loses exact MCP provenance. */
  mcpSuppressedRuntimes?: CatalogRuntime[];
}

export interface CapabilityCacheLoad {
  cache: CapabilityCache;
  warnings: string[];
  invalid: boolean;
}

export interface CapabilityCacheLockOptions {
  maxWaitMs?: number;
  retryMs?: number;
}

interface CapabilityRefreshMarker {
  version: 1;
  id: string;
  startedAt: string;
  runtimes: CatalogRuntime[];
  includeCli: boolean;
  includeMcp: boolean;
  /** New markers split global and workspace CLI state; absent means both for v1 compatibility. */
  cliScope?: "installed" | "project";
  workspaceKey?: string;
}

export interface CapabilityRefreshMarkerBatch {
  markers: CapabilityRefreshMarker[];
}

export class CapabilityRefreshMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRefreshMarkerError";
  }
}

type RefreshDimension =
  | { runtime: CatalogRuntime; source: "cli-installed" }
  | { runtime: CatalogRuntime; source: "cli-project"; workspaceKey?: string }
  | { runtime: CatalogRuntime; source: "mcp"; workspaceKey?: string };

/**
 * Publish fail-closed refresh intent before waiting for the shared discovery lock. Async
 * SessionStart jobs can queue behind one another, but a queued or killed job must never leave its
 * old partitions looking fresh in the meantime.
 */
export function beginCapabilityRefreshMarker(
  cacheFile: string,
  input: Omit<CapabilityRefreshMarker, "version" | "id" | "cliScope">,
): CapabilityRefreshMarkerBatch {
  const dir = refreshMarkerDir(cacheFile);
  const guard: CapabilityRefreshMarker = { version: 1, id: randomUUID(), ...input };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Publish aggregate intent first. If a later atomic write fails, this guard stays behind and
    // hides the entire requested surface instead of only the subset written before ENOSPC/EIO.
    writeRefreshMarker(dir, guard);
    const markers: CapabilityRefreshMarker[] = [];
    for (const runtime of input.runtimes) {
      if (input.includeCli) {
        markers.push({
          version: 1,
          id: randomUUID(),
          startedAt: input.startedAt,
          runtimes: [runtime],
          includeCli: true,
          includeMcp: false,
          cliScope: "installed",
        });
        markers.push({
          version: 1,
          id: randomUUID(),
          startedAt: input.startedAt,
          runtimes: [runtime],
          includeCli: true,
          includeMcp: false,
          cliScope: "project",
          ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
        });
      }
      if (input.includeMcp) {
        markers.push({
          version: 1,
          id: randomUUID(),
          startedAt: input.startedAt,
          runtimes: [runtime],
          includeCli: false,
          includeMcp: true,
          ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
        });
      }
    }
    for (const marker of markers) writeRefreshMarker(dir, marker);
    unlinkSync(path.join(dir, `${guard.id}.json`));
    return { markers };
  } catch (error) {
    throw new CapabilityRefreshMarkerError(
      `Could not publish fail-closed capability refresh intent: ${(error as Error).message}`,
    );
  }
}

/**
 * Clear every dimension covered by this persisted checkpoint, including matching dimensions from
 * an older abandoned aggregate marker. Any uncovered dimensions are rewritten as atomic markers.
 */
export function completeCapabilityRefreshMarkers(
  cacheFile: string,
  completed: CapabilityRefreshMarkerBatch,
  dependencies: { writeMarker?: typeof writeRefreshMarker } = {},
): void {
  const loaded = loadRefreshMarkers(cacheFile);
  const publish = dependencies.writeMarker ?? writeRefreshMarker;
  for (const marker of loaded.markers) {
    const remaining = markerDimensions(marker).filter(
      (dimension) => !completedCovers(completed.markers, marker.startedAt, dimension),
    );
    if (remaining.length === markerDimensions(marker).length) continue;
    // Publish every uncovered dimension before removing the aggregate. If disk publication fails,
    // the old marker remains a conservative guard instead of exposing stale cache as fresh.
    for (const dimension of remaining) {
      publish(refreshMarkerDir(cacheFile), markerForDimension(marker.startedAt, dimension));
    }
    try {
      unlinkSync(path.join(refreshMarkerDir(cacheFile), `${marker.id}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function writeRefreshMarker(dir: string, marker: CapabilityRefreshMarker): void {
  writeFileSync(path.join(dir, `${marker.id}.json`), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function markerForDimension(
  startedAt: string,
  dimension: RefreshDimension,
): CapabilityRefreshMarker {
  const base = {
    version: 1 as const,
    id: randomUUID(),
    startedAt,
    runtimes: [dimension.runtime],
  };
  if (dimension.source === "mcp") {
    return {
      ...base,
      includeCli: false,
      includeMcp: true,
      ...(dimension.workspaceKey === undefined ? {} : { workspaceKey: dimension.workspaceKey }),
    };
  }
  return {
    ...base,
    includeCli: true,
    includeMcp: false,
    cliScope: dimension.source === "cli-installed" ? "installed" : "project",
    ...(dimension.source === "cli-project" && dimension.workspaceKey !== undefined
      ? { workspaceKey: dimension.workspaceKey }
      : {}),
  };
}

function markerDimensions(marker: CapabilityRefreshMarker): RefreshDimension[] {
  const dimensions: RefreshDimension[] = [];
  for (const runtime of marker.runtimes) {
    if (marker.includeCli && marker.cliScope !== "project") {
      dimensions.push({ runtime, source: "cli-installed" });
    }
    if (marker.includeCli && marker.cliScope !== "installed") {
      dimensions.push({
        runtime,
        source: "cli-project",
        ...(marker.workspaceKey === undefined ? {} : { workspaceKey: marker.workspaceKey }),
      });
    }
    if (marker.includeMcp) {
      dimensions.push({
        runtime,
        source: "mcp",
        ...(marker.workspaceKey === undefined ? {} : { workspaceKey: marker.workspaceKey }),
      });
    }
  }
  return dimensions;
}

function completedCovers(
  completed: readonly CapabilityRefreshMarker[],
  startedAt: string,
  dimension: RefreshDimension,
): boolean {
  return completed.some(
    (marker) =>
      marker.startedAt >= startedAt &&
      markerDimensions(marker).some((candidate) => sameDimension(candidate, dimension)),
  );
}

function sameDimension(left: RefreshDimension, right: RefreshDimension): boolean {
  if (left.runtime !== right.runtime || left.source !== right.source) return false;
  if (left.source === "cli-installed" || right.source === "cli-installed") return true;
  return left.workspaceKey === right.workspaceKey;
}

/** Serialise read-modify-write refreshes from concurrent agent session starts. */
export async function withCapabilityCacheLock<T>(
  cacheFile: string,
  action: () => Promise<T>,
  options: CapabilityCacheLockOptions = {},
): Promise<T> {
  const lockFile = `${cacheFile}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const started = Date.now();
  const maxWaitMs = options.maxWaitMs ?? 100_000;
  const retryMs = options.retryMs ?? 50;
  await mkdirAsync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });

  while (true) {
    let handle: FileHandle;
    try {
      handle = await openAsync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverAbandonedLock(lockFile);
      if (Date.now() - started >= maxWaitMs) {
        throw new Error(`Capability cache is busy after ${maxWaitMs}ms: ${lockFile}`);
      }
      await delay(retryMs);
      continue;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await releaseOwnedLock(lockFile);
    }
  }
}

export function defaultCapabilityCachePath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const root = env["XDG_CACHE_HOME"]?.trim() || path.join(homeDir, ".cache");
  return path.join(root, "skillful", "capabilities-v2.json");
}

export function emptyCapabilityCache(now = new Date().toISOString()): CapabilityCache {
  return { version: CAPABILITY_CACHE_VERSION, updatedAt: now, partitions: {} };
}

export function loadCapabilityCache(file: string): CapabilityCacheLoad {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isCapabilityCache(parsed)) {
      return {
        cache: emptyCapabilityCache(),
        warnings: [`Capability cache ${file} has an unsupported version or shape; ignoring it.`],
        invalid: true,
      };
    }
    return { cache: parsed, warnings: [], invalid: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { cache: emptyCapabilityCache(), warnings: [], invalid: false };
    }
    return {
      cache: emptyCapabilityCache(),
      warnings: [`Capability cache ${file} is not valid JSON: ${(error as Error).message}`],
      invalid: true,
    };
  }
}

/**
 * Atomically replace the cache. The file is private because source paths and MCP names can be
 * sensitive even though credentials are never serialised.
 */
export function saveCapabilityCache(file: string, cache: CapabilityCache): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // The rename may already have consumed it.
    }
    throw error;
  }
}

/**
 * Apply one independently refreshable source. A failure never masquerades as an empty success:
 * the last good records are retained and explicitly marked stale.
 */
export function updateCapabilityPartition(cache: CapabilityCache, next: CapabilityPartition): void {
  const previous = cache.partitions[next.key];
  if (next.status === "failed" && previous !== undefined && previous.entries.length > 0) {
    cache.partitions[next.key] = {
      ...previous,
      status: "stale",
      refreshedAt: next.refreshedAt,
      entries: previous.entries.map(markStale),
      ...(next.error === undefined ? {} : { error: next.error }),
    };
  } else {
    cache.partitions[next.key] = next;
  }
  cache.updatedAt = next.refreshedAt;
}

export interface ReadCapabilityEntriesOptions {
  runtimes?: readonly CatalogRuntime[];
  workspaceKey?: string;
}

export function readCapabilityEntries(
  file: string,
  options: ReadCapabilityEntriesOptions = {},
): { entries: CatalogEntry[]; warnings: string[]; mcpInventoryRuntimes: CatalogRuntime[] } {
  const loaded = loadCapabilityCache(file);
  const warnings = [...loaded.warnings];
  const entries: CatalogEntry[] = [];
  const mcpInventoryRuntimes = new Set<CatalogRuntime>();
  const refreshMarkers = loadRefreshMarkers(file);
  warnings.push(...refreshMarkers.warnings);
  for (const marker of refreshMarkers.markers) {
    for (const dimension of markerDimensions(marker)) {
      if (dimension.source !== "mcp") continue;
      if (options.runtimes !== undefined && !options.runtimes.includes(dimension.runtime)) continue;
      if (dimension.workspaceKey !== options.workspaceKey) continue;
      mcpInventoryRuntimes.add(dimension.runtime);
    }
  }
  if (refreshMarkers.invalid) {
    for (const runtime of options.runtimes ?? CATALOG_RUNTIMES) {
      mcpInventoryRuntimes.add(runtime);
    }
  }
  if (loaded.invalid) {
    for (const runtime of options.runtimes ?? CATALOG_RUNTIMES) {
      mcpInventoryRuntimes.add(runtime);
    }
  }
  for (const runtime of loaded.cache.mcpSuppressedRuntimes ?? []) {
    if (options.runtimes === undefined || options.runtimes.includes(runtime)) {
      mcpInventoryRuntimes.add(runtime);
    }
  }
  for (const partition of Object.values(loaded.cache.partitions)) {
    if (options.runtimes !== undefined && !options.runtimes.includes(partition.runtime)) {
      continue;
    }
    // MCP availability is always an effective-workspace fact, including servers originating in
    // user config: a project may disable, override, or filter them. Never reuse a projectless MCP
    // inventory inside a project (or vice versa). Other global sources such as installed CLIs are
    // intentionally reusable across workspaces.
    const workspaceEffective =
      partition.source === "mcp" ||
      partition.source === "claude-plugin" ||
      partition.source === "codex-plugin";
    if (
      workspaceEffective
        ? partition.workspaceKey !== options.workspaceKey
        : partition.workspaceKey !== undefined && partition.workspaceKey !== options.workspaceKey
    ) {
      continue;
    }
    // Even while exact tools are hidden by an in-progress marker, remember that this runtime has
    // an effective MCP inventory. The scanner must not fall back to broad config-only MCP server
    // suggestions while the exact inventory is being refreshed.
    if (partition.source === "mcp") mcpInventoryRuntimes.add(partition.runtime);
    if (
      refreshMarkers.invalid ||
      refreshMarkers.markers.some((marker) => markerInvalidatesPartition(marker, partition))
    ) {
      warnings.push(`Capability partition ${partition.key} has a refresh in progress`);
      continue;
    }
    if (partition.error !== undefined) {
      warnings.push(
        `Capability partition ${partition.key} is ${partition.status}: ${boundedDiagnostic(partition.error.message)}`,
      );
    }
    if (
      partition.status === "disabled" ||
      partition.status === "failed" ||
      partition.status === "stale"
    ) {
      continue;
    }
    entries.push(...partition.entries);
  }
  return {
    entries,
    warnings,
    mcpInventoryRuntimes: [...mcpInventoryRuntimes].sort(),
  };
}

function refreshMarkerDir(cacheFile: string): string {
  return `${cacheFile}.refreshing`;
}

function loadRefreshMarkers(cacheFile: string): {
  markers: CapabilityRefreshMarker[];
  warnings: string[];
  invalid: boolean;
} {
  const dir = refreshMarkerDir(cacheFile);
  const markers: CapabilityRefreshMarker[] = [];
  const warnings: string[] = [];
  let invalid = false;
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { markers, warnings, invalid };
    return {
      markers,
      warnings: [
        `Capability refresh markers are unreadable: ${boundedDiagnostic((error as Error).message)}`,
      ],
      invalid: true,
    };
  }
  for (const name of files) {
    try {
      const value: unknown = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (!isCapabilityRefreshMarker(value) || `${value.id}.json` !== name) {
        throw new Error("invalid marker schema");
      }
      markers.push(value);
    } catch (error) {
      invalid = true;
      warnings.push(
        `Capability refresh marker ${name} is invalid: ${boundedDiagnostic((error as Error).message)}`,
      );
    }
  }
  return { markers, warnings, invalid };
}

function isCapabilityRefreshMarker(value: unknown): value is CapabilityRefreshMarker {
  if (!isRecord(value)) return false;
  return (
    value["version"] === 1 &&
    nonEmptyString(value["id"]) &&
    typeof value["startedAt"] === "string" &&
    Array.isArray(value["runtimes"]) &&
    value["runtimes"].length > 0 &&
    value["runtimes"].every((runtime) => CATALOG_RUNTIMES.includes(runtime as CatalogRuntime)) &&
    typeof value["includeCli"] === "boolean" &&
    typeof value["includeMcp"] === "boolean" &&
    (value["cliScope"] === undefined ||
      value["cliScope"] === "installed" ||
      value["cliScope"] === "project") &&
    (value["workspaceKey"] === undefined || typeof value["workspaceKey"] === "string")
  );
}

function markerInvalidatesPartition(
  marker: CapabilityRefreshMarker,
  partition: CapabilityPartition,
): boolean {
  const source =
    partition.source === "cli-installed"
      ? "cli-installed"
      : partition.source === "cli-project"
        ? "cli-project"
        : "mcp";
  const dimension: RefreshDimension =
    source === "cli-installed"
      ? { runtime: partition.runtime, source }
      : {
          runtime: partition.runtime,
          source,
          ...(partition.workspaceKey === undefined ? {} : { workspaceKey: partition.workspaceKey }),
        };
  return markerDimensions(marker).some((candidate) => sameDimension(candidate, dimension));
}

function markStale(entry: CatalogEntry): CatalogEntry {
  if (entry.details === undefined) return entry;
  return { ...entry, details: { ...entry.details, availability: "stale" } };
}

function isCapabilityCache(value: unknown): value is CapabilityCache {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== CAPABILITY_CACHE_VERSION ||
    typeof record["updatedAt"] !== "string" ||
    !isRecord(record["partitions"])
  ) {
    return false;
  }
  if (
    record["mcpSuppressedRuntimes"] !== undefined &&
    (!Array.isArray(record["mcpSuppressedRuntimes"]) ||
      !record["mcpSuppressedRuntimes"].every((runtime) => MCP_CLIENTS.has(runtime)))
  ) {
    return false;
  }
  for (const [key, rawPartition] of Object.entries(record["partitions"])) {
    if (!isRecord(rawPartition) || rawPartition["key"] !== key) return false;
    if (!CATALOG_RUNTIMES.includes(rawPartition["runtime"] as CatalogRuntime)) return false;
    if (!PARTITION_SOURCES.has(rawPartition["source"])) return false;
    if (!PARTITION_STATUSES.has(rawPartition["status"])) return false;
    if (typeof rawPartition["refreshedAt"] !== "string") return false;
    if (
      rawPartition["workspaceKey"] !== undefined &&
      typeof rawPartition["workspaceKey"] !== "string"
    )
      return false;
    if (
      rawPartition["inputFingerprint"] !== undefined &&
      typeof rawPartition["inputFingerprint"] !== "string"
    )
      return false;
    if (rawPartition["error"] !== undefined && !isRefreshError(rawPartition["error"])) return false;
    if (!Array.isArray(rawPartition["entries"])) return false;
    for (const entry of rawPartition["entries"]) {
      if (!isCatalogEntry(entry, rawPartition["runtime"] as CatalogRuntime)) return false;
    }
  }
  return true;
}

const PARTITION_SOURCES = new Set<unknown>([
  "cli-installed",
  "cli-project",
  "cli-help",
  "mcp",
  "claude-plugin",
  "codex-plugin",
]);
const PARTITION_STATUSES = new Set<unknown>(["fresh", "stale", "failed", "disabled"]);

function isCatalogEntry(value: unknown, runtime: CatalogRuntime): value is CatalogEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value["id"] !== "string" ||
    typeof value["name"] !== "string" ||
    typeof value["description"] !== "string" ||
    typeof value["sourcePath"] !== "string" ||
    value["runtime"] !== runtime ||
    !CATALOG_KINDS.includes(value["kind"] as CatalogEntry["kind"]) ||
    !CATALOG_SCOPES.includes(value["scope"] as CatalogEntry["scope"])
  ) {
    return false;
  }
  return value["details"] === undefined || isCatalogEntryDetails(value["details"], value);
}

const AVAILABILITY = new Set<unknown>(["available", "stale", "disabled", "unknown"]);
const MCP_CLIENTS = new Set<unknown>(["codex", "claude-code"]);
const CLI_METADATA_SOURCES = new Set<unknown>([
  "basename",
  "help",
  "carapace",
  "homebrew-completion",
  "zsh-completion",
]);
const CLI_MANAGERS = new Set<unknown>(["homebrew", "uv", "pnpm", "npm", "bun"]);
const ERROR_CODES = new Set<unknown>([
  "auth",
  "timeout",
  "transport",
  "protocol",
  "trust",
  "limit",
  "config",
  "busy",
]);

function isCatalogEntryDetails(value: unknown, entry: Record<string, unknown>): boolean {
  if (!isRecord(value) || !AVAILABILITY.has(value["availability"])) return false;
  if (typeof value["observedAt"] !== "string") return false;
  if (value["type"] === "mcp-tool") {
    return (
      entry["kind"] === "mcp-tool" &&
      MCP_CLIENTS.has(value["client"]) &&
      value["client"] === entry["runtime"] &&
      nonEmptyString(value["server"]) &&
      nonEmptyString(value["tool"]) &&
      nonEmptyString(value["scopeKey"]) &&
      nonEmptyString(value["configOrigin"]) &&
      nonEmptyString(value["canonicalName"])
    );
  }
  if (value["type"] !== "cli-command" || entry["kind"] !== "cli-command") return false;
  if (
    !nonEmptyString(value["executablePath"]) ||
    !nonEmptyString(value["executableRealPath"]) ||
    !Array.isArray(value["commandPath"]) ||
    value["commandPath"].length === 0 ||
    !value["commandPath"].every(nonEmptyString) ||
    !nonEmptyString(value["invocationHint"]) ||
    !CLI_METADATA_SOURCES.has(value["metadataSource"])
  ) {
    return false;
  }
  if (value["installManager"] !== undefined && !CLI_MANAGERS.has(value["installManager"]))
    return false;
  if (value["packageName"] !== undefined && !nonEmptyString(value["packageName"])) return false;
  if (value["version"] !== undefined && !nonEmptyString(value["version"])) return false;
  return true;
}

function isRefreshError(value: unknown): boolean {
  return (
    isRecord(value) &&
    ERROR_CODES.has(value["code"]) &&
    typeof value["message"] === "string" &&
    typeof value["at"] === "string"
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function boundedDiagnostic(value: string, limit = 300): string {
  const oneLine = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function releaseOwnedLock(lockFile: string): Promise<void> {
  try {
    await unlinkAsync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function recoverAbandonedLock(lockFile: string): Promise<void> {
  let abandoned = false;
  try {
    const current = JSON.parse(await readFileAsync(lockFile, "utf8")) as { pid?: unknown };
    if (typeof current.pid === "number" && Number.isInteger(current.pid) && current.pid > 0) {
      abandoned = !processExists(current.pid);
    } else {
      abandoned = Date.now() - (await statAsync(lockFile)).mtimeMs > 5 * 60_000;
    }
  } catch {
    try {
      abandoned = Date.now() - (await statAsync(lockFile)).mtimeMs > 5 * 60_000;
    } catch {
      return;
    }
  }
  if (!abandoned) return;
  const quarantine = `${lockFile}.abandoned.${process.pid}.${randomUUID()}`;
  try {
    await renameAsync(lockFile, quarantine);
    await unlinkAsync(quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
