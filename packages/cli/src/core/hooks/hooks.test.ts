/**
 * Tests for the phase 4 hook layer.
 *
 * The emphasis is deliberate. These modules write into configuration files the user did not
 * create, on every install and on every prompt, so the tests that matter are the ones about
 * *not damaging things*: not removing someone else's hook, not overwriting an unparseable
 * file, not caching a failure, not throwing out of a hook.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Catalog } from "../catalog/types.js";
import type { RouteResult } from "../router/route.js";
import {
  cacheGet,
  cacheSet,
  emptyCache,
  loadCache,
  normalisePrompt,
  pruneCache,
  routeCacheKey,
  saveCache,
} from "./cache.js";
import { detectRuntimes, presentRuntimes, runtimeLocations } from "./detect.js";
import { buildInstallContext, hookStatus, installHooks, uninstallHooks } from "./install.js";
import {
  backupFile,
  type HookEntry,
  isSkillfulEntry,
  readJsonFile,
  removeSkillfulEntries,
  SKILLFUL_HOOK_MARKER,
  upsertSkillfulEntry,
  writeJsonAtomic,
} from "./json-merge.js";
import { renderInjection } from "./render.js";
import { isDisabled, runHook } from "./runner.js";

const tempDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skillful-hooks-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// json-merge
// ---------------------------------------------------------------------------

describe("json-merge", () => {
  it("keeps every other key and preserves the order of entries it does not own", () => {
    const entries: HookEntry[] = [
      { matcher: "Bash", hooks: [{ type: "command", command: "other-tool-a" }] },
      { matcher: "*", hooks: [{ type: "command", command: `node x ${SKILLFUL_HOOK_MARKER}` }] },
      { matcher: "Edit", hooks: [{ type: "command", command: "other-tool-b" }] },
    ];

    const { entries: next, removed } = removeSkillfulEntries(entries);

    expect(removed).toBe(1);
    expect(next).toHaveLength(2);
    expect(next[0]?.hooks[0]?.command).toBe("other-tool-a");
    expect(next[1]?.hooks[0]?.command).toBe("other-tool-b");
  });

  it("recognises only entries carrying the marker", () => {
    expect(
      isSkillfulEntry({
        hooks: [{ type: "command", command: "node skillful hook --managed-by-skillful" }],
      }),
    ).toBe(true);
    // A different tool whose command merely contains the word "skillful" is not ours.
    expect(
      isSkillfulEntry({ hooks: [{ type: "command", command: "node /opt/skillful-hooks/run.js" }] }),
    ).toBe(false);
    expect(isSkillfulEntry({ hooks: [] })).toBe(false);
  });

  it("is idempotent: re-upserting the same entry reports no change", () => {
    const entry: HookEntry = {
      matcher: "*",
      hooks: [{ type: "command", command: `node c ${SKILLFUL_HOOK_MARKER}` }],
    };

    const first = upsertSkillfulEntry([], entry);
    expect(first.changed).toBe(true);

    const second = upsertSkillfulEntry(first.entries, entry);
    expect(second.changed).toBe(false);
    expect(second.replaced).toBe(1);
    expect(second.entries).toEqual(first.entries);
  });

  it("reports an unparseable file rather than pretending it is empty", () => {
    const home = makeHome();
    const file = path.join(home, "settings.json");
    writeFileSync(file, "{ this is not json", "utf8");

    const read = readJsonFile(file);
    expect(read.existed).toBe(true);
    expect(read.data).toBeNull();
    expect(read.error).toContain("not valid JSON");
  });

  it("treats a missing file as empty rather than as an error", () => {
    const read = readJsonFile(path.join(makeHome(), "absent.json"));
    expect(read.existed).toBe(false);
    expect(read.data).toBeNull();
    expect(read.error).toBeUndefined();
  });

  it("writes atomically and leaves no temp file behind", () => {
    const home = makeHome();
    const file = path.join(home, "nested", "deep.json");
    writeJsonAtomic(file, { a: 1 });

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: 1 });
    // The temp file is renamed into place, so the directory must hold exactly one entry.
    expect(readdirSync(path.join(home, "nested"))).toEqual(["deep.json"]);
  });

  it("backs up an existing file before it is modified", () => {
    const home = makeHome();
    const file = path.join(home, "settings.json");
    writeFileSync(file, '{"keep":true}', "utf8");

    const backup = backupFile(file, "20260101-000000");
    expect(backup).not.toBeNull();
    expect(readFileSync(backup as string, "utf8")).toBe('{"keep":true}');

    // Nothing to back up when the file does not exist.
    expect(backupFile(path.join(home, "absent.json"), "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

const INJECTED: RouteResult = {
  decision: {
    kind: "injected",
    primary: {
      id: "a:skill:g:x",
      kind: "skill",
      name: "x",
      description: "d",
      sourcePath: "/p",
      alternates: [],
    },
    runnersUp: [],
    confidence: 1,
    noneP: 0,
  },
  shortlist: ["a:skill:g:x"],
  shortlistDetail: [],
  ranking: [],
  latencyMs: 10,
  cacheHit: false,
  promptChars: 20,
  provider: "typesafe",
  model: "jev-latest",
};

const DEGRADED: RouteResult = {
  ...INJECTED,
  decision: { kind: "degraded", reason: "network" },
};

describe("cache", () => {
  it("keys on the normalised prompt and the catalog fingerprint", () => {
    // Case and whitespace differences must share an entry.
    expect(routeCacheKey("Fix   The  Bug", "fp")).toBe(routeCacheKey("fix the bug", "fp"));
    // A different catalog must not.
    expect(routeCacheKey("fix the bug", "fp")).not.toBe(routeCacheKey("fix the bug", "fp2"));
    // Switching provider/model must not serve a decision billed and made elsewhere.
    expect(routeCacheKey("fix the bug", "fp", "typesafe|jev-latest")).not.toBe(
      routeCacheKey("fix the bug", "fp", "vercel|typesafe-ai/jev"),
    );
    expect(normalisePrompt("  A \n B  ")).toBe("a b");
  });

  it("refuses to cache a degraded result", () => {
    const store = emptyCache();
    expect(cacheSet(store, "k", DEGRADED)).toBe(false);
    expect(store.entries["k"]).toBeUndefined();

    // ...and caches a resolved one.
    expect(cacheSet(store, "k", INJECTED)).toBe(true);
    expect(store.entries["k"]?.result).toBe(INJECTED);
  });

  it("expires entries past the TTL", () => {
    const store = emptyCache();
    cacheSet(store, "k", INJECTED, { now: 1_000 });

    expect(cacheGet(store, "k", { ttlMs: 500, now: 1_200 })).toBeDefined();
    expect(cacheGet(store, "k", { ttlMs: 500, now: 2_000 })).toBeUndefined();
  });

  it("prunes expired entries and enforces the size cap oldest-first", () => {
    const store = emptyCache();
    cacheSet(store, "old", INJECTED, { now: 1_000 });
    cacheSet(store, "mid", INJECTED, { now: 2_000 });
    cacheSet(store, "new", INJECTED, { now: 3_000 });

    // At now=3100 with a 1500ms TTL, `old` (age 2100) is expired while `mid` (age 1100) and
    // `new` (age 100) are both still live.
    const pruned = pruneCache(store, { ttlMs: 1_500, maxEntries: 10, now: 3_100 });
    expect(Object.keys(pruned.entries).sort()).toEqual(["mid", "new"]);

    const capped = pruneCache(store, { ttlMs: 10_000, maxEntries: 2, now: 3_100 });
    expect(Object.keys(capped.entries).sort()).toEqual(["mid", "new"]);
  });

  it("treats a corrupt cache file as empty instead of failing", () => {
    const home = makeHome();
    const file = path.join(home, "routes.json");
    writeFileSync(file, "not json at all", "utf8");
    expect(Object.keys(loadCache(file).entries)).toHaveLength(0);

    // A store from an older schema version is discarded rather than misread.
    writeFileSync(
      file,
      JSON.stringify({ version: 99, entries: { a: { result: INJECTED, ts: 1 } } }),
      "utf8",
    );
    expect(Object.keys(loadCache(file).entries)).toHaveLength(0);
  });

  it("round-trips through disk", () => {
    const home = makeHome();
    const file = path.join(home, "nested", "routes.json");
    const store = emptyCache();
    cacheSet(store, "k", INJECTED, { now: 5 });
    saveCache(file, store);

    expect(loadCache(file).entries["k"]?.ts).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

describe("render", () => {
  function injectedWith(runnersUp: number, description = "d"): RouteResult {
    return {
      ...INJECTED,
      decision: {
        kind: "injected",
        primary: {
          id: "p",
          kind: "skill",
          name: "primary",
          description,
          sourcePath: "/p",
          alternates: [],
        },
        runnersUp: Array.from({ length: runnersUp }, (_, i) => ({
          id: `r${i}`,
          kind: "skill" as const,
          name: `runner${i}`,
          description: "d",
          sourcePath: "/p",
          alternates: [],
          noul: 0.9,
        })),
        confidence: 1,
        noneP: 0,
      },
    };
  }

  it("injects nothing when the decision is not an injection", () => {
    expect(renderInjection(DEGRADED)).toBeNull();
    expect(
      renderInjection({ ...INJECTED, decision: { kind: "skipped", reason: "none-won" } }),
    ).toBeNull();
  });

  it("caps runner-ups at two even when more cleared the threshold", () => {
    const text = renderInjection(injectedWith(5));
    expect(text).toContain("runner0");
    expect(text).toContain("runner1");
    expect(text).not.toContain("runner2");
  });

  it("omits the runner-up line entirely when there are none", () => {
    const text = renderInjection(injectedWith(0));
    expect(text).toContain("primary");
    expect(text).not.toContain("Also available");
    expect(text?.split("\n")).toHaveLength(1);
  });

  it("renders the directly executable CLI invocation instead of a bare project bin name", () => {
    const result = injectedWith(0);
    if (result.decision.kind !== "injected") throw new Error("expected injected fixture");
    result.decision.primary.kind = "cli-command";
    result.decision.primary.invocationHint = "'/project/node_modules/.bin/demo tool' run";

    expect(renderInjection(result)).toContain("'/project/node_modules/.bin/demo tool' run");
  });

  it("stays within the character budget on a long description", () => {
    const text = renderInjection(injectedWith(2, "x".repeat(2000)), { maxChars: 200 });
    expect(text).not.toBeNull();
    expect((text as string).length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe("detect", () => {
  it("reports a runtime as present only when its configuration directory exists", () => {
    const home = makeHome();
    // Create only Claude Code's directory. A binary on PATH must not be enough, and a missing
    // directory must not be reported as installed.
    writeFileSync(path.join(home, "placeholder"), "", "utf8");
    mkdirSync(path.join(home, ".claude"), { recursive: true });

    const detected = detectRuntimes(home);
    const present = presentRuntimes(home).map((entry) => entry.runtime);

    expect(present).toEqual(["claude-code"]);
    expect(detected).toHaveLength(4);
    expect(detected.find((entry) => entry.runtime === "codex")?.present).toBe(false);
  });

  it("honours environment overrides so hooks land where the scanner looks", () => {
    const home = makeHome();
    const locations = runtimeLocations(home, {
      CLAUDE_CONFIG_DIR: "/custom/claude",
      CODEX_HOME: "/custom/codex",
      OMP_HOME: "/custom/omp",
    });
    expect(locations.find((l) => l.runtime === "claude-code")?.configDir).toBe("/custom/claude");
    expect(locations.find((l) => l.runtime === "claude-code")?.hookTarget).toBe(
      "/custom/claude/settings.json",
    );
    expect(locations.find((l) => l.runtime === "codex")?.configDir).toBe("/custom/codex");
    expect(locations.find((l) => l.runtime === "omp")?.configDir).toBe("/custom/omp");
    expect(locations.find((l) => l.runtime === "claude-code")?.mechanism).toBe("hook");
    expect(locations.find((l) => l.runtime === "pi")?.mechanism).toBe("extension");
  });
});

// ---------------------------------------------------------------------------
// installers
// ---------------------------------------------------------------------------

function installContext(home: string, dryRun = false) {
  return buildInstallContext({
    homeDir: home,
    env: { HOME: home },
    cliEntry: "/opt/skillful/dist/bin.js",
    nodeBin: "/usr/bin/node",
    stamp: "20260101-000000",
    dryRun,
  });
}

describe("installers", () => {
  it("installs for every runtime present and is idempotent on a second run", () => {
    const home = makeHome();
    for (const dir of [".claude", ".codex", ".pi/agent", ".omp/agent"]) {
      mkdirSync(path.join(home, dir), { recursive: true });
    }

    const ctx = installContext(home);
    const first = installHooks(ctx);
    expect(first.outcomes.map((o) => o.action)).toEqual([
      "installed",
      "installed",
      "installed",
      "installed",
    ]);

    const second = installHooks(installContext(home));
    expect(second.outcomes.map((o) => o.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
    ]);

    // The settings file must not accumulate duplicate entries.
    const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--runtime claude-code");
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].matcher).toBe("startup|resume|clear");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "refresh --runtime claude-code",
    );
    expect(settings.hooks.SessionStart[0].hooks[0].async).toBe(true);
    expect(settings.hooks.SessionStart[1].matcher).toBe("resume|compact");
    expect(settings.hooks.SessionStart[1].hooks[0].command).toContain(" remind ");
    expect(settings.hooks.PostCompact).toHaveLength(1);
    expect(settings.hooks.PostCompact[0].matcher).toBe("manual|auto");

    const codex = JSON.parse(readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
    expect(codex.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--runtime codex");
    expect(codex.hooks.SessionStart[0].hooks[0].command).toContain("refresh --runtime codex");
    expect(codex.hooks.SessionStart[0].hooks[0].async).toBe(true);
  });

  it("installs the Claude hook under CLAUDE_CONFIG_DIR", () => {
    const home = makeHome();
    const configDir = path.join(home, "custom-claude");
    mkdirSync(configDir, { recursive: true });
    const ctx = buildInstallContext({
      homeDir: home,
      env: { HOME: home, CLAUDE_CONFIG_DIR: configDir },
      cliEntry: "/opt/skillful/dist/bin.js",
      nodeBin: "/usr/bin/node",
      stamp: "20260101-000000",
    });

    const summary = installHooks(ctx, ["claude-code"]);

    expect(summary.outcomes).toEqual([
      expect.objectContaining({
        runtime: "claude-code",
        action: "installed",
        target: path.join(configDir, "settings.json"),
      }),
    ]);
    expect(
      JSON.parse(readFileSync(path.join(configDir, "settings.json"), "utf8")).hooks.SessionStart,
    ).toHaveLength(2);
    expect(fsExists(path.join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("can pin hooks and generated extensions to an absolute credential launcher", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    const launcher = path.join(home, ".local", "bin", "skillful-vercel");
    const ctx = buildInstallContext({
      homeDir: home,
      env: { HOME: home, SKILLFUL_HOOK_LAUNCHER: launcher },
      cliEntry: "/opt/skillful/dist/bin.js",
      nodeBin: "/usr/bin/node",
      stamp: "20260101-000000",
    });

    const summary = installHooks(ctx, ["claude-code", "pi"]);
    expect(summary.hookLauncher).toBe(launcher);
    const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command.startsWith(`"${launcher}" hook`)).toBe(
      true,
    );
    const extension = readFileSync(
      path.join(home, ".pi", "agent", "extensions", "skillful", "index.ts"),
      "utf8",
    );
    expect(extension).toContain(`const EXECUTABLE = ${JSON.stringify(launcher)}`);
    expect(extension).toContain("const ARGUMENT_PREFIX = []");
    expect(extension).not.toContain("/opt/skillful/dist/bin.js");
  });

  it("rejects a relative hook launcher instead of writing cwd-dependent commands", () => {
    expect(() =>
      buildInstallContext({
        homeDir: "/home/test",
        env: { SKILLFUL_HOOK_LAUNCHER: "./skillful-vercel" },
        cliEntry: "/opt/skillful/dist/bin.js",
      }),
    ).toThrow("absolute path");
  });

  it("leaves another tool's hooks untouched and removes only its own on uninstall", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });

    const settingsPath = path.join(home, ".claude", "settings.json");
    const original = {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: {
        UserPromptSubmit: [
          { matcher: "*", hooks: [{ type: "command", command: "node /other/tool.cjs" }] },
        ],
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: "node /other/stop.cjs" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), "utf8");

    installHooks(installContext(home));
    const afterInstall = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(afterInstall.hooks.UserPromptSubmit).toHaveLength(2);
    expect(afterInstall.hooks.UserPromptSubmit[0].hooks[0].command).toBe("node /other/tool.cjs");
    expect(afterInstall.model).toBe("opus");
    expect(afterInstall.permissions).toEqual({ allow: ["Bash"] });

    uninstallHooks(installContext(home));
    const afterUninstall = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(afterUninstall).toEqual(original);
  });

  it("preserves an existing Claude PostCompact hook beside the reminder layer", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const settingsPath = path.join(home, ".claude", "settings.json");
    const existing = {
      matcher: "*",
      hooks: [{ type: "command", command: "python3 /other/compact.py" }],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PostCompact: [existing] } }), "utf8");

    installHooks(installContext(home), ["claude-code"]);
    const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(installed.hooks.PostCompact).toHaveLength(2);
    expect(installed.hooks.PostCompact[0]).toEqual(existing);
    expect(installed.hooks.PostCompact[1].hooks[0].command).toContain(" remind ");

    uninstallHooks(installContext(home), ["claude-code"]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      hooks: { PostCompact: [existing] },
    });
  });

  it("preserves a foreign command sharing an entry with an old Skillful command", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const settingsPath = path.join(home, ".claude", "settings.json");
    const foreign = { type: "command", command: "python3 /other/shared.py", timeout: 7 };
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "shared",
              customMetadata: "keep-me",
              hooks: [
                foreign,
                { type: "command", command: "node /old/skillful.js --managed-by-skillful" },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    installHooks(installContext(home), ["claude-code"]);
    uninstallHooks(installContext(home), ["claude-code"]);

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      hooks: {
        UserPromptSubmit: [{ matcher: "shared", customMetadata: "keep-me", hooks: [foreign] }],
      },
    });
  });

  it("leaves no trace when it was the only hook in the file", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const settingsPath = path.join(home, ".claude", "settings.json");

    // Start from no settings file at all, as a first-time user would.
    installHooks(installContext(home));
    expect(fsExists(settingsPath) || readFileSync(settingsPath, "utf8").length > 0).toBe(true);

    uninstallHooks(installContext(home));

    // An emptied `hooks.UserPromptSubmit: []` would be a visible trace in a diff and would
    // survive into the next install, so the container and then the file are removed.
    expect(fsExists(settingsPath)).toBe(false);
  });

  it("does not touch a configuration file it cannot parse", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });

    const settingsPath = path.join(home, ".claude", "settings.json");
    const broken = "{ broken";
    writeFileSync(settingsPath, broken, "utf8");

    const summary = installHooks(installContext(home));
    const claude = summary.outcomes.find((o) => o.runtime === "claude-code");
    expect(claude?.action).toBe("skipped");
    expect(claude?.error).toContain("not valid JSON");
    // The bytes on disk are exactly what they were.
    expect(readFileSync(settingsPath, "utf8")).toBe(broken);
  });

  it("writes nothing at all in a dry run", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });

    installHooks(installContext(home, true));
    expect(() => readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toThrow();
    expect(fsExists(path.join(home, ".claude", "extensions"))).toBe(false);
  });

  it("writes an extension for Pi and OMP and removes exactly that directory", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".pi/agent/extensions"), { recursive: true });
    // A neighbouring extension must survive.
    mkdirSync(path.join(home, ".pi/agent/extensions/other-tool"), { recursive: true });
    writeFileSync(path.join(home, ".pi/agent/extensions/other-tool/index.ts"), "// other", "utf8");

    installHooks(installContext(home));
    const entry = path.join(home, ".pi/agent/extensions/skillful/index.ts");
    const source = readFileSync(entry, "utf8");
    expect(source).toContain("before_agent_start");
    expect(source).toContain("/opt/skillful/dist/bin.js");

    uninstallHooks(installContext(home));
    expect(fsExists(path.join(home, ".pi/agent/extensions/skillful"))).toBe(false);
    expect(fsExists(path.join(home, ".pi/agent/extensions/other-tool/index.ts"))).toBe(true);
  });

  it("reports hook status consistently with what uninstall would remove", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".claude"), { recursive: true });

    expect(hookStatus(home).find((s) => s.runtime === "claude-code")?.installed).toBe(false);
    installHooks(installContext(home));
    expect(hookStatus(home).find((s) => s.runtime === "claude-code")?.installed).toBe(true);
    uninstallHooks(installContext(home));
    expect(hookStatus(home).find((s) => s.runtime === "claude-code")?.installed).toBe(false);
  });
});

function fsExists(target: string): boolean {
  try {
    readFileSync(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// runner — the fail-open contract
// ---------------------------------------------------------------------------

const EMPTY_CATALOG: Catalog = { entries: [], fingerprint: "fp-empty", warnings: [] };

function deps(
  home: string,
  env: Record<string, string | undefined>,
  routeFn?: typeof import("../router/route.js").route,
) {
  return {
    homeDir: home,
    cwd: home,
    env,
    scan: async (): Promise<Catalog> => EMPTY_CATALOG,
    ...(routeFn === undefined ? {} : { routeFn }),
  };
}

describe("runner", () => {
  it("passes the active runtime into catalog scanning", async () => {
    const home = makeHome();
    let options: Record<string, unknown> | undefined;
    await runHook(
      { prompt: "refactor auth", runtime: "codex" },
      {
        ...deps(
          home,
          { TYPESAFE_API_KEY: "k" },
          (async () => INJECTED) as typeof import("../router/route.js").route,
        ),
        scan: async (received) => {
          options = received;
          return EMPTY_CATALOG;
        },
      },
    );
    expect(options).toEqual(
      expect.objectContaining({ runtimes: ["codex"], includeCachedCapabilities: true }),
    );
  });

  it("fails closed for client-specific cache when an old hook has no runtime", async () => {
    const home = makeHome();
    let options: Record<string, unknown> | undefined;
    await runHook(
      { prompt: "refactor auth" },
      {
        ...deps(
          home,
          { TYPESAFE_API_KEY: "k" },
          (async () => INJECTED) as typeof import("../router/route.js").route,
        ),
        scan: async (received) => {
          options = received;
          return EMPTY_CATALOG;
        },
      },
    );
    expect(options).toEqual(expect.objectContaining({ includeCachedCapabilities: false }));
  });

  it("recognises the disable switch", () => {
    expect(isDisabled({ SKILLFUL_DISABLE: "1" })).toBe(true);
    expect(isDisabled({ SKILLFUL_DISABLE: "true" })).toBe(true);
    expect(isDisabled({ SKILLFUL_DISABLE: "0" })).toBe(false);
    expect(isDisabled({})).toBe(false);
  });

  it("injects nothing and does no work when disabled", async () => {
    const home = makeHome();
    let scanned = false;
    const outcome = await runHook(
      { prompt: "refactor the auth middleware" },
      {
        ...deps(home, { SKILLFUL_DISABLE: "1" }),
        scan: async () => {
          scanned = true;
          return EMPTY_CATALOG;
        },
      },
    );

    expect(outcome.payload).toEqual({});
    expect(outcome.degraded).toBe(false);
    expect(scanned).toBe(false);
  });

  it("degrades to a reminder when no key is configured, without throwing", async () => {
    const outcome = await runHook({ prompt: "refactor the auth middleware" }, deps(makeHome(), {}));
    expect(outcome.degraded).toBe(true);
    expect(outcome.payload.hookSpecificOutput?.additionalContext).toContain(
      "npx @mrgoonie/skillful",
    );
  });

  it("accepts an explicitly selected Vercel provider without a TypeSafe key", async () => {
    const home = makeHome();
    let routeOptions: Record<string, unknown> | undefined;
    const routeFn = (async (_prompt: string, options: Record<string, unknown>) => {
      routeOptions = options;
      return INJECTED;
    }) as unknown as typeof import("../router/route.js").route;

    const outcome = await runHook(
      { prompt: "refactor the auth middleware" },
      deps(
        home,
        { SKILLFUL_PROVIDER: "vercel", AI_GATEWAY_API_KEY: "v" },
        routeFn,
      ),
    );

    expect(outcome.degraded).toBe(false);
    expect(routeOptions).toEqual(
      expect.objectContaining({
        provider: "vercel",
        model: "typesafe-ai/jev",
        baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      }),
    );
  });

  it("injects nothing for an empty prompt", async () => {
    const outcome = await runHook({ prompt: "   " }, deps(makeHome(), {}));
    expect(outcome.payload).toEqual({});
    expect(outcome.degraded).toBe(false);
  });

  it("never throws when the catalog scan fails", async () => {
    const outcome = await runHook(
      { prompt: "refactor the auth middleware" },
      {
        ...deps(makeHome(), { TYPESAFE_API_KEY: "k" }),
        scan: async () => {
          throw new Error("disk exploded");
        },
      },
    );

    expect(outcome.degraded).toBe(true);
    expect(outcome.payload).toEqual({});
    expect(outcome.reason).toContain("disk exploded");
  });

  it("renders an injection on a successful route", async () => {
    const home = makeHome();
    const routeFn = (async () => INJECTED) as unknown as typeof import("../router/route.js").route;

    const outcome = await runHook(
      { prompt: "refactor the auth middleware" },
      deps(home, { TYPESAFE_API_KEY: "k" }, routeFn),
    );

    expect(outcome.degraded).toBe(false);
    expect(outcome.payload.hookSpecificOutput?.additionalContext).toContain("x — d");
    expect(outcome.payload.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
  });

  it("serves a second identical prompt from cache without calling the router again", async () => {
    const home = makeHome();
    let calls = 0;
    const routeFn = (async () => {
      calls += 1;
      return INJECTED;
    }) as unknown as typeof import("../router/route.js").route;

    const first = await runHook(
      { prompt: "refactor the auth middleware" },
      deps(home, { TYPESAFE_API_KEY: "k" }, routeFn),
    );
    const second = await runHook(
      { prompt: "Refactor  the auth middleware" },
      deps(home, { TYPESAFE_API_KEY: "k" }, routeFn),
    );

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not cache a degraded route, so an outage cannot freeze the behaviour", async () => {
    const home = makeHome();
    let calls = 0;
    const routeFn = (async () => {
      calls += 1;
      return DEGRADED;
    }) as unknown as typeof import("../router/route.js").route;

    await runHook(
      { prompt: "refactor the auth middleware" },
      deps(home, { TYPESAFE_API_KEY: "k" }, routeFn),
    );
    await runHook(
      { prompt: "refactor the auth middleware" },
      deps(home, { TYPESAFE_API_KEY: "k" }, routeFn),
    );

    expect(calls).toBe(2);
  });
});
