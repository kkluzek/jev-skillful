import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCapabilityCache, readCapabilityEntries } from "./cache.js";
import { refreshCapabilities } from "./refresh.js";

let root: string;
let homeDir: string;
let projectDir: string;
let cachePath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skillful-refresh-"));
  homeDir = path.join(root, "home");
  projectDir = path.join(root, "project");
  cachePath = path.join(root, "cache.json");
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("refreshCapabilities", () => {
  it("preserves MCP suppression for every client when a corrupt cache gets a CLI-only refresh", async () => {
    await writeFile(cachePath, "{broken-json\n");
    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: false,
        cachePath,
      },
      {
        discoverCli: async () => ({ complete: true, warnings: [], commands: [] }),
      },
    );

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(
      readCapabilityEntries(cachePath, {
        runtimes: ["codex", "claude-code"],
        workspaceKey,
      }).mcpInventoryRuntimes,
    ).toEqual(["claude-code", "codex"]);
    expect(
      readCapabilityEntries(cachePath, {
        runtimes: ["codex", "claude-code"],
        workspaceKey: "a-different-workspace",
      }).mcpInventoryRuntimes,
    ).toEqual(["claude-code", "codex"]);
    expect(
      readCapabilityEntries(cachePath, {
        runtimes: ["codex", "claude-code"],
      }).mcpInventoryRuntimes,
    ).toEqual(["claude-code", "codex"]);
  });

  it("writes exact MCP tools into client-specific partitions", async () => {
    const result = await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex", "claude-code"],
        includeCli: false,
        includeMcp: true,
        cachePath,
      },
      {
        resolveMcpServers: async ({ runtime }) => ({
          warnings: [],
          servers: [
            {
              runtime,
              name: "github",
              scope: "global",
              scopeKey: "user",
              sourcePath: runtime === "codex" ? "/codex.toml" : "/claude.json",
              originKey: runtime,
              command: runtime === "codex" ? "codex-github" : "claude-github",
              args: [],
              env: {},
              headers: {},
              disabledTools: [],
            },
          ],
        }),
        listMcpTools: async () => [{ name: "search_issues", description: "Search issues" }],
        now: () => new Date("2026-09-20T10:00:00.000Z"),
      },
    );

    expect(result.failures).toHaveLength(0);
    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries).toEqual(
      [
        expect.objectContaining({
          runtime: "codex",
          kind: "mcp-tool",
          name: "mcp__github__search_issues",
        }),
      ],
    );
    expect(
      readCapabilityEntries(cachePath, { runtimes: ["claude-code"], workspaceKey }).entries,
    ).toEqual([
      expect.objectContaining({
        runtime: "claude-code",
        kind: "mcp-tool",
        name: "mcp__github__search_issues",
      }),
    ]);
  });

  it("uses Codex tools already listed by its own app-server", async () => {
    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: false,
        includeMcp: true,
        cachePath,
      },
      {
        resolveMcpServers: async () => ({
          warnings: [],
          servers: [
            {
              runtime: "codex",
              name: "codex_apps",
              scope: "project",
              scopeKey: "effective:project",
              sourcePath: "/codex-app-server",
              originKey: "codex-apps",
              args: [],
              env: {},
              headers: {},
              disabledTools: [],
              prelistedTools: [
                { name: "github.search_issues", description: "Search GitHub issues" },
              ],
            },
          ],
        }),
        listMcpTools: async () => {
          throw new Error("direct MCP probing must not run");
        },
      },
    );

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries).toEqual(
      [
        expect.objectContaining({
          kind: "mcp-tool",
          name: "mcp__codex_apps__github.search_issues",
          description: "Search GitHub issues",
        }),
      ],
    );
  });

  it("writes only installed CLI commands already approved by autocomplete discovery", async () => {
    const bin = path.join(root, "bin");
    const executable = path.join(bin, "demo");
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\necho SHOULD_NOT_RUN > side-effect\n", "utf8");
    await chmod(executable, 0o755);

    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: { PATH: bin },
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: false,
        cachePath,
      },
      {
        discoverCli: async () => ({
          warnings: [],
          complete: true,
          commands: [
            {
              name: "demo run",
              commandPath: ["demo", "run"],
              description: "Run a demo",
              executablePath: executable,
              executableRealPath: executable,
              scope: "global",
              manager: "homebrew",
              packageName: "demo",
              version: "1.0.0",
              autocompleteSource: "carapace",
              metadataSource: "carapace",
            },
          ],
        }),
      },
    );

    const entries = readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries;
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "cli-command",
        name: "demo run",
        runtime: "codex",
        details: expect.objectContaining({
          commandPath: ["demo", "run"],
          installManager: "homebrew",
        }),
      }),
    ]);
    await expect(
      import("node:fs/promises").then(({ access }) => access(path.join(projectDir, "side-effect"))),
    ).rejects.toThrow();
  });

  it("stores an executable absolute invocation for project-local CLI commands", async () => {
    const executable = path.join(projectDir, "node_modules", ".bin", "demo tool");
    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: false,
        cachePath,
      },
      {
        discoverCli: async () => ({
          warnings: [],
          complete: true,
          commands: [
            {
              name: "demo run",
              commandPath: ["demo", "run"],
              description: "Run the project demo",
              executablePath: executable,
              executableRealPath: executable,
              scope: "project",
              manager: "pnpm",
              packageName: "demo",
              autocompleteSource: "carapace",
              metadataSource: "carapace",
            },
          ],
        }),
      },
    );

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries).toEqual(
      [
        expect.objectContaining({
          details: expect.objectContaining({ invocationHint: `'${executable}' run` }),
        }),
      ],
    );
  });

  it("keeps a failed CLI refresh stale and unroutable instead of replacing it with a partial list", async () => {
    const options = {
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: true,
      includeMcp: false,
      cachePath,
    };
    const command = {
      name: "demo",
      commandPath: ["demo"],
      description: "Demo",
      executablePath: "/opt/bin/demo",
      executableRealPath: "/opt/bin/demo",
      scope: "global" as const,
      manager: "homebrew" as const,
      packageName: "demo",
      autocompleteSource: "carapace" as const,
      metadataSource: "carapace" as const,
    };
    await refreshCapabilities(options, {
      discoverCli: async () => ({ commands: [command], warnings: [], complete: true }),
    });
    const report = await refreshCapabilities(options, {
      discoverCli: async () => ({
        commands: [],
        warnings: ["carapace timed out"],
        complete: false,
      }),
    });

    expect(loadCapabilityCache(cachePath).cache.partitions["cli:installed:codex"]?.status).toBe(
      "stale",
    );
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toEqual([]);
    expect(report.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ partition: "cli:installed:codex" })]),
    );
  });

  it("checkpoints old partitions as stale before live discovery can fail abruptly", async () => {
    const options = {
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: true,
      includeMcp: false,
      cachePath,
    };
    await refreshCapabilities(options, {
      discoverCli: async () => ({
        warnings: [],
        complete: true,
        commands: [
          {
            name: "demo",
            commandPath: ["demo"],
            description: "Demo",
            executablePath: "/opt/bin/demo",
            executableRealPath: "/opt/bin/demo",
            scope: "global",
            manager: "homebrew",
            packageName: "demo",
            autocompleteSource: "carapace",
            metadataSource: "carapace",
          },
        ],
      }),
    });

    await expect(
      refreshCapabilities(options, {
        discoverCli: async () => {
          throw new Error("abrupt provider failure");
        },
      }),
    ).rejects.toThrow("abrupt provider failure");

    const partition = loadCapabilityCache(cachePath).cache.partitions["cli:installed:codex"];
    expect(partition?.status).toBe("stale");
    expect(partition?.error?.message).toContain("not completed");
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toEqual([]);
  });

  it("updates successful MCP servers while retaining a failed server only as stale", async () => {
    const options = {
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: false,
      includeMcp: true,
      cachePath,
    };
    const server = (name: string, tool: string, error?: string) => ({
      runtime: "codex" as const,
      name,
      scope: "project" as const,
      scopeKey: "effective:test",
      sourcePath: "/codex-app-server",
      originKey: `${name}-origin`,
      args: [],
      env: {},
      headers: {},
      disabledTools: [],
      prelistedTools: [{ name: tool }],
      ...(error === undefined ? {} : { prelistError: error }),
    });
    await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: [],
        authoritative: true,
        servers: [server("good", "old_good"), server("flaky", "old_flaky")],
      }),
    });
    await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: [],
        authoritative: true,
        servers: [server("good", "new_good"), server("flaky", "ignored", "timed out")],
      }),
    });

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    const read = readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey });
    expect(read.entries.map((entry) => entry.name)).toContain("mcp__good__new_good");
    expect(read.entries.map((entry) => entry.name)).not.toContain("mcp__flaky__old_flaky");
    const flaky = Object.values(loadCapabilityCache(cachePath).cache.partitions).find(
      (partition) =>
        partition.entries[0]?.details?.type === "mcp-tool" &&
        partition.entries[0].details.server === "flaky",
    );
    expect(flaky?.status).toBe("stale");
    expect(flaky?.error?.message).toContain("timed out");

    await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: ["inventory incomplete"],
        authoritative: false,
        servers: [server("good", "newer_good")],
      }),
    });
    const afterIncomplete = loadCapabilityCache(cachePath).cache;
    expect(
      Object.values(afterIncomplete.partitions).some(
        (partition) =>
          partition.entries[0]?.details?.type === "mcp-tool" &&
          partition.entries[0].details.server === "flaky",
      ),
    ).toBe(true);

    await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: [],
        authoritative: true,
        servers: [server("good", "newest_good")],
      }),
    });
    const afterAuthoritative = loadCapabilityCache(cachePath).cache;
    expect(
      Object.values(afterAuthoritative.partitions).some(
        (partition) =>
          partition.entries[0]?.details?.type === "mcp-tool" &&
          partition.entries[0].details.server === "flaky",
      ),
    ).toBe(false);
  });

  it("serialises concurrent refreshes so one client cannot erase the other client's partitions", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const discoverCli = async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await release;
      }
      return {
        warnings: [],
        complete: true,
        commands: [
          {
            name: `tool-${calls}`,
            commandPath: [`tool-${calls}`],
            description: `Tool ${calls}`,
            executablePath: `/bin/tool-${calls}`,
            executableRealPath: `/bin/tool-${calls}`,
            scope: "global" as const,
            manager: "homebrew" as const,
            packageName: `tool-${calls}`,
            autocompleteSource: "carapace" as const,
            metadataSource: "carapace" as const,
          },
        ],
      };
    };
    const first = refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: false,
        cachePath,
      },
      { discoverCli },
    );
    await started;
    const second = refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["claude-code"],
        includeCli: true,
        includeMcp: false,
        cachePath,
      },
      { discoverCli },
    );
    setTimeout(releaseFirst, 50);

    await Promise.all([first, second]);

    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toHaveLength(1);
    expect(readCapabilityEntries(cachePath, { runtimes: ["claude-code"] }).entries).toHaveLength(1);
  });

  it("caches only active Claude plugin skills under their exact slash namespace", async () => {
    const pluginRoot = path.join(root, "plugin");
    await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "issue-tools" }),
      "utf8",
    );
    await mkdir(path.join(pluginRoot, "skills", "triage"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage an issue safely\n---\n",
      "utf8",
    );
    await mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "commands", "review.md"),
      "---\ndescription: Review an issue\n---\n",
      "utf8",
    );
    await mkdir(path.join(pluginRoot, "agents"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "agents", "reviewer.md"),
      "---\ndescription: Review issues deeply\n---\n",
      "utf8",
    );

    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["claude-code"],
        includeCli: false,
        includeMcp: true,
        cachePath,
      },
      {
        resolveMcpServers: async () => ({
          warnings: [],
          servers: [],
          claudePlugins: [
            { id: "issue-tools@market", scope: "user", enabled: true, installPath: pluginRoot },
          ],
        }),
      },
    );

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(
      readCapabilityEntries(cachePath, { runtimes: ["claude-code"], workspaceKey }).entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          name: "/issue-tools:triage",
          description: "Triage an issue safely",
        }),
        expect.objectContaining({
          kind: "command",
          name: "/issue-tools:review",
          description: "Review an issue",
        }),
        expect.objectContaining({
          kind: "agent",
          name: "issue-tools:reviewer",
          description: "Review issues deeply",
        }),
      ]),
    );
  });

  it("caches active Codex plugin skills in the client-specific namespace", async () => {
    const pluginRoot = path.join(root, "codex-plugin");
    await mkdir(path.join(pluginRoot, "skills", "triage"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "issue-tools", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage an issue in Codex\n---\n",
      "utf8",
    );

    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: false,
        includeMcp: true,
        cachePath,
      },
      {
        resolveMcpServers: async () => ({
          warnings: [],
          servers: [],
          codexPlugins: [
            {
              id: "issue-tools@personal",
              name: "issue-tools",
              marketplaceName: "personal",
              version: "1.0.0",
              installed: true,
              enabled: true,
              source: "local",
              installPath: pluginRoot,
            },
          ],
        }),
      },
    );

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries).toEqual(
      [expect.objectContaining({ kind: "skill", name: "issue-tools:triage", runtime: "codex" })],
    );
  });

  it("retains the last Codex plugin catalog as stale when inventory is incomplete", async () => {
    const pluginRoot = path.join(root, "codex-plugin-stale");
    await mkdir(path.join(pluginRoot, "skills", "triage"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "issue-tools", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginRoot, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage an issue in Codex\n---\n",
      "utf8",
    );
    const options = {
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: false,
      includeMcp: true,
      cachePath,
    };

    await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: [],
        servers: [],
        codexPlugins: [
          {
            id: "issue-tools@personal",
            name: "issue-tools",
            marketplaceName: "personal",
            version: "1.0.0",
            installed: true,
            enabled: true,
            source: "local",
            installPath: pluginRoot,
          },
        ],
      }),
    });
    const report = await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: ["Codex plugin inventory unavailable"],
        servers: [],
        authoritative: false,
        pluginCatalogAuthoritative: false,
      }),
    });

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries).toEqual(
      [],
    );
    expect(
      loadCapabilityCache(cachePath).cache.partitions[`codex-plugin:effective:${workspaceKey}`]
        ?.status,
    ).toBe("stale");
    expect(report.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtime: "codex", code: "config" })]),
    );
  });

  it("keeps projectless and project-effective plugin inventories isolated", async () => {
    await mkdir(homeDir, { recursive: true });
    const globalRoot = path.join(root, "codex-plugin-global-context");
    const projectRoot = path.join(root, "codex-plugin-project-context");
    for (const [pluginRoot, skillName] of [
      [globalRoot, "global-context"],
      [projectRoot, "project-context"],
    ] as const) {
      await mkdir(path.join(pluginRoot, "skills", skillName), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "plugin.json"),
        JSON.stringify({ name: skillName, version: "1.0.0" }),
      );
      await writeFile(
        path.join(pluginRoot, "skills", skillName, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${skillName}\n---\n`,
      );
    }
    const plugin = (id: string, installPath: string) => ({
      id: `${id}@personal`,
      name: id,
      marketplaceName: "personal",
      version: "1.0.0",
      installed: true,
      enabled: true,
      source: "local" as const,
      installPath,
    });
    const base = {
      homeDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: false,
      includeMcp: true,
      cachePath,
    };

    await refreshCapabilities(
      { ...base, cwd: homeDir },
      {
        resolveMcpServers: async () => ({
          warnings: [],
          servers: [],
          codexPlugins: [plugin("global-context", globalRoot)],
        }),
      },
    );
    await refreshCapabilities(
      { ...base, cwd: projectDir },
      {
        resolveMcpServers: async () => ({
          warnings: [],
          servers: [],
          codexPlugins: [plugin("project-context", projectRoot)],
        }),
      },
    );

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(
      readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries.map((entry) => entry.name),
    ).toEqual(["global-context:global-context"]);
    expect(
      readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries.map(
        (entry) => entry.name,
      ),
    ).toEqual(["project-context:project-context"]);
    expect(
      readCapabilityEntries(cachePath, {
        runtimes: ["codex"],
        workspaceKey: "unrelated-workspace",
      }).entries,
    ).toEqual([]);
  });

  it("publishes a completed CLI partition while a later MCP probe is still running", async () => {
    let releaseMcp: (() => void) | undefined;
    const mcpGate = new Promise<void>((resolve) => {
      releaseMcp = resolve;
    });
    let resolverStarted: (() => void) | undefined;
    const resolverStart = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    const refresh = refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: true,
        includeMcp: true,
        cachePath,
      },
      {
        discoverCli: async () => ({
          complete: true,
          warnings: [],
          commands: [
            {
              name: "demo",
              commandPath: ["demo"],
              description: "Demo",
              executablePath: "/opt/bin/demo",
              executableRealPath: "/opt/bin/demo",
              scope: "global",
              manager: "homebrew",
              packageName: "demo",
              autocompleteSource: "carapace",
              metadataSource: "carapace",
            },
          ],
        }),
        resolveMcpServers: async () => {
          resolverStarted?.();
          await mcpGate;
          return { warnings: [], servers: [] };
        },
      },
    );

    await resolverStart;
    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    const checkpoint = readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey });
    expect(checkpoint.entries.map((entry) => entry.name)).toEqual(["demo"]);
    expect(checkpoint.mcpInventoryRuntimes).toEqual(["codex"]);
    expect(
      loadCapabilityCache(cachePath).cache.partitions[`mcp:codex:inventory:${workspaceKey}`]
        ?.status,
    ).toBe("stale");
    releaseMcp?.();
    await refresh;
  });

  it("checkpoints cached MCP tools as stale before an abrupt resolver failure", async () => {
    const options = {
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: false,
      includeMcp: true,
      cachePath,
    };

    await refreshCapabilities(options, {
      resolveMcpServers: async () => ({
        warnings: [],
        servers: [
          {
            runtime: "codex",
            name: "github",
            scope: "global",
            scopeKey: "user",
            sourcePath: "/codex.toml",
            originKey: "github-v1",
            command: "github-mcp",
            args: [],
            env: {},
            headers: {},
            disabledTools: [],
          },
        ],
      }),
      listMcpTools: async () => [{ name: "search_issues", description: "Search issues" }],
    });

    await expect(
      refreshCapabilities(options, {
        resolveMcpServers: async () => {
          throw new Error("client inventory process crashed");
        },
      }),
    ).rejects.toThrow("client inventory process crashed");

    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"], workspaceKey }).entries).toEqual(
      [],
    );
    expect(
      loadCapabilityCache(cachePath).cache.partitions["mcp:codex:user:github-v1:github"]?.status,
    ).toBe("stale");
  });

  it("does not stale a projectless MCP partition when a project refresh starts", async () => {
    await mkdir(homeDir, { recursive: true });
    const server = {
      runtime: "codex" as const,
      name: "global-only",
      scope: "global" as const,
      scopeKey: "user",
      sourcePath: "/codex.toml",
      originKey: "global-v1",
      command: "global-mcp",
      args: [],
      env: {},
      headers: {},
      disabledTools: [],
    };
    await refreshCapabilities(
      {
        homeDir,
        cwd: homeDir,
        env: {},
        runtimes: ["codex"],
        includeCli: false,
        includeMcp: true,
        cachePath,
      },
      {
        resolveMcpServers: async () => ({ warnings: [], servers: [server] }),
        listMcpTools: async () => [{ name: "search" }],
      },
    );

    await refreshCapabilities(
      {
        homeDir,
        cwd: projectDir,
        env: {},
        runtimes: ["codex"],
        includeCli: false,
        includeMcp: true,
        cachePath,
      },
      { resolveMcpServers: async () => ({ warnings: [], servers: [] }) },
    );

    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toEqual([
      expect.objectContaining({ name: "mcp__global-only__search" }),
    ]);
    expect(
      loadCapabilityCache(cachePath).cache.partitions["mcp:codex:user:global-v1:global-only"]
        ?.status,
    ).toBe("fresh");
  });

  it("hides old capabilities immediately when a queued refresh cannot acquire the lock", async () => {
    const options = {
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"] as const,
      includeCli: true,
      includeMcp: false,
      cachePath,
    };
    const command = {
      name: "demo",
      commandPath: ["demo"],
      description: "Demo",
      executablePath: "/opt/bin/demo",
      executableRealPath: "/opt/bin/demo",
      scope: "global" as const,
      manager: "homebrew" as const,
      packageName: "demo",
      autocompleteSource: "carapace" as const,
      metadataSource: "carapace" as const,
    };
    await refreshCapabilities(options, {
      discoverCli: async () => ({ commands: [command], warnings: [], complete: true }),
    });
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toHaveLength(1);

    await writeFile(
      `${cachePath}.lock`,
      `${JSON.stringify({ token: "held", pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await expect(
      refreshCapabilities(
        { ...options, lockWaitMs: 0 },
        {
          discoverCli: async () => ({ commands: [command], warnings: [], complete: true }),
        },
      ),
    ).rejects.toThrow(/cache is busy/);
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toEqual([]);
    await rm(`${cachePath}.lock`, { force: true });

    await refreshCapabilities(options, {
      discoverCli: async () => ({ commands: [command], warnings: [], complete: true }),
    });
    expect(readCapabilityEntries(cachePath, { runtimes: ["codex"] }).entries).toHaveLength(1);
  });
});
