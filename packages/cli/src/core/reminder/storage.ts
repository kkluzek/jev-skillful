import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ReminderCorpus } from "./corpus.js";

export interface ReminderSessionState {
  lastRunAt?: number;
  shownIds: string[];
  pending?: { text: string; ids: string[] };
}

export interface ReminderSessionRead {
  state: ReminderSessionState;
  error?: string;
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Best effort on non-POSIX filesystems. */
  }
}

export function reminderStateRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env["XDG_STATE_HOME"]?.trim() || path.join(homeDir, ".local", "state", "skillful");
}

export function reminderCacheRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env["XDG_CACHE_HOME"]?.trim() || path.join(homeDir, ".cache", "skillful");
}

export function reminderSessionPath(root: string, sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex");
  return path.join(root, "reminders", "sessions", `${hash}.json`);
}

export function reminderFailurePath(cacheRoot: string, sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex");
  return path.join(cacheRoot, "reminder-failures", `${hash}.json`);
}

export function readReminderFailure(filePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)["reason"] === "string"
    ) {
      return (parsed as Record<string, unknown>)["reason"] as string;
    }
    return "deferred reminder failure record has an invalid schema";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return `deferred reminder failure record is unreadable (${code ?? "invalid JSON"})`;
  }
}

export function writeReminderFailure(filePath: string, reason: string): void {
  privateDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ reason })}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

export function clearReminderFailure(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readReminderSession(filePath: string): ReminderSessionRead {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { state: { shownIds: [] }, error: "reminder session state has an invalid schema" };
    }
    const record = parsed as Record<string, unknown>;
    if (
      !Array.isArray(record["shownIds"]) ||
      !record["shownIds"].every((value) => typeof value === "string") ||
      (record["lastRunAt"] !== undefined &&
        (typeof record["lastRunAt"] !== "number" || !Number.isFinite(record["lastRunAt"])))
    ) {
      return { state: { shownIds: [] }, error: "reminder session state has an invalid schema" };
    }
    const shownIds = record["shownIds"] as string[];
    const pendingValue = record["pending"];
    if (
      pendingValue !== undefined &&
      (typeof pendingValue !== "object" ||
        pendingValue === null ||
        Array.isArray(pendingValue) ||
        typeof (pendingValue as Record<string, unknown>)["text"] !== "string" ||
        !Array.isArray((pendingValue as Record<string, unknown>)["ids"]) ||
        !((pendingValue as Record<string, unknown>)["ids"] as unknown[]).every(
          (value) => typeof value === "string",
        ))
    ) {
      return { state: { shownIds: [] }, error: "reminder session state has an invalid schema" };
    }
    const pending =
      typeof pendingValue === "object" &&
      pendingValue !== null &&
      typeof (pendingValue as Record<string, unknown>)["text"] === "string"
        ? {
            text: (pendingValue as Record<string, unknown>)["text"] as string,
            ids: Array.isArray((pendingValue as Record<string, unknown>)["ids"])
              ? ((pendingValue as Record<string, unknown>)["ids"] as unknown[]).filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
          }
        : undefined;
    return {
      state: {
        shownIds,
        ...(typeof record["lastRunAt"] === "number" ? { lastRunAt: record["lastRunAt"] } : {}),
        ...(pending === undefined ? {} : { pending }),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: { shownIds: [] } };
    return {
      state: { shownIds: [] },
      error: `reminder session state is unreadable (${code ?? "invalid JSON"})`,
    };
  }
}

export function writeReminderSession(filePath: string, state: ReminderSessionState): void {
  privateDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, filePath);
}

export function loadCachedReminderCorpus(cachePath: string, fresh: ReminderCorpus): ReminderCorpus {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ReminderCorpus;
    if (parsed.fingerprint === fresh.fingerprint && Array.isArray(parsed.documents)) return parsed;
  } catch {
    // A missing or invalid cache is rebuilt below.
  }
  privateDir(path.dirname(cachePath));
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(fresh)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, cachePath);
  return fresh;
}

export function reminderIndexCachePath(cacheRoot: string, cwd: string): string {
  return path.join(
    cacheRoot,
    "reminder-index-v1",
    `${createHash("sha256").update(path.resolve(cwd)).digest("hex")}.json`,
  );
}

export function appendReminderDecision(filePath: string, value: unknown): void {
  try {
    privateDir(path.dirname(filePath));
    appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    if (statSync(filePath).mode & 0o077) chmodSync(filePath, 0o600);
  } catch {
    // Decision logging is never allowed to break a host hook.
  }
}
