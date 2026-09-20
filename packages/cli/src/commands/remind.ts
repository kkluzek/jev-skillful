import {
  type ReminderHookResult,
  type ReminderOptions,
  runReminderHook,
  unexpectedReminderResult,
} from "../core/reminder/runner.js";
import type { ReminderHookInput } from "../core/reminder/types.js";
import { writeHookPayload } from "./hook-output.js";

export interface RemindCommandOptions {
  stdin: string;
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  deps?: Partial<ReminderOptions>;
}

export function parseReminderInput(stdin: string): { input: ReminderHookInput; error?: string } {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { input: {}, error: "reminder hook input must be a JSON object" };
    }
    const source = parsed as Record<string, unknown>;
    const output: ReminderHookInput = {};
    const keys = [
      "hook_event_name",
      "source",
      "trigger",
      "compact_summary",
      "transcript_path",
      "session_id",
      "cwd",
    ] as const;
    for (const key of keys) {
      if (typeof source[key] === "string") output[key] = source[key] as never;
    }
    const wrongType = keys.find(
      (key) => source[key] !== undefined && typeof source[key] !== "string",
    );
    if (wrongType !== undefined) {
      return { input: output, error: `reminder hook field ${wrongType} must be a string` };
    }
    if (output.hook_event_name === undefined) {
      return { input: output, error: "reminder hook input is missing hook_event_name" };
    }
    if ((output.session_id?.trim() ?? "") === "" && (output.transcript_path?.trim() ?? "") === "") {
      return {
        input: output,
        error: "reminder hook input is missing session_id and transcript_path",
      };
    }
    return { input: output };
  } catch {
    return { input: {}, error: "reminder hook input is not valid JSON" };
  }
}

export async function remindCommand(options: RemindCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const parsed = parseReminderInput(options.stdin);
  const input = parsed.input;
  const reminderOptions: ReminderOptions = {
    homeDir,
    cwd: options.cwd ?? input.cwd ?? process.cwd(),
    env,
    ...options.deps,
  };
  let result: ReminderHookResult;
  if (parsed.error !== undefined) {
    result = unexpectedReminderResult(input, reminderOptions, new Error(parsed.error));
  } else {
    try {
      result = await runReminderHook(input, reminderOptions);
    } catch (error) {
      result = unexpectedReminderResult(input, reminderOptions, error);
    }
  }
  if (await writeHookPayload(result.payload)) result.acknowledge?.();
  return 0;
}
