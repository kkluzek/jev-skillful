import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "../config/resolve.js";
import { isDisabled } from "../hooks/runner.js";
import { callSystemOne } from "../jev/client.js";
import { isNoulAnswer, type SystemOneResponse } from "../jev/types.js";
import { buildReminderCorpus } from "./corpus.js";
import { rankReminderDocuments } from "./rank.js";
import {
  appendReminderDecision,
  clearReminderFailure,
  loadCachedReminderCorpus,
  readReminderFailure,
  readReminderSession,
  reminderCacheRoot,
  reminderFailurePath,
  reminderIndexCachePath,
  reminderSessionPath,
  reminderStateRoot,
  writeReminderFailure,
  writeReminderSession,
} from "./storage.js";
import type { ReminderHookInput, ReminderSelection } from "./types.js";

export interface ReminderOptions {
  homeDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  call?: typeof callSystemOne;
  buildCorpus?: typeof buildReminderCorpus;
  writeSession?: typeof writeReminderSession;
}

export interface ReminderHookResult {
  payload: Record<string, unknown>;
  selection?: ReminderSelection;
  /** Commit deduplication only after the command has flushed payload JSON to the host. */
  acknowledge?: () => void;
}

function numberSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

interface RecentPrompts {
  prompts: string[];
  error?: string;
}

function readRecentPrompts(transcriptPath: string | undefined): RecentPrompts {
  if (transcriptPath === undefined) return { prompts: [] };
  let descriptor: number | undefined;
  let raw = "";
  try {
    descriptor = openSync(transcriptPath, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(128_000, size);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(descriptor, buffer, read, length - read, size - length + read);
      if (count === 0) break;
      read += count;
    }
    raw = buffer.subarray(0, read).toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return { prompts: [], error: `transcript tail is unavailable (${code})` };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The read result already determines whether this hook can proceed.
      }
    }
  }
  const prompts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const message = record["message"] as Record<string, unknown> | undefined;
      const role = message?.["role"] ?? record["role"] ?? record["type"];
      if (role !== "user" && role !== "human") continue;
      const content = message?.["content"] ?? record["content"];
      if (typeof content === "string") prompts.push(content);
      else if (Array.isArray(content)) {
        const text = content
          .flatMap((item) =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>)["text"] === "string"
              ? [(item as Record<string, unknown>)["text"] as string]
              : [],
          )
          .join(" ");
        if (text.length > 0) prompts.push(text);
      }
    } catch {
      // Transcript lines outside the JSONL envelope are ignored.
    }
  }
  return { prompts: prompts.slice(-3) };
}

export function reminderQuery(input: ReminderHookInput): string {
  return buildReminderQuery(input).query;
}

function buildReminderQuery(input: ReminderHookInput): { query: string; error?: string } {
  const recent = readRecentPrompts(input.transcript_path);
  const query = [input.compact_summary ?? "", ...recent.prompts]
    .filter((value) => value.trim().length > 0)
    .join("\n\n")
    .slice(-8_000);
  return { query, ...(recent.error === undefined ? {} : { error: recent.error }) };
}

function failureMessage(reason: string): string {
  return `Skillful reminder layer did not run: ${reason}. Continue without reminder retrieval.`;
}

function renderSelection(
  selected: Array<{ kind: string; title: string; path: string; hook: string }>,
): string {
  const lines = ["Potentially relevant reminders (verify before applying):"];
  for (const item of selected.slice(0, 3)) {
    const lead = item.hook.replace(/\s+/g, " ").trim().slice(0, 240);
    lines.push(
      item.kind === "memory"
        ? `- ${item.title} — ${item.path} — ${lead}`
        : `- [${item.title}] — ${lead}`,
    );
  }
  return lines.slice(0, 39).join("\n");
}

