import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReminderDocument } from "../core/reminder/types.js";
import { hookCommand } from "./hook.js";
import { remindCommand } from "./remind.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function reminderDeps() {
  const reminder: ReminderDocument = {
    id: "rule:verify-release-assets",
    canonicalKey: "rule:verify-release-assets",
    kind: "rule",
    title: "verify-release-assets",
    hook: "Verify the release assets.",
    path: "/rules/release.md",
    description: "Release check",
    body: "Check every asset.",
    identifiers: ["verify-release-assets"],
    citations: [],
  };
  return {
    buildCorpus: async () => ({
      documents: [reminder],
      warnings: [],
      fingerprint: "command-test",
      sources: [],
    }),
    call: async () => ({
      model: "jev-latest",
      answers: { candidate_0: { type: "noul" as const, noul: 0.99 } },
    }),
  };
}

describe("reminder command boundary", () => {
  it("audits malformed input instead of treating it as a normal no-op", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "skillful-invalid-reminder-input-"));
    const env = { HOME: root, XDG_STATE_HOME: path.join(root, "state") };
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writes.push(String(value));
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    await remindCommand({ homeDir: root, cwd: root, env, stdin: "{truncated" });
    await remindCommand({
      homeDir: root,
      cwd: root,
      env,
      stdin: JSON.stringify({ hook_event_name: "SessionStart", source: "resume" }),
    });

    expect(writes[0]).toBe("{}\n");
    expect(writes[1]).toContain("missing session_id and transcript_path");
    const audit = readFileSync(path.join(root, "state", "reminder-decisions.jsonl"), "utf8");
    expect(audit).toContain("not valid JSON");
    expect(audit).toContain("missing session_id and transcript_path");
  });

  it("emits one JSON object per hook event and carries PostCompact state into SessionStart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "skillful-remind-command-"));
    const env = {
      HOME: root,
      TYPESAFE_API_KEY: "test",
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    };
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writes.push(String(value));
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    await expect(
      remindCommand({
        homeDir: root,
        cwd: root,
        env,
        deps: reminderDeps(),
        stdin: JSON.stringify({
          hook_event_name: "PostCompact",
          compact_summary: "release assets",
          session_id: "session-one",
        }),
      }),
    ).resolves.toBe(0);
    await expect(
      remindCommand({
        homeDir: root,
        cwd: root,
        env,
        deps: reminderDeps(),
        stdin: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "compact",
          session_id: "session-one",
        }),
      }),
    ).resolves.toBe(0);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe("{}\n");
    expect(JSON.parse(writes[1] ?? "{}")).toEqual(
      expect.objectContaining({
        hookSpecificOutput: expect.objectContaining({
          hookEventName: "SessionStart",
          additionalContext: expect.stringContaining("verify-release-assets"),
        }),
      }),
    );
  });

  it("does not consume a pending reminder through the fallback when disabled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "skillful-disabled-fallback-"));
    const baseEnv = {
      HOME: root,
      TYPESAFE_API_KEY: "test",
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    };
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writes.push(String(value));
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    await remindCommand({
      homeDir: root,
      cwd: root,
      env: baseEnv,
      deps: reminderDeps(),
      stdin: JSON.stringify({
        hook_event_name: "PostCompact",
        compact_summary: "release assets",
        session_id: "disabled-session",
      }),
    });
    writes.length = 0;

    await hookCommand({
      homeDir: root,
      cwd: root,
      env: { ...baseEnv, SKILLFUL_DISABLE: "true" },
      runtime: "claude-code",
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "continue",
        session_id: "disabled-session",
      }),
    });
    expect(writes).toEqual(["{}\n"]);

    writes.length = 0;
    await remindCommand({
      homeDir: root,
      cwd: root,
      env: baseEnv,
      deps: reminderDeps(),
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "disabled-session",
      }),
    });
    expect(writes[0]).toContain("verify-release-assets");
  });

  it("keeps a pending reminder when stdout reports EPIPE and retries no second write", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "skillful-output-ack-"));
    const env = {
      HOME: root,
      TYPESAFE_API_KEY: "test",
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    };
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writes.push(String(value));
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    await remindCommand({
      homeDir: root,
      cwd: root,
      env,
      deps: reminderDeps(),
      stdin: JSON.stringify({
        hook_event_name: "PostCompact",
        compact_summary: "release assets",
        session_id: "epipe-session",
      }),
    });
    writes.length = 0;
    stdout.mockImplementationOnce(((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writes.push(String(value));
      const error = new Error("EPIPE");
      callback?.(error);
      queueMicrotask(() => process.stdout.emit("error", error));
      return false;
    }) as typeof process.stdout.write);

    const startInput = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "compact",
      session_id: "epipe-session",
    });
    await expect(
      remindCommand({ homeDir: root, cwd: root, env, deps: reminderDeps(), stdin: startInput }),
    ).resolves.toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("verify-release-assets");

    writes.length = 0;
    await remindCommand({ homeDir: root, cwd: root, env, deps: reminderDeps(), stdin: startInput });
    expect(writes[0]).toContain("verify-release-assets");
  });

  it("defers an unexpected PostCompact failure to the supported SessionStart output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "skillful-unexpected-reminder-"));
    const env = { HOME: root, XDG_STATE_HOME: path.join(root, "state") };
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writes.push(String(value));
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    await expect(
      remindCommand({
        homeDir: root,
        cwd: root,
        env,
        deps: {
          now: () => {
            throw new Error("clock unavailable");
          },
        },
        stdin: JSON.stringify({
          hook_event_name: "PostCompact",
          compact_summary: "release assets",
          session_id: "unexpected-session",
        }),
      }),
    ).resolves.toBe(0);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("{}\n");
    expect(readFileSync(path.join(root, "state", "reminder-decisions.jsonl"), "utf8")).toContain(
      "clock unavailable",
    );

    writes.length = 0;
    await remindCommand({
      homeDir: root,
      cwd: root,
      env,
      stdin: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "unexpected-session",
      }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("unexpected reminder failure");
  });
});
