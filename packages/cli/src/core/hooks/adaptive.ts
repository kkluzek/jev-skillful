import { createHash } from "node:crypto";
import type { AdaptivePhase, AdaptiveSessionState, StoredCapability } from "./adaptive-state.js";
import type { HookToolCall } from "./runner.js";

export const ADAPTIVE_DISABLE_ENV = "SKILLFUL_ADAPTIVE";
export const ADAPTIVE_MAX_CHARS = 240;
export const ADAPTIVE_MIN_BATCH = 2;
export const ADAPTIVE_MAX_NORMAL_PER_PROMPT = 1;
export const ADAPTIVE_MAX_RECOVERY_PER_PROMPT = 1;

export interface BatchObservation {
  phase: AdaptivePhase;
  failureClass?: string;
  recovery: boolean;
  evidenceHash: string;
  toolNames: string[];
}

export interface CapabilityUsageIdentity {
  kind: StoredCapability["kind"];
  name: string;
  invocationHint?: string;
}

export function isAdaptiveDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[ADAPTIVE_DISABLE_ENV]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

function serialise(value: unknown, limit = 1_000): string {
  const parts: string[] = [];
  let remaining = limit;
  const seen = new WeakSet<object>();
  const append = (text: string): void => {
    if (remaining <= 0) return;
    const bounded = text.slice(0, remaining);
    parts.push(bounded);
    remaining -= bounded.length;
  };
  const visit = (item: unknown, depth: number): void => {
    if (remaining <= 0 || depth > 3) return;
    if (typeof item === "string") {
      append(item);
      return;
    }
    if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
      append(String(item));
      return;
    }
    if (item === null || item === undefined || typeof item !== "object") return;
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 12)) visit(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(item).slice(0, 16)) {
      append(`${key} `);
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return parts.join(" ").slice(0, limit);
}

function failureClass(call: HookToolCall): string | undefined {
  const response = call.tool_response;
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    if (record["is_error"] === true || record["success"] === false) return "tool-failure";
    if (typeof record["exit_code"] === "number" && record["exit_code"] !== 0) {
      return "command-failure";
    }
    if (typeof record["status"] === "string" && /^(failed|error)$/i.test(record["status"])) {
      return "tool-failure";
    }
  }

  const text = serialise(response).toLowerCase();
  if (/command not found|enoent|executable not found/.test(text)) return "command-not-found";
  if (/permission denied|not permitted|access denied/.test(text)) return "permission-denied";
  if (/unauthori[sz]ed|authentication failed|\b401\b|\b403\b/.test(text)) return "auth";
  if (/timed out|timeout|connection refused|network unreachable|connection closed/.test(text)) {
    return "network";
  }
  if (/\b404\b|not found/.test(text)) return "not-found";
  if (/exit code [1-9]|\bfailed\b|\berror:/.test(text)) return "tool-failure";
  return undefined;
}

function inputText(calls: readonly HookToolCall[]): string {
  return calls
    .map((call) => serialise(call.tool_input, 500))
    .join(" ")
    .toLowerCase();
}

export function observeBatch(calls: readonly HookToolCall[]): BatchObservation {
  const toolNames = [...new Set(calls.map((call) => call.tool_name))].sort();
  const names = toolNames.join(" ").toLowerCase();
  const inputs = inputText(calls);
  const failure = calls.map(failureClass).find((value) => value !== undefined);

  let phase: AdaptivePhase = "other";
  if (/\b(test|vitest|jest|pytest|typecheck|lint|build)\b/.test(`${names} ${inputs}`)) {
    phase = "verification";
  } else if (/browser|playwright|puppeteer/.test(names)) {
    phase = "browser";
  } else if (/\.(pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|gif|svg|mp4|mov)\b/.test(inputs)) {
    phase = "artifact";
  } else if (/^mcp__|\bmcp__|webfetch|websearch/.test(names)) {
    phase = "external";
  } else if (/\b(edit|write|notebookedit)\b/.test(names)) {
    phase = "implementation";
  } else if (/\b(read|glob|grep)\b/.test(names)) {
    phase = "discovery";
  }

  const recovery = failure !== undefined;
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({ phase, failure, toolNames }))
    .digest("hex");
  return {
    phase,
    ...(failure === undefined ? {} : { failureClass: failure }),
    recovery,
    evidenceHash,
    toolNames,
  };
}

export function capabilityWasUsed(
  capability: CapabilityUsageIdentity | undefined,
  calls: readonly HookToolCall[],
): boolean {
  if (capability === undefined) return false;
  const wanted = capability.name.toLowerCase();
  for (const call of calls) {
    const tool = call.tool_name.toLowerCase();
    if (capability.kind === "mcp-tool" && tool === wanted) return true;
    if (capability.kind === "agent" && /^(agent|task)$/.test(tool)) {
      const type = call.tool_input["subagent_type"] ?? call.tool_input["agent_type"];
      if (typeof type === "string" && type.toLowerCase() === wanted) return true;
    }
    if (capability.kind === "cli-command" && tool === "bash") {
      const command = call.tool_input["command"];
      if (typeof command === "string") {
        const lower = command.toLowerCase();
        const hint = capability.invocationHint?.toLowerCase();
        if ((hint !== undefined && lower.includes(hint)) || lower.includes(wanted)) return true;
      }
    }
    if ((capability.kind === "skill" || capability.kind === "command") && tool.includes(wanted)) {
      return true;
    }
  }
  return false;
}

export function shouldRouteBatch(
  state: AdaptiveSessionState,
  observation: BatchObservation,
): boolean {
  if (observation.evidenceHash === state.lastEvidenceHash) return false;
  if (observation.recovery) {
    return state.recoveryInterventions < ADAPTIVE_MAX_RECOVERY_PER_PROMPT;
  }
  if (state.batchCount + 1 < ADAPTIVE_MIN_BATCH) return false;
  if (state.normalInterventions >= ADAPTIVE_MAX_NORMAL_PER_PROMPT) return false;
  if (observation.phase === "discovery" || observation.phase === "other") return false;
  return observation.phase !== state.phase;
}

export function buildAdaptivePrompt(
  state: AdaptiveSessionState,
  observation: BatchObservation,
): string {
  const goal = state.goal.length <= 700 ? state.goal : `${state.goal.slice(0, 699).trimEnd()}…`;
  const signal = observation.recovery
    ? `recovery needed after ${observation.failureClass ?? "a tool failure"}`
    : `the task moved into the ${observation.phase} phase`;
  return [
    `Original user goal: ${goal}`,
    `Current execution state: ${signal}.`,
    `Recent tools: ${observation.toolNames.join(", ") || "none"}.`,
    "Choose none unless one available capability would materially improve the agent's next immediate step. Do not select a capability merely because it is generally related.",
  ].join("\n");
}
