import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildReminderCorpus, extractRuleCitations } from "./corpus.js";
import { rankReminderDocuments } from "./rank.js";
import { runReminderHook, selectReminders } from "./runner.js";
import { loadCachedReminderCorpus, reminderIndexCachePath } from "./storage.js";
import { foldReminderText, tokenizeReminderText } from "./tokenize.js";
import type { ReminderDocument } from "./types.js";

function temporary(): string {
  return mkdtempSync(path.join(tmpdir(), "skillful-reminder-"));
}

function document(overrides: Partial<ReminderDocument> = {}): ReminderDocument {
  return {
    id: "rule:verify-release-assets",
    canonicalKey: "rule:verify-release-assets",
    kind: "rule",
    title: "verify-release-assets",
    hook: "Sprawdź kompletność artefaktów wydania.",
    path: "/rules/release.md",
    description: "Weryfikacja paczek przed publikacją",
    body: "SECRET BODY THAT MUST NOT BE RENDERED",
    identifiers: ["verify-release-assets", "release.md"],
    citations: [],
    ...overrides,
  };
}

describe("reminder corpus", () => {
  it("accepts only lowercase kebab rule citations and rejects links, wikilinks, and flags", () => {
    const citations = extractRuleCitations(
      'Użyj [verify-release-assets]. Odrzuć [--wait], [<id>], [t+1], ["sharpe"], [max], [1/3,2/3], [[wiki-link]] oraz [tekst](plik.md).',
    );
    expect([...citations.keys()]).toEqual(["verify-release-assets"]);
  });

  it("parses index targets, memory bodies, rule blocks and project CLAUDE sections", async () => {
    const home = temporary();
    const cwd = path.join(home, "work", "repo");
    mkdirSync(path.join(cwd, ".git"), { recursive: true });
    const config = path.join(home, "claude");
    const memory = path.join(config, "projects", path.resolve(cwd).replace(/[/.]/g, "-"), "memory");
    mkdirSync(memory, { recursive: true });
    mkdirSync(path.join(config, "rules"), { recursive: true });
    writeFileSync(path.join(memory, "MEMORY.md"), "- [Release](release-check.md)\n");
    writeFileSync(
      path.join(memory, "release-check.md"),
      "---\ntitle: Release safety\ndescription: Sprawdź paczki\n---\nBody [[other-note]]\n",
    );
    writeFileSync(
      path.join(config, "rules", "verify-release-assets.md"),
      "**[verify-release-assets]** Sprawdź wszystkie paczki.\nPełna treść.\n",
    );
    writeFileSync(path.join(cwd, "CLAUDE.md"), "## Test policy\nUruchom testy przed pushem.\n");

    const corpus = await buildReminderCorpus({
      homeDir: home,
      cwd,
      env: { HOME: home, CLAUDE_CONFIG_DIR: config },
    });
    expect(corpus.documents.some((item) => item.canonicalKey.endsWith("release-check.md"))).toBe(
      true,
    );
    expect(corpus.documents.some((item) => item.title === "verify-release-assets")).toBe(true);
    expect(corpus.documents.some((item) => item.title === "CLAUDE.md § Test policy")).toBe(true);
    expect(corpus.warnings.some((warning) => warning.includes("other-note"))).toBe(false);
  });

  it("rejects memory index targets whose symlinks escape the memory directory", async () => {
    const home = temporary();
    const cwd = path.join(home, "repo");
    const config = path.join(home, "claude");
    const memory = path.join(config, "projects", path.resolve(cwd).replace(/[/.]/g, "-"), "memory");
    mkdirSync(path.join(cwd, ".git"), { recursive: true });
    mkdirSync(memory, { recursive: true });
    const secret = path.join(home, "outside-secret.md");
    writeFileSync(secret, "DO-NOT-SEND-THIS-SECRET\n");
    symlinkSync(secret, path.join(memory, "escape.md"));
    writeFileSync(path.join(memory, "MEMORY.md"), "- [Escape](escape.md)\n");

    const corpus = await buildReminderCorpus({
      homeDir: home,
      cwd,
      env: { HOME: home, CLAUDE_CONFIG_DIR: config },
    });

    expect(corpus.warnings.join("\n")).toContain("resolves outside the memory directory");
    expect(JSON.stringify(corpus.documents)).not.toContain("DO-NOT-SEND-THIS-SECRET");
    expect(corpus.sources.map((source) => source.path)).not.toContain(secret);
  });
});