export async function selectReminders(
  query: string,
  options: ReminderOptions,
  shownIds: readonly string[] = [],
): Promise<ReminderSelection> {
  const now = options.now ?? Date.now;
  const topK = Math.min(
    24,
    Math.max(1, Math.floor(numberSetting(options.env, "SKILLFUL_REMINDER_TOP_K", 12))),
  );
  const maxItems = Math.min(
    3,
    Math.max(1, Math.floor(numberSetting(options.env, "SKILLFUL_REMINDER_MAX_ITEMS", 3))),
  );
  const budgetMs = Math.min(
    2_500,
    Math.max(100, numberSetting(options.env, "SKILLFUL_REMINDER_BUDGET_MS", 1_800)),
  );
  const stateRoot = reminderStateRoot(options.homeDir, options.env);
  const decisionPath = path.join(stateRoot, "reminder-decisions.jsonl");
  const startedAt = now();
  const thresholdRaw = options.env["SKILLFUL_REMINDER_THRESHOLD"];
  const threshold = thresholdRaw === undefined ? 0.72 : Number(thresholdRaw);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    const reason = "SKILLFUL_REMINDER_THRESHOLD must be a number between 0 and 1";
    appendReminderDecision(decisionPath, {
      at: new Date().toISOString(),
      query,
      candidates: [],
      shown: [],
      degraded: "invalid-threshold",
    });
    return { text: failureMessage(reason), ids: [], degraded: true, reason };
  }
  const resolved = resolveConfig({ homeDir: options.homeDir, env: options.env });
  if (!resolved.config.uploadPrompt) {
    const text = failureMessage("prompt upload is disabled");
    appendReminderDecision(decisionPath, {
      at: new Date().toISOString(),
      query,
      candidates: [],
      shown: [],
      degraded: "prompt-upload-disabled",
    });
    return { text, ids: [], degraded: true, reason: "prompt upload disabled" };
  }
  if ((options.env["TYPESAFE_API_KEY"] ?? "").trim().length === 0) {
    const text = failureMessage("TYPESAFE_API_KEY is unavailable");
    appendReminderDecision(decisionPath, {
      at: new Date().toISOString(),
      query,
      candidates: [],
      shown: [],
      degraded: "no-api-key",
    });
    return { text, ids: [], degraded: true, reason: "no API key" };
  }

  try {
    const fresh = await (options.buildCorpus ?? buildReminderCorpus)({
      homeDir: options.homeDir,
      cwd: options.cwd,
      env: options.env,
    });
    const incomplete = fresh.warnings.find((warning) =>
      warning.startsWith("Reminder corpus incomplete:"),
    );
    if (incomplete !== undefined) {
      const text = failureMessage(incomplete);
      appendReminderDecision(decisionPath, {
        at: new Date().toISOString(),
        query,
        candidates: [],
        shown: [],
        degraded: "incomplete-corpus",
      });
      return { text, ids: [], degraded: true, reason: incomplete };
    }
    if (fresh.warnings.some((warning) => warning.includes("index is empty"))) {
      const text = failureMessage(
        fresh.warnings.find((warning) => warning.includes("index is empty")) ??
          "memory index is empty",
      );
      appendReminderDecision(decisionPath, {
        at: new Date().toISOString(),
        query,
        candidates: [],
        shown: [],
        degraded: "empty-index",
      });
      return { text, ids: [], degraded: true, reason: "empty memory index" };
    }
    const corpus = loadCachedReminderCorpus(
      reminderIndexCachePath(reminderCacheRoot(options.homeDir, options.env), options.cwd),
      fresh,
    );
    const ranked = rankReminderDocuments(corpus.documents, query)
      .filter((candidate) => !shownIds.includes(candidate.document.canonicalKey))
      .slice(0, topK);
    if (ranked.length === 0) {
      appendReminderDecision(decisionPath, {
        at: new Date().toISOString(),
        query,
        candidates: [],
        shown: [],
        degraded: false,
      });
      return { text: null, ids: [], degraded: false };
    }
    if (now() - startedAt >= budgetMs)
      throw new Error("the 1800ms reminder budget expired before Jev ranking");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, budgetMs - (now() - startedAt)));
    let response: SystemOneResponse;
    try {
      response = await (options.call ?? callSystemOne)(
        {
          model: resolved.config.model,
          state: {
            task: query,
            candidates: ranked.map((candidate, index) => ({
              index,
              kind: candidate.document.kind,
              title: candidate.document.title,
              text: `${candidate.document.hook}\n${candidate.document.description}\n${candidate.document.body}`.slice(
                0,
                1_200,
              ),
            })),
          },
          questions: Object.fromEntries(
            ranked.map((_, index) => [
              `candidate_${index}`,
              {
                type: "noul" as const,
                instructions: `Decide whether candidate ${index} contains a concrete reminder that is directly useful for the observed task. Prefer precision. Do not infer facts absent from the state.`,
                criteria: {
                  true: "Directly useful now",
                  false: "Unrelated, generic, or merely adjacent",
                },
              },
            ]),
          ),
        },
        {
          env: options.env,
          baseUrl: resolved.config.baseUrl,
          requestTimeoutMs: Math.max(100, budgetMs - (now() - startedAt)),
          maxRetries: 0,
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
    for (let index = 0; index < ranked.length; index += 1) {
      const answer = response.answers[`candidate_${index}`];
      if (
        !isNoulAnswer(answer) ||
        !Number.isFinite(answer.noul) ||
        answer.noul < 0 ||
        answer.noul > 1
      ) {
        throw new Error(`TypeSafe response is missing a valid candidate_${index} noul answer`);
      }
    }
    const accepted = ranked
      .flatMap((candidate, index) => {
        const answer = response.answers[`candidate_${index}`];
        return isNoulAnswer(answer) && answer.noul >= threshold
          ? [{ ...candidate, probability: answer.noul }]
          : [];
      })
      .sort((left, right) => right.probability - left.probability || right.score - left.score)
      .slice(0, maxItems);
    const ids = accepted.map((candidate) => candidate.document.canonicalKey);
    const text =
      accepted.length === 0
        ? null
        : renderSelection(accepted.map((candidate) => candidate.document));
    appendReminderDecision(decisionPath, {
      at: new Date().toISOString(),
      query,
      candidates: ranked.map((candidate, index) => {
        const answer = response.answers[`candidate_${index}`];
        return {
          id: candidate.document.canonicalKey,
          bm25: candidate.score,
          noul: isNoulAnswer(answer) ? answer.noul : null,
        };
      }),
      selected: ids,
      shown: [],
      degraded: false,
    });
    return { text, ids, degraded: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown failure";
    const text = failureMessage(reason.slice(0, 180));
    appendReminderDecision(decisionPath, {
      at: new Date().toISOString(),
      query,
      candidates: [],
      shown: [],
      degraded: reason,
    });
    return { text, ids: [], degraded: true, reason };
  }
}

export async function runReminderHook(
  input: ReminderHookInput,
  options: ReminderOptions,
): Promise<ReminderHookResult> {
  if (isDisabled(options.env)) return { payload: {} };
  const event = input.hook_event_name ?? "";
  const sessionId = input.session_id?.trim() || input.transcript_path?.trim() || "";
  if (sessionId.length === 0) return { payload: {} };
  const statePath = reminderSessionPath(reminderStateRoot(options.homeDir, options.env), sessionId);
  const stateRead = readReminderSession(statePath);
  const failurePath = reminderFailurePath(
    reminderCacheRoot(options.homeDir, options.env),
    sessionId,
  );
  const deferredFailure = readReminderFailure(failurePath);
  if (event === "SessionStart" && deferredFailure !== null) {
    const pending = stateRead.error === undefined ? stateRead.state.pending : undefined;
    const text = [pending?.text, failureMessage(deferredFailure)].filter(Boolean).join("\n\n");
    const ids = pending?.ids ?? [];
    return {
      payload: reminderPayload(event, text),
      selection: { text, ids, degraded: true, reason: deferredFailure },
      acknowledge: () => {
        try {
          if (pending !== undefined) {
            (options.writeSession ?? writeReminderSession)(statePath, {
              ...stateRead.state,
              shownIds: [...new Set([...stateRead.state.shownIds, ...pending.ids])],
              pending: undefined,
            });
          }
          clearReminderFailure(failurePath);
          recordReminderDelivery(options, ids, deferredFailure);
        } catch (error) {
          recordReminderDelivery(options, ids, persistenceFailureReason(error));
        }
      },
    };
  }
  if (stateRead.error !== undefined) {
    const selection = stateFailureSelection(input, options, stateRead.error);
    if (event === "PostCompact") {
      persistDeferredFailure(failurePath, stateRead.error, options);
      return { payload: {}, selection };
    }
    return {
      payload:
        event === "SessionStart"
          ? reminderPayload(event, selection.text ?? "")
          : { systemMessage: selection.text },
      selection,
    };
  }
  const state = stateRead.state;

  if (event === "SessionStart" && input.source === "compact" && state.pending !== undefined) {
    const pending = state.pending;
    return {
      payload: reminderPayload(event, pending.text),
      acknowledge: () => {
        try {
          (options.writeSession ?? writeReminderSession)(statePath, {
            ...state,
            shownIds: [...new Set([...state.shownIds, ...pending.ids])],
            pending: undefined,
          });
          recordReminderDelivery(options, pending.ids, false);
        } catch (error) {
          recordReminderDelivery(options, pending.ids, persistenceFailureReason(error));
        }
      },
    };
  }

  const isPostCompact = event === "PostCompact";
  const isResume = event === "SessionStart" && input.source === "resume";
  if (!isPostCompact && !isResume) return { payload: {} };
  const now = options.now ?? Date.now;
  const cooldownMs = numberSetting(options.env, "SKILLFUL_REMINDER_COOLDOWN_MS", 300_000);
  if (state.lastRunAt !== undefined && now() - state.lastRunAt < cooldownMs) return { payload: {} };
  const queryResult = buildReminderQuery(input);
  const query = queryResult.query;
  if (query.trim().length === 0 && queryResult.error === undefined) return { payload: {} };
  const selection =
    queryResult.error === undefined
      ? await selectReminders(query, options, state.shownIds)
      : {
          text: failureMessage(queryResult.error),
          ids: [],
          degraded: true,
          reason: queryResult.error,
        };
  if (queryResult.error !== undefined) {
    appendReminderDecision(
      path.join(reminderStateRoot(options.homeDir, options.env), "reminder-decisions.jsonl"),
      {
        at: new Date().toISOString(),
        query,
        candidates: [],
        shown: [],
        degraded: queryResult.error,
      },
    );
  }
  if (isPostCompact) {
    try {
      (options.writeSession ?? writeReminderSession)(statePath, {
        ...state,
        lastRunAt: now(),
        pending: selection.text === null ? undefined : { text: selection.text, ids: selection.ids },
      });
      recordReminderPending(options, selection.ids);
      return { payload: {}, selection };
    } catch (error) {
      const reason = persistenceFailureReason(error);
      recordReminderDelivery(options, [], reason);
      persistDeferredFailure(failurePath, reason, options);
      return {
        payload: {},
        selection: { ...selection, degraded: true, reason },
      };
    }
  }
  return {
    payload: selection.text === null ? {} : reminderPayload(event, selection.text),
    selection,
    acknowledge: () => {
      try {
        (options.writeSession ?? writeReminderSession)(statePath, {
          ...state,
          lastRunAt: now(),
          shownIds: [...new Set([...state.shownIds, ...selection.ids])],
        });
        recordReminderDelivery(options, selection.ids, false);
      } catch (error) {
        recordReminderDelivery(options, selection.ids, persistenceFailureReason(error));
      }
    },
  };
}

function reminderPayload(event: string, text: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

export function preparePendingReminder(
  input: ReminderHookInput,
  options: Pick<ReminderOptions, "homeDir" | "env">,
): { text: string; acknowledge: () => void } | null {
  if (isDisabled(options.env)) return null;
  const sessionId = input.session_id?.trim() || input.transcript_path?.trim();
  if (sessionId === undefined || sessionId.length === 0) return null;
  const filePath = reminderSessionPath(reminderStateRoot(options.homeDir, options.env), sessionId);
  const stateRead = readReminderSession(filePath);
  if (stateRead.error !== undefined) {
    const message = failureMessage(stateRead.error);
    appendReminderDecision(
      path.join(reminderStateRoot(options.homeDir, options.env), "reminder-decisions.jsonl"),
      {
        at: new Date().toISOString(),
        query: "",
        candidates: [],
        shown: [],
        degraded: stateRead.error,
      },
    );
    return { text: message, acknowledge: () => undefined };
  }
  const state = stateRead.state;
  if (state.pending === undefined) return null;
  const pending = state.pending;
  return {
    text: pending.text,
    acknowledge: () => {
      try {
        writeReminderSession(filePath, {
          ...state,
          shownIds: [...new Set([...state.shownIds, ...pending.ids])],
          pending: undefined,
        });
        recordReminderDelivery(options, pending.ids, false);
      } catch (error) {
        recordReminderDelivery(options, pending.ids, persistenceFailureReason(error));
      }
    },
  };
}

export function unexpectedReminderResult(
  input: ReminderHookInput,
  options: ReminderOptions,
  error: unknown,
): ReminderHookResult {
  const detail = error instanceof Error ? error.message : "unknown failure";
  const reason = `unexpected reminder failure: ${detail.slice(0, 160)}`;
  const selection = stateFailureSelection(input, options, reason);
  const event = input.hook_event_name ?? "";
  if (event === "PostCompact") {
    const sessionId = input.session_id?.trim() || input.transcript_path?.trim();
    if (sessionId !== undefined && sessionId.length > 0) {
      persistDeferredFailure(
        reminderFailurePath(reminderCacheRoot(options.homeDir, options.env), sessionId),
        reason,
        options,
      );
    }
    return { payload: {}, selection };
  }
  if (event !== "SessionStart") return { payload: {}, selection };
  return {
    payload:
      event === "SessionStart"
        ? reminderPayload(event, selection.text ?? "")
        : { systemMessage: selection.text },
    selection,
  };
}

function persistDeferredFailure(
  filePath: string,
  reason: string,
  options: Pick<ReminderOptions, "homeDir" | "env">,
): void {
  try {
    writeReminderFailure(filePath, reason);
  } catch (error) {
    recordReminderDelivery(
      options,
      [],
      `${reason}; could not persist deferred failure (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
    );
  }
}

function persistenceFailureReason(error: unknown): string {
  return `could not update reminder session state (${(error as NodeJS.ErrnoException).code ?? "unknown"})`;
}

function recordReminderDelivery(
  options: Pick<ReminderOptions, "homeDir" | "env">,
  ids: readonly string[],
  degraded: false | string,
): void {
  appendReminderDecision(
    path.join(reminderStateRoot(options.homeDir, options.env), "reminder-decisions.jsonl"),
    {
      at: new Date().toISOString(),
      query: "",
      candidates: [],
      shown: ids,
      degraded,
      event: "delivery",
    },
  );
}

function recordReminderPending(
  options: Pick<ReminderOptions, "homeDir" | "env">,
  ids: readonly string[],
): void {
  appendReminderDecision(
    path.join(reminderStateRoot(options.homeDir, options.env), "reminder-decisions.jsonl"),
    {
      at: new Date().toISOString(),
      query: "",
      candidates: [],
      selected: ids,
      shown: [],
      degraded: false,
      event: "pending",
    },
  );
}

function stateFailureSelection(
  input: ReminderHookInput,
  options: ReminderOptions,
  reason: string,
): ReminderSelection {
  appendReminderDecision(
    path.join(reminderStateRoot(options.homeDir, options.env), "reminder-decisions.jsonl"),
    {
      at: new Date().toISOString(),
      query: input.compact_summary ?? "",
      candidates: [],
      shown: [],
      degraded: reason,
    },
  );
  return { text: failureMessage(reason), ids: [], degraded: true, reason };
}
