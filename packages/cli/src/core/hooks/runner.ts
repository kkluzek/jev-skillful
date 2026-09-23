/**
 * The hook's decision path: prompt in, injection text out, and never a thrown error.
 *
 * This is the code that runs on every single prompt the user types, inside their agent, with a
 * two-second budget. Three rules dominate the design:
 *
 * 1. **Nothing escapes.** Every failure — no key, bad config, dead network, unreadable catalog,
 *    exhausted budget — produces a valid, injectable-or-empty answer. A hook that crashes the
 *    host agent is worse than a hook that suggests nothing, so the guarantee is enforced by a
 *    top-level catch here rather than trusted to each layer.
 * 2. **The budget is the ceiling, not the target.** Catalog scanning and routing share one
 *    deadline. If the scan alone eats it, the route is abandoned rather than started late.
 * 3. **Degrading never costs the user their prompt.** A degraded run injects one short
 *    reminder or nothing at all; it never blocks, never retries indefinitely, never prints.
 *
 * `SKILLFUL_DISABLE=1` short-circuits before any work, which is also the control arm the
 * outcome benchmark uses in phase 7.
 */

import { createHash } from "node:crypto";
import type { Catalog, CatalogEntry, CatalogRuntime } from "../catalog/types.js";
import { type ResolvedConfig, resolveConfig } from "../config/resolve.js";
import { resolveJevTarget } from "../jev/client.js";
import { type RouteResult, route } from "../router/route.js";
import { eventsPath, type PathContext } from "../telemetry/paths.js";
import { buildRouteEvent, isTelemetryDisabled, writeEvent } from "../telemetry/writer.js";
import {
  ADAPTIVE_MAX_CHARS,
  buildAdaptivePrompt,
  capabilityWasUsed,
  isAdaptiveDisabled,
  observeBatch,
  shouldRouteBatch,
} from "./adaptive.js";
import {
  ADAPTIVE_STATE_VERSION,
  type AdaptiveSessionState,
  adaptiveStatePath,
  adaptiveStateRoot,
  pruneAdaptiveSessions,
  readAdaptiveState,
  removeAdaptiveSession,
  type StoredCapability,
  writeAdaptiveState,
} from "./adaptive-state.js";
import {
  cacheGet,
  cacheSet,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  loadCache,
  pruneCache,
  routeCacheKey,
  saveCache,
} from "./cache.js";
import { DEGRADED_REMINDER, degradedReminder } from "./degrade.js";
import { renderInjection } from "./render.js";

/** Environment variable that turns the hook off entirely, with no other effect. */
export const DISABLE_ENV = "SKILLFUL_DISABLE";

export interface HookToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
}

export interface HookInput {
  prompt: string;
  runtime?: CatalogRuntime;
  session_id?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
  tool_calls?: HookToolCall[];
}

