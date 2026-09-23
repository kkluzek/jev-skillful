import { createHash } from "node:crypto";
import {
  chmodSync,
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CATALOG_KINDS, type CatalogKind } from "../catalog/types.js";

export const ADAPTIVE_STATE_VERSION = 1;
export const ADAPTIVE_STATE_TTL_MS = 24 * 60 * 60 * 1_000;

export const ADAPTIVE_PHASES = [
  "intent",
  "discovery",
  "implementation",
  "verification",
  "browser",
  "external",
  "artifact",
  "other",
] as const;
export type AdaptivePhase = (typeof ADAPTIVE_PHASES)[number];

export interface StoredCapability {
  id: string;
  kind: CatalogKind;
  name: string;
  description: string;
  sourcePath: string;
  invocationHint?: string;
  confidence: number;
  noneP: number;
  probability: number;
}

export interface AdaptiveSessionState {
  version: typeof ADAPTIVE_STATE_VERSION;
  promptId: string;
  goal: string;
  updatedAt: number;
  batchCount: number;
  phase: AdaptivePhase;
  normalInterventions: number;
  recoveryInterventions: number;
  shownIds: string[];
  usedIds: string[];
  lastEvidenceHash?: string;
  primary?: StoredCapability;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateDir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX mode support.
  }
}

export function adaptiveStateRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const stateHome = env["XDG_STATE_HOME"]?.trim() || path.join(homeDir, ".local", "state");
  return path.join(stateHome, "skillful", "adaptive-v1");
}

export function adaptiveSessionDir(root: string, sessionId: string): string {
  return path.join(root, "sessions", hash(sessionId));
}

export function adaptiveStatePath(root: string, sessionId: string, agentId?: string): string {
  const file =
    agentId === undefined || agentId.length === 0 ? "main.json" : `${hash(agentId)}.json`;
  return path.join(adaptiveSessionDir(root, sessionId), file);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function storedCapability(value: unknown): value is StoredCapability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["kind"] === "string" &&
    CATALOG_KINDS.includes(record["kind"] as CatalogKind) &&
    typeof record["name"] === "string" &&
    typeof record["description"] === "string" &&
    typeof record["sourcePath"] === "string" &&
    (record["invocationHint"] === undefined || typeof record["invocationHint"] === "string") &&
    finiteNumber(record["confidence"]) &&
    finiteNumber(record["noneP"]) &&
    finiteNumber(record["probability"])
  );
}

export function readAdaptiveState(filePath: string): AdaptiveSessionState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record["version"] !== ADAPTIVE_STATE_VERSION ||
      typeof record["promptId"] !== "string" ||
      typeof record["goal"] !== "string" ||
      !finiteNumber(record["updatedAt"]) ||
      !finiteNumber(record["batchCount"]) ||
      typeof record["phase"] !== "string" ||
      !ADAPTIVE_PHASES.includes(record["phase"] as AdaptivePhase) ||
      !finiteNumber(record["normalInterventions"]) ||
      !finiteNumber(record["recoveryInterventions"]) ||
      !stringArray(record["shownIds"]) ||
      !stringArray(record["usedIds"]) ||
      (record["lastEvidenceHash"] !== undefined &&
        typeof record["lastEvidenceHash"] !== "string") ||
      (record["primary"] !== undefined && !storedCapability(record["primary"]))
    ) {
      return null;
    }
    return record as unknown as AdaptiveSessionState;
  } catch {
    return null;
  }
}

export function writeAdaptiveState(filePath: string, state: AdaptiveSessionState): void {
  privateDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX mode support.
  }
}

export function removeAdaptiveSession(root: string, sessionId: string): void {
  rmSync(adaptiveSessionDir(root, sessionId), { recursive: true, force: true });
}

export function pruneAdaptiveSessions(
  root: string,
  now = Date.now(),
  ttlMs = ADAPTIVE_STATE_TTL_MS,
): void {
  const sessionsRoot = path.join(root, "sessions");
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true }).slice(0, 256);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
    const target = path.join(sessionsRoot, entry.name);
    try {
      if (now - statSync(target).mtimeMs > ttlMs) {
        rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best effort and never affects the active prompt.
    }
  }
}
