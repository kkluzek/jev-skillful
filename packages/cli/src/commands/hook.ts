/**
 * `skillful hook` — the entry point Claude Code and Codex invoke on every prompt.
 *
 * The contract, and the only thing about this command that matters:
 *
 * - Read one JSON object from stdin.
 * - Write one JSON object to stdout.
 * - **Always exit 0.**
 *
 * Nothing is written to stderr, ever. An agent that shows its user a stack trace on every
 * prompt because of a routing failure would be worse than no router at all, so diagnostics go
 * to `skillful doctor` instead of into the user's terminal.
 */

import { scanCatalog } from "../core/catalog/scan.js";
import type { CatalogRuntime } from "../core/catalog/types.js";
import { type HookInput, type HookToolCall, isDisabled, runHook } from "../core/hooks/runner.js";
import { preparePendingReminder } from "../core/reminder/runner.js";
import { writeHookPayload } from "./hook-output.js";

export interface HookCommandOptions {
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Raw stdin text. Empty or malformed input is tolerated and treated as "no prompt". */
  stdin: string;
  runtime?: CatalogRuntime;
}

const MAX_TOOL_CALLS = 32;

function parseToolCalls(value: unknown): HookToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: HookToolCall[] = [];
  for (const item of value.slice(0, MAX_TOOL_CALLS)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["tool_name"] !== "string") continue;
    const toolInput = record["tool_input"];
    calls.push({
      tool_name: record["tool_name"],
      tool_input:
        typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
          ? (toolInput as Record<string, unknown>)
          : {},
      ...(typeof record["tool_use_id"] === "string" ? { tool_use_id: record["tool_use_id"] } : {}),
      ...(record["tool_response"] === undefined ? {} : { tool_response: record["tool_response"] }),
    });
  }
  return calls;
}

/** Parse stdin into a hook input, tolerating anything that is not the expected shape. */
export function parseHookInput(stdin: string): HookInput {
  const trimmed = stdin.trim();
  if (trimmed.length === 0) return { prompt: "" };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Some runtimes have been known to pass the raw prompt rather than a JSON envelope, so
      // a bare string body is treated as the prompt instead of as an error.
      return { prompt: trimmed };
    }
    const record = parsed as Record<string, unknown>;
    const prompt =
      typeof record["prompt"] === "string"
        ? record["prompt"]
        : typeof record["user_prompt"] === "string"
          ? record["user_prompt"]
          : "";
    const toolCalls = parseToolCalls(record["tool_calls"]);
    return {
      prompt,
      ...(typeof record["session_id"] === "string" ? { session_id: record["session_id"] } : {}),
      ...(typeof record["prompt_id"] === "string" ? { prompt_id: record["prompt_id"] } : {}),
      ...(typeof record["agent_id"] === "string" ? { agent_id: record["agent_id"] } : {}),
      ...(typeof record["agent_type"] === "string" ? { agent_type: record["agent_type"] } : {}),
      ...(typeof record["cwd"] === "string" ? { cwd: record["cwd"] } : {}),
      ...(typeof record["hook_event_name"] === "string"
        ? { hook_event_name: record["hook_event_name"] }
        : {}),
      ...(typeof record["transcript_path"] === "string"
        ? { transcript_path: record["transcript_path"] }
        : {}),
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    };
  } catch {
    return { prompt: trimmed };
  }
}

/**
 * Run the hook and print its payload.
 *
 * Returns 0 unconditionally. The exit code is part of the contract: a non-zero exit is how a
 * hook signals failure to the host, and this hook must never signal failure.
 */
export async function hookCommand(options: HookCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const input = parseHookInput(options.stdin);
  if (options.runtime !== undefined) input.runtime = options.runtime;

  const outcome = await runHook(input, {
    homeDir,
    cwd: options.cwd ?? input.cwd ?? process.cwd(),
    env,
    scan: scanCatalog,
  });

  let acknowledgeReminder: (() => void) | undefined;
  if (
    !isDisabled(env) &&
    options.runtime === "claude-code" &&
    (input.hook_event_name ?? "UserPromptSubmit") === "UserPromptSubmit"
  ) {
    const pending = preparePendingReminder(input, { homeDir, env });
    if (pending !== null) {
      const existing = outcome.payload.hookSpecificOutput?.additionalContext;
      outcome.payload = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            existing === undefined ? pending.text : `${existing}\n\n${pending.text}`,
        },
      };
      acknowledgeReminder = pending.acknowledge;
    }
  }

  if (await writeHookPayload(outcome.payload)) {
    outcome.acknowledge?.();
    acknowledgeReminder?.();
  }
  return 0;
}