/** The stdout shape Claude Code and Codex both accept. */
export interface HookPayload {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

export interface HookDeps {
  homeDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Injected so tests never touch the real machine. */
  scan: (options: {
    homeDir: string;
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
    runtimes?: readonly CatalogRuntime[];
    includeCachedCapabilities?: boolean;
  }) => Promise<Catalog>;
  /** Injected so tests can supply recorded responses. */
  routeFn?: typeof route;
  /** Route cache location. Defaults to `~/.cache/skillful/routes.json`. */
  cachePath?: string;
  /** Telemetry log location. Defaults to the platform state directory. */
  telemetryPath?: string;
  /** Overrides platform detection for the telemetry path. Tests use it. */
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface HookOutcome {
  /** Exactly what to print. `{}` when there is nothing to inject. */
  payload: HookPayload;
  /** The routing result, when one was produced. Absent for disabled or failed runs. */
  result?: RouteResult;
  cacheHit: boolean;
  /** True when the run could not produce a decision. */
  degraded: boolean;
  /** Human-readable reason, for `doctor` and telemetry. Never printed by the hook. */
  reason?: string;
  elapsedMs: number;
  /** Commit delivery-dependent dedupe only after stdout was flushed successfully. */
  acknowledge?: () => void;
}

/**
 * Record a routing event.
 *
 * Called **after** the payload has been decided, so nothing about it can extend the time the user
 * waits for a decision. Every failure mode is swallowed inside `writeEvent`; this wrapper only
 * decides whether to attempt a write at all.
 *
 * Prompt text is never passed here. The event carries a hash and a character count, which is enough
 * to correlate a later observation and not enough to read what the user typed.
 */
function recordRoute(
  result: RouteResult,
  deps: HookDeps,
  input: HookInput,
  promptHash: string,
  catalogFingerprint: string,
): void {
  if (isTelemetryDisabled(deps.env)) return;

  const pathCtx: PathContext = {
    homeDir: deps.homeDir,
    env: deps.env,
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };

  writeEvent(
    buildRouteEvent({
      result,
      runtime: input.hook_event_name === undefined ? "cli" : "hook",
      sessionId: input.session_id ?? "unknown",
      promptHash,
      catalogFingerprint,
    }),
    {
      filePath: deps.telemetryPath ?? eventsPath(pathCtx),
      now: () => new Date(),
    },
  );
}

function promptId(input: HookInput, prompt: string): string {
  return input.prompt_id?.trim() || createHash("sha256").update(prompt).digest("hex").slice(0, 32);
}

function adaptiveFile(
  input: HookInput,
  deps: HookDeps,
  agentId: string | null | undefined = input.agent_id,
): string | null {
  if (input.runtime !== "claude-code" || (input.session_id?.trim() ?? "") === "") return null;
  return adaptiveStatePath(
    adaptiveStateRoot(deps.homeDir, deps.env),
    input.session_id as string,
    agentId === null ? undefined : agentId,
  );
}

function beginPromptState(
  input: HookInput,
  deps: HookDeps,
  prompt: string,
  timestamp: number,
): string | null {
  const filePath = adaptiveFile(input, deps, null);
  if (filePath === null) return null;
  try {
    pruneAdaptiveSessions(adaptiveStateRoot(deps.homeDir, deps.env), timestamp);
  } catch {
    // Cleanup is best effort and must not affect prompt routing.
  }
  const state: AdaptiveSessionState = {
    version: ADAPTIVE_STATE_VERSION,
    promptId: promptId(input, prompt),
    goal: prompt.slice(0, 1_000),
    updatedAt: timestamp,
    batchCount: 0,
    phase: "intent",
    normalInterventions: 0,
    recoveryInterventions: 0,
    shownIds: [],
    usedIds: [],
  };
  try {
    writeAdaptiveState(filePath, state);
    return filePath;
  } catch {
    return null;
  }
}

function storedCapability(result: RouteResult): StoredCapability | null {
  if (result.decision.kind !== "injected") return null;
  const pick = result.decision.primary;
  return {
    id: pick.id,
    kind: pick.kind,
    name: pick.name,
    description: pick.description,
    sourcePath: pick.sourcePath,
    ...(pick.invocationHint === undefined ? {} : { invocationHint: pick.invocationHint }),
    confidence: result.primary?.confidence ?? result.decision.confidence,
    noneP: result.primary?.noneP ?? result.decision.noneP,
    probability: result.primary?.probability ?? 0,
  };
}

function stagePromptRecommendation(
  outcome: HookOutcome,
  result: RouteResult,
  filePath: string | null,
  timestamp: number,
): HookOutcome {
  const capability = storedCapability(result);
  if (filePath === null || capability === null) return outcome;
  const state = readAdaptiveState(filePath);
  if (state === null) return outcome;
  try {
    writeAdaptiveState(filePath, { ...state, primary: capability, updatedAt: timestamp });
  } catch {
    return outcome;
  }
  const previous = outcome.acknowledge;
  return {
    ...outcome,
    acknowledge: () => {
      previous?.();
      const latest = readAdaptiveState(filePath);
      if (latest === null || latest.promptId !== state.promptId) return;
      if (!latest.shownIds.includes(capability.id)) latest.shownIds.push(capability.id);
      latest.updatedAt = timestamp;
      try {
        writeAdaptiveState(filePath, latest);
      } catch {
        // Delivery succeeded; losing dedupe state must not disturb the host.
      }
    },
  };
}

function emptyOutcome(
  startedAt: number,
  now: () => number,
  reason: string,
  degraded = false,
): HookOutcome {
  return {
    payload: {},
    cacheHit: false,
    degraded,
    reason,
    elapsedMs: now() - startedAt,
  };
}

function acknowledgeAdaptiveInjection(
  filePath: string,
  expectedPromptId: string,
  capability: StoredCapability,
  recovery: boolean,
  now: () => number,
): () => void {
  return () => {
    const latest = readAdaptiveState(filePath);
    if (latest === null || latest.promptId !== expectedPromptId) return;
    if (!latest.shownIds.includes(capability.id)) latest.shownIds.push(capability.id);
    latest.primary = capability;
    if (recovery) latest.recoveryInterventions += 1;
    else latest.normalInterventions += 1;
    latest.updatedAt = now();
    try {
      writeAdaptiveState(filePath, latest);
    } catch {
      // Delivery succeeded; losing dedupe state must not disturb the host.
    }
  };
}

async function runAdaptiveBatch(
  input: HookInput,
  deps: HookDeps,
  startedAt: number,
  now: () => number,
): Promise<HookOutcome> {
  if (isAdaptiveDisabled(deps.env)) {
    return emptyOutcome(startedAt, now, "adaptive routing disabled", false);
  }
  const filePath = adaptiveFile(input, deps);
  if (filePath === null) return emptyOutcome(startedAt, now, "missing adaptive session", false);
  const state = readAdaptiveState(filePath);
  if (state === null) return emptyOutcome(startedAt, now, "adaptive session not found", false);
  if (input.prompt_id !== undefined && input.prompt_id !== state.promptId) {
    return emptyOutcome(startedAt, now, "stale adaptive prompt", false);
  }

  const calls = input.tool_calls ?? [];
  const observation = observeBatch(calls);
  const adoptedCurrent = capabilityWasUsed(state.primary, calls);
  if (adoptedCurrent && state.primary !== undefined) {
    if (!state.usedIds.includes(state.primary.id)) state.usedIds.push(state.primary.id);
  }
  const eligible =
    (!adoptedCurrent || observation.recovery) && shouldRouteBatch(state, observation);
  const nextState: AdaptiveSessionState = {
    ...state,
    batchCount: state.batchCount + 1,
    phase: observation.phase,
    lastEvidenceHash: observation.evidenceHash,
    updatedAt: now(),
  };
  try {
    writeAdaptiveState(filePath, nextState);
  } catch {
    return emptyOutcome(startedAt, now, "adaptive state write failed", true);
  }
  if (!eligible) return emptyOutcome(startedAt, now, "adaptive gate abstained", false);

  const resolved = resolveConfig({ env: deps.env, homeDir: deps.homeDir });
  const { config } = resolved;
  try {
    resolveJevTarget({
      provider: config.provider,
      env: deps.env,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  } catch (error) {
    return emptyOutcome(startedAt, now, (error as Error).message, true);
  }

  let catalog: Catalog;
  try {
    catalog = await deps.scan({
      homeDir: deps.homeDir,
      cwd: deps.cwd,
      env: deps.env,
      ...(input.runtime === undefined ? {} : { runtimes: [input.runtime] }),
      includeCachedCapabilities: true,
    });
  } catch (error) {
    return emptyOutcome(startedAt, now, `catalog scan failed: ${(error as Error).message}`, true);
  }

  const usedInBatch = catalog.entries
    .filter((entry) =>
      capabilityWasUsed(
        {
          kind: entry.kind,
          name: entry.name,
          ...(entry.details?.type === "cli-command"
            ? { invocationHint: entry.details.invocationHint }
            : {}),
        },
        calls,
      ),
    )
    .map((entry) => entry.id);
  for (const id of usedInBatch) {
    if (!nextState.usedIds.includes(id)) nextState.usedIds.push(id);
  }
  if (usedInBatch.length > 0) {
    try {
      writeAdaptiveState(filePath, nextState);
    } catch {
      return emptyOutcome(startedAt, now, "adaptive adoption state write failed", true);
    }
    if (!observation.recovery) {
      return emptyOutcome(startedAt, now, "current batch already used a capability", false);
    }
  }

  const excluded = new Set([...nextState.shownIds, ...nextState.usedIds]);
  const task = buildAdaptivePrompt(nextState, observation);
  const result = await (deps.routeFn ?? route)(task, {
    entries: catalog.entries.filter((entry) => !excluded.has(entry.id)),
    thresholds: { ...config.thresholds, maxRunnersUp: 0 },
    quotaGroups: config.quotaGroups,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    uploadPrompt: config.uploadPrompt,
    jev: { env: deps.env },
  });

  const promptHash = routeCacheKey(task, catalog.fingerprint, "adaptive").slice(0, 32);
  recordRoute(result, deps, input, promptHash, catalog.fingerprint);
  if (result.decision.kind !== "injected") {
    return {
      ...emptyOutcome(
        startedAt,
        now,
        result.decision.kind === "degraded" ? result.decision.reason : result.decision.reason,
        result.decision.kind === "degraded",
      ),
      result,
    };
  }

  const capability = storedCapability(result);
  if (
    capability === null ||
    nextState.shownIds.includes(capability.id) ||
    nextState.usedIds.includes(capability.id)
  ) {
    return { ...emptyOutcome(startedAt, now, "adaptive duplicate suppressed", false), result };
  }

  const heading = observation.recovery ? "Recovery suggestion" : "Recommended now";
  const text = renderInjection(result, {
    heading,
    maxChars: ADAPTIVE_MAX_CHARS,
    maxRunnersUp: 0,
  });
  if (text === null)
    return { ...emptyOutcome(startedAt, now, "adaptive render empty", false), result };
  return {
    payload: injectionPayload("PostToolBatch", text),
    result,
    cacheHit: false,
    degraded: false,
    elapsedMs: now() - startedAt,
    acknowledge: acknowledgeAdaptiveInjection(
      filePath,
      nextState.promptId,
      capability,
      observation.recovery,
      now,
    ),
  };
}

function runSubagentStart(
  input: HookInput,
  deps: HookDeps,
  startedAt: number,
  now: () => number,
): HookOutcome {
  if (isAdaptiveDisabled(deps.env)) {
    return emptyOutcome(startedAt, now, "adaptive routing disabled", false);
  }
  if ((input.agent_id?.trim() ?? "") === "") {
    return emptyOutcome(startedAt, now, "missing subagent id", false);
  }
  const parentFile = adaptiveFile(input, deps, null);
  const childFile = adaptiveFile(input, deps, input.agent_id);
  if (parentFile === null || childFile === null) {
    return emptyOutcome(startedAt, now, "missing subagent session", false);
  }
  const parent = readAdaptiveState(parentFile);
  if (parent === null) return emptyOutcome(startedAt, now, "parent adaptive state missing", false);
  const childPromptId = input.prompt_id?.trim() || parent.promptId;
  const existing = readAdaptiveState(childFile);
  let child: AdaptiveSessionState;
  if (existing !== null && existing.promptId === childPromptId) {
    child = existing;
  } else {
    child = {
      ...parent,
      promptId: childPromptId,
      updatedAt: now(),
      batchCount: 0,
      phase: "intent",
      normalInterventions: 0,
      recoveryInterventions: 0,
      shownIds: [],
      usedIds: [],
      lastEvidenceHash: undefined,
    };
    try {
      writeAdaptiveState(childFile, child);
    } catch {
      return emptyOutcome(startedAt, now, "subagent state write failed", true);
    }
  }

  const capability = parent.primary;
  if (
    capability === undefined ||
    capability.kind === "agent" ||
    parent.usedIds.includes(capability.id) ||
    capability.noneP > 0.2 ||
    capability.confidence < 0.6
  ) {
    return emptyOutcome(startedAt, now, "no strong parent recommendation", false);
  }
  if (child.shownIds.includes(capability.id)) {
    return emptyOutcome(startedAt, now, "subagent recommendation already shown", false);
  }
  const result: RouteResult = {
    decision: {
      kind: "injected",
      primary: {
        id: capability.id,
        kind: capability.kind,
        name: capability.name,
        description: capability.description,
        sourcePath: capability.sourcePath,
        ...(capability.invocationHint === undefined
          ? {}
          : { invocationHint: capability.invocationHint }),
        alternates: [],
      },
      runnersUp: [],
      confidence: capability.confidence,
      noneP: capability.noneP,
    },
    shortlist: [capability.id],
    shortlistDetail: [],
    primary: {
      id: capability.id,
      confidence: capability.confidence,
      noneP: capability.noneP,
      probability: capability.probability,
    },
    ranking: [],
    latencyMs: now() - startedAt,
    cacheHit: true,
    promptChars: parent.goal.length,
    provider: "session-state",
    model: "session-state",
  };
  const text = renderInjection(result, {
    heading: "Useful for this subagent",
    maxChars: ADAPTIVE_MAX_CHARS,
    maxRunnersUp: 0,
  });
  if (text === null) return emptyOutcome(startedAt, now, "subagent render empty", false);
  return {
    payload: injectionPayload("SubagentStart", text),
    result,
    cacheHit: true,
    degraded: false,
    elapsedMs: now() - startedAt,
    acknowledge: acknowledgeAdaptiveInjection(childFile, child.promptId, capability, false, now),
  };
}

/**
 * Decide what a hook should inject for one prompt.
 *
 * Returns a value in every case. The only way this function does not return normally is if the
 * process is killed.
 */
export async function runHook(input: HookInput, deps: HookDeps): Promise<HookOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const event = input.hook_event_name ?? "UserPromptSubmit";

  const empty = (reason: string, degraded: boolean): HookOutcome => ({
    payload: {},
    cacheHit: false,
    degraded,
    reason,
    elapsedMs: now() - startedAt,
  });

  try {
    if (isDisabled(deps.env)) return empty("disabled via SKILLFUL_DISABLE", false);

    if (event === "SessionEnd") {
      if (input.runtime === "claude-code" && (input.session_id?.trim() ?? "") !== "") {
        try {
          removeAdaptiveSession(
            adaptiveStateRoot(deps.homeDir, deps.env),
            input.session_id as string,
          );
        } catch {
          return empty("adaptive session cleanup failed", true);
        }
      }
      return empty("adaptive session cleaned", false);
    }
    if (event === "PostToolBatch") return await runAdaptiveBatch(input, deps, startedAt, now);
    if (event === "SubagentStart") return runSubagentStart(input, deps, startedAt, now);
    if (event !== "UserPromptSubmit") return empty(`unsupported hook event ${event}`, false);

    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim().length === 0) return empty("empty prompt", false);
    const promptStateFile = beginPromptState(input, deps, prompt, now());

    const resolved = resolveConfig({ env: deps.env, homeDir: deps.homeDir });
    const { config } = resolved;

    // Provider selection and credential lookup happen before the relatively expensive scan.
    // Explicit provider mistakes fail closed rather than silently charging another provider.
    try {
      resolveJevTarget({
        provider: config.provider,
        env: deps.env,
        baseUrl: config.baseUrl,
        model: config.model,
      });
    } catch (error) {
      return {
        payload: injectionPayload(event, DEGRADED_REMINDER),
        cacheHit: false,
        degraded: true,
        reason: (error as Error).message,
        elapsedMs: now() - startedAt,
      };
    }

    let catalog: Catalog;
    try {
      catalog = await deps.scan({
        homeDir: deps.homeDir,
        cwd: deps.cwd,
        env: deps.env,
        ...(input.runtime === undefined ? {} : { runtimes: [input.runtime] }),
        includeCachedCapabilities: input.runtime !== undefined,
      });
    } catch (error) {
      return empty(`catalog scan failed: ${(error as Error).message}`, true);
    }

    const cachePath = deps.cachePath ?? defaultCachePath(deps.homeDir);
    const routeContext = JSON.stringify({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      uploadPrompt: config.uploadPrompt,
      thresholds: config.thresholds,
      quotaGroups: config.quotaGroups,
    });
    const key = routeCacheKey(prompt, catalog.fingerprint, routeContext);
    const promptHash = key.slice(0, 32);

    // Cache first: a hit costs a file read instead of a round trip, which is the difference
    // between a 5ms hook and a 700ms one.
    const store = loadCache(cachePath);
    const cached = cacheGet(store, key, { ttlMs: DEFAULT_TTL_MS, now: now() });
    if (cached !== undefined) {
      const text = renderInjection(cached);
      const outcome: HookOutcome = {
        payload: text === null ? {} : injectionPayload(event, text),
        result: cached,
        cacheHit: true,
        degraded: false,
        elapsedMs: now() - startedAt,
      };
      recordRoute(cached, deps, input, promptHash, catalog.fingerprint);
      return stagePromptRecommendation(outcome, cached, promptStateFile, now());
    }

    const result = await (deps.routeFn ?? route)(prompt, {
      entries: catalog.entries,
      thresholds: config.thresholds,
      quotaGroups: config.quotaGroups,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      uploadPrompt: config.uploadPrompt,
      jev: { env: deps.env },
    });

    // Only resolved decisions are cached. Caching a degraded result would turn a momentary
    // outage into a fifteen-minute one.
    if (cacheSet(store, key, result, { now: now() })) {
      saveCache(
        cachePath,
        pruneCache(store, { ttlMs: DEFAULT_TTL_MS, maxEntries: DEFAULT_MAX_ENTRIES, now: now() }),
      );
    }

    if (result.decision.kind === "degraded") {
      const outcome: HookOutcome = {
        payload: injectionPayload(event, degradedReminder()),
        result,
        cacheHit: false,
        degraded: true,
        reason: result.decision.reason,
        elapsedMs: now() - startedAt,
      };
      recordRoute(result, deps, input, promptHash, catalog.fingerprint);
      return outcome;
    }

    const text = renderInjection(result);
    const outcome: HookOutcome = {
      payload: text === null ? {} : injectionPayload(event, text),
      result,
      cacheHit: false,
      degraded: false,
      elapsedMs: now() - startedAt,
    };
    recordRoute(result, deps, input, promptHash, catalog.fingerprint);
    return stagePromptRecommendation(outcome, result, promptStateFile, now());
  } catch (error) {
    // The last line of defence. Reaching here means a bug, and the user still gets a working
    // agent: no output, exit 0, nothing on stderr.
    return {
      payload: {},
      cacheHit: false,
      degraded: true,
      reason: `unexpected hook failure: ${(error as Error).message}`,
      elapsedMs: now() - startedAt,
    };
  }
}

/** True when the user has switched the hook off. */
export function isDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[DISABLE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Build the stdout payload, or `{}` when there is nothing worth saying. */
export function injectionPayload(event: string, text: string): HookPayload {
  if (text.length === 0) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** `~/.cache/skillful/routes.json`, honouring `XDG_CACHE_HOME`. */
export function defaultCachePath(homeDir: string): string {
  return `${homeDir}/.cache/skillful/routes.json`;
}

/** Extracted so `doctor` can report which config was used without re-resolving it. */
export function resolveForReport(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): ResolvedConfig {
  return resolveConfig({ env, homeDir });
}

/** Re-exported so callers can count entries without reaching into the catalog module. */
export type { CatalogEntry };