describe("reminder retrieval", () => {
  it("folds Polish text and retains whole plus split identifier and filename tokens", () => {
    expect(foldReminderText("Żółć")).toBe("zolc");
    expect(tokenizeReminderText("verify-release-assets release.check.md")).toEqual(
      expect.arrayContaining([
        "verify-release-assets",
        "verify",
        "release",
        "assets",
        "release.check.md",
        "check",
      ]),
    );
  });

  it("uses harvested Polish citation context to retrieve a rule", () => {
    const ranked = rankReminderDocuments(
      [
        document({
          citations: ["Przed pushem upewnij się, że wheel ma oba ABI [verify-release-assets]."],
        }),
        document({
          id: "rule:other-rule",
          canonicalKey: "rule:other-rule",
          title: "other-rule",
          citations: [],
        }),
      ],
      "czy wheel ma wszystkie ABI przed pushem?",
    );
    expect(ranked[0]?.document.id).toBe("rule:verify-release-assets");
  });

  it("fails open loudly without a key and never renders source bodies", async () => {
    const root = temporary();
    const noKey = await selectReminders("release", {
      homeDir: root,
      cwd: root,
      env: { HOME: root, XDG_STATE_HOME: path.join(root, "state") },
    });
    expect(noKey.degraded).toBe(true);
    expect(noKey.text).toContain("TYPESAFE_API_KEY");
    expect(statSync(path.join(root, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(root, "state", "reminder-decisions.jsonl")).mode & 0o777).toBe(0o600);

    const selected = await selectReminders("release assets", {
      homeDir: root,
      cwd: root,
      env: {
        HOME: root,
        TYPESAFE_API_KEY: "test",
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      buildCorpus: async () => ({
        documents: [document()],
        warnings: [],
        fingerprint: "one",
        sources: [],
      }),
      call: async () => ({
        model: "jev-latest",
        answers: { candidate_0: { type: "noul", noul: 0.99 } },
      }),
    });
    expect(selected.text).toContain("[verify-release-assets]");
    expect(selected.text).not.toContain("SECRET BODY");
    expect((selected.text ?? "").split("\n").length).toBeLessThan(40);
    const indexPath = reminderIndexCachePath(path.join(root, "cache"), root);
    expect(statSync(path.dirname(indexPath)).mode & 0o777).toBe(0o700);
    expect(statSync(indexPath).mode & 0o777).toBe(0o600);
  });

  it("never builds or uploads reminder candidates when prompt upload is disabled", async () => {
    const root = temporary();
    const buildCorpus = vi.fn();
    const call = vi.fn();
    const result = await selectReminders("private task text", {
      homeDir: root,
      cwd: root,
      env: {
        HOME: root,
        TYPESAFE_API_KEY: "test",
        SKILLFUL_UPLOAD_PROMPT: "false",
        XDG_STATE_HOME: path.join(root, "state"),
      },
      buildCorpus,
      call,
    });

    expect(result.degraded).toBe(true);
    expect(result.reason).toBe("prompt upload disabled");
    expect(buildCorpus).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("distinguishes an empty index and an upstream failure from no relevant reminder", async () => {
    const root = temporary();
    const env = {
      HOME: root,
      TYPESAFE_API_KEY: "test",
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    };
    const empty = await selectReminders("release", {
      homeDir: root,
      cwd: root,
      env,
      buildCorpus: async () => ({
        documents: [],
        warnings: ["Reminder memory index is empty or unavailable: test"],
        fingerprint: "empty",
        sources: [],
      }),
    });
    expect(empty.degraded).toBe(true);
    expect(empty.text).toContain("index is empty");

    const upstream = await selectReminders("release assets", {
      homeDir: root,
      cwd: root,
      env,
      buildCorpus: async () => ({
        documents: [document()],
        warnings: [],
        fingerprint: "one",
        sources: [],
      }),
      call: async () => {
        throw new Error("upstream unavailable");
      },
    });
    expect(upstream.degraded).toBe(true);
    expect(upstream.text).toContain("upstream unavailable");

    const partial = await selectReminders("release assets", {
      homeDir: root,
      cwd: root,
      env,
      buildCorpus: async () => ({
        documents: [document()],
        warnings: [],
        fingerprint: "two",
        sources: [],
      }),
      call: async () => ({ model: "jev-latest", answers: {} }),
    });
    expect(partial.degraded).toBe(true);
    expect(partial.text).toContain("missing a valid candidate_0");

    const invalidThreshold = await selectReminders("release assets", {
      homeDir: root,
      cwd: root,
      env: { ...env, SKILLFUL_REMINDER_THRESHOLD: "2" },
      buildCorpus: async () => ({
        documents: [document()],
        warnings: [],
        fingerprint: "three",
        sources: [],
      }),
      call: async () => ({
        model: "jev-latest",
        answers: { candidate_0: { type: "noul" as const, noul: 0.99 } },
      }),
    });
    expect(invalidThreshold.degraded).toBe(true);
    expect(invalidThreshold.text).toContain("between 0 and 1");
  });

  it("invalidates the private index cache when source mtime changes", async () => {
    const home = temporary();
    const cwd = path.join(home, "repo");
    const config = path.join(home, "claude");
    const memory = path.join(config, "projects", path.resolve(cwd).replace(/[/.]/g, "-"), "memory");
    mkdirSync(path.join(cwd, ".git"), { recursive: true });
    mkdirSync(memory, { recursive: true });
    writeFileSync(path.join(memory, "MEMORY.md"), "- [One](one.md)\n");
    const bodyPath = path.join(memory, "one.md");
    writeFileSync(bodyPath, "---\ntitle: One\n---\nalpha\n");
    const first = await buildReminderCorpus({
      homeDir: home,
      cwd,
      env: { HOME: home, CLAUDE_CONFIG_DIR: config },
    });
    const cachePath = path.join(home, "cache", "index.json");
    loadCachedReminderCorpus(cachePath, first);
    const later = new Date(Date.now() + 5_000);
    utimesSync(bodyPath, later, later);
    const second = await buildReminderCorpus({
      homeDir: home,
      cwd,
      env: { HOME: home, CLAUDE_CONFIG_DIR: config },
    });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(loadCachedReminderCorpus(cachePath, second).fingerprint).toBe(second.fingerprint);
  });

  it("stores PostCompact output and injects it on the following compact SessionStart once", async () => {
    const root = temporary();
    const options = {
      homeDir: root,
      cwd: root,
      env: {
        HOME: root,
        TYPESAFE_API_KEY: "test",
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        SKILLFUL_REMINDER_COOLDOWN_MS: "0",
      },
      buildCorpus: async () => ({
        documents: [document()],
        warnings: [],
        fingerprint: "one",
        sources: [],
      }),
      call: async () => ({
        model: "jev-latest",
        answers: { candidate_0: { type: "noul" as const, noul: 0.99 } },
      }),
    };
    const post = await runReminderHook(
      {
        hook_event_name: "PostCompact",
        trigger: "auto",
        compact_summary: "release assets",
        session_id: "s1",
      },
      options,
    );
    expect(post.payload).toEqual({});
    const start = await runReminderHook(
      { hook_event_name: "SessionStart", source: "compact", session_id: "s1" },
      options,
    );
    expect(JSON.stringify(start.payload)).toContain("verify-release-assets");
    start.acknowledge?.();
    const repeated = await runReminderHook(
      { hook_event_name: "SessionStart", source: "compact", session_id: "s1" },
      options,
    );
    expect(repeated.payload).toEqual({});
    expect(
      readFileSync(
        path.join(
          root,
          "state",
          "reminders",
          "sessions",
          `${await import("node:crypto").then(({ createHash }) => createHash("sha256").update("s1").digest("hex"))}.json`,
        ),
        "utf8",
      ),
    ).not.toContain('"pending"');
    const sessionDir = path.join(root, "state", "reminders", "sessions");
    const sessionFile = path.join(
      sessionDir,
      `${await import("node:crypto").then(({ createHash }) => createHash("sha256").update("s1").digest("hex"))}.json`,
    );
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
  });

  it("reports corrupt session state without overwriting it", async () => {
    const root = temporary();
    const sessionId = "corrupt-session";
    const sessionFile = path.join(
      root,
      "state",
      "reminders",
      "sessions",
      `${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(sessionId).digest("hex"))}.json`,
    );
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "{not-json\n");

    const result = await runReminderHook(
      { hook_event_name: "SessionStart", source: "compact", session_id: sessionId },
      {
        homeDir: root,
        cwd: root,
        env: { HOME: root, XDG_STATE_HOME: path.join(root, "state") },
      },
    );

    expect(JSON.stringify(result.payload)).toContain("session state is unreadable");
    expect(readFileSync(sessionFile, "utf8")).toBe("{not-json\n");
  });

  it("still delivers a resume reminder and reports PostCompact when state persistence fails", async () => {
    const root = temporary();
    const writeSession = (): never => {
      const error = new Error("disk full") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    };
    const options = {
      homeDir: root,
      cwd: root,
      env: {
        HOME: root,
        TYPESAFE_API_KEY: "test",
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      buildCorpus: async () => ({
        documents: [document()],
        warnings: [],
        fingerprint: "persistence",
        sources: [],
      }),
      call: async () => ({
        model: "jev-latest",
        answers: { candidate_0: { type: "noul" as const, noul: 0.99 } },
      }),
      writeSession,
    };

    const resume = await runReminderHook(
      {
        hook_event_name: "SessionStart",
        source: "resume",
        compact_summary: "release assets",
        session_id: "resume-write-failure",
      },
      options,
    );
    expect(JSON.stringify(resume.payload)).toContain("verify-release-assets");
    resume.acknowledge?.();
    expect(readFileSync(path.join(root, "state", "reminder-decisions.jsonl"), "utf8")).toContain(
      "ENOSPC",
    );

    const compact = await runReminderHook(
      {
        hook_event_name: "PostCompact",
        compact_summary: "release assets",
        session_id: "compact-write-failure",
      },
      options,
    );
    expect(compact.payload).toEqual({});
    expect(compact.selection?.degraded).toBe(true);
    const deferred = await runReminderHook(
      {
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "compact-write-failure",
      },
      options,
    );
    expect(JSON.stringify(deferred.payload)).toContain("ENOSPC");
    deferred.acknowledge?.();
  });

  it("fully disables reminder work for all supported truthy disable values", async () => {
    const buildCorpus = async () => ({
      documents: [document()],
      warnings: [],
      fingerprint: "disabled",
      sources: [],
    });
    for (const value of ["1", "true", "yes", "on"]) {
      const root = temporary();
      const result = await runReminderHook(
        {
          hook_event_name: "SessionStart",
          source: "resume",
          compact_summary: "release assets",
          session_id: value,
        },
        {
          homeDir: root,
          cwd: root,
          env: {
            HOME: root,
            TYPESAFE_API_KEY: "test",
            XDG_STATE_HOME: path.join(root, "state"),
            SKILLFUL_DISABLE: value,
          },
          buildCorpus,
        },
      );
      expect(result.payload).toEqual({});
      expect(() => statSync(path.join(root, "state"))).toThrow();
    }
  });
});
