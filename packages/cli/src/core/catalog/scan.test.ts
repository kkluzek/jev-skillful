import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyCapabilityCache,
  saveCapabilityCache,
  updateCapabilityPartition,
} from "../discovery/cache.js";
import { scanCatalog } from "./scan.js";

/**
 * The scanner is validated against a synthetic home tree rather than the real
 * one, so the assertions are about the code rather than about whatever happens to
 * be installed on the machine running the tests.
 */

let root: string;
let homeDir: string;
let projectDir: string;

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

async function skill(dir: string, name: string, description: string): Promise<void> {
  await write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skillful-scan-"));
  homeDir = path.join(root, "home");
  projectDir = path.join(root, "project");
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanCatalog", () => {
  it("finds skills, agents and commands from Claude Code surfaces", async () => {
    await skill(path.join(homeDir, ".claude", "skills", "ak-demo"), "ak-demo", "a demo skill");
    await write(
      path.join(homeDir, ".claude", "agents", "debugger.md"),
      "---\nname: debugger\ndescription: debug things\n---\n",
    );
    await write(
      path.join(homeDir, ".claude", "commands", "fix.md"),
      "---\ndescription: Repair a bug\n---\n# fix\n",
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });

    expect(catalog.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(
      expect.arrayContaining(["skill:ak-demo", "agent:debugger", "command:/fix"]),
    );
    expect(catalog.entries.find((entry) => entry.name === "/fix")?.description).toBe(
      "Repair a bug",
    );
    const demo = catalog.entries.find((e) => e.name === "ak-demo");
    expect(demo?.description).toBe("a demo skill");
    expect(demo?.scope).toBe("global");
    expect(demo?.degraded).toBeUndefined();
  });

  it("uses CLAUDE_CONFIG_DIR for Claude's global skills, commands, and MCP adapter config", async () => {
    const configDir = path.join(root, "claude-config");
    await skill(path.join(configDir, "skills", "custom-root"), "custom-root", "custom skill");
    await write(
      path.join(configDir, "commands", "inspect.md"),
      "---\ndescription: Inspect from the custom root\n---\n",
    );
    await write(
      path.join(configDir, "mcp.json"),
      JSON.stringify({ mcpServers: { custom: { command: "custom-server" } } }),
    );
    await skill(path.join(homeDir, ".claude", "skills", "wrong-root"), "wrong-root", "wrong");

    const catalog = await scanCatalog({
      homeDir,
      cwd: projectDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      runtimes: ["claude-code"],
    });

    expect(catalog.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(
      expect.arrayContaining(["skill:custom-root", "command:/inspect", "mcp:custom"]),
    );
    expect(catalog.entries.some((entry) => entry.name === "wrong-root")).toBe(false);
  });

  it("does not treat disabled or orphaned Claude plugin cache entries as active skills", async () => {
    const configDir = path.join(root, "claude-config");
    await skill(
      path.join(configDir, "plugins", "disabled", "skills", "unsafe"),
      "unsafe",
      "must not be suggested",
    );

    const catalog = await scanCatalog({
      homeDir,
      cwd: projectDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      runtimes: ["claude-code"],
      includeCachedCapabilities: false,
    });

    expect(catalog.entries.some((entry) => entry.name.includes("unsafe"))).toBe(false);
  });

  it("keeps every MCP server that shares one config file", async () => {
    // Regression: an earlier dedupe key omitted the item name, so two servers
    // declared in the same file collapsed into one.
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          alpha: { type: "http", url: "https://alpha.example/mcp" },
          beta: { type: "http", url: "https://beta.example/mcp" },
        },
      }),
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    const servers = catalog.entries.filter((e) => e.kind === "mcp" && e.runtime === "claude-code");

    expect(servers.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(servers[0]?.description).toContain("MCP server");
  });

  it("keeps every MCP server declared in one Codex config.toml", async () => {
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      [
        "[mcp_servers]",
        "",
        "[mcp_servers.one]",
        'url = "https://one.example"',
        "",
        "[mcp_servers.two]",
        'command = "two"',
      ].join("\n"),
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    const servers = catalog.entries.filter((e) => e.kind === "mcp" && e.runtime === "codex");

    expect(servers.map((s) => s.name).sort()).toEqual(["one", "two"]);
  });

  it("discovers Codex custom prompts under their exact slash invocation", async () => {
    await write(
      path.join(homeDir, ".codex", "prompts", "deploy.md"),
      "---\ndescription: Prepare a safe deployment\n---\nDeploy carefully.\n",
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {}, runtimes: ["codex"] });
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "command",
          name: "/prompts:deploy",
          description: "Prepare a safe deployment",
          runtime: "codex",
          scope: "global",
        }),
      ]),
    );
  });

  it("finds Pi skills and reads Pi MCP config from the adapter's locations", async () => {
    await skill(path.join(homeDir, ".pi", "agent", "skills", "pi-demo"), "pi-demo", "pi skill");
    await write(
      path.join(homeDir, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { piserver: { command: "run-pi" } } }),
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    expect(catalog.entries.some((e) => e.name === "pi-demo")).toBe(true);
    expect(catalog.entries.some((e) => e.name === "piserver")).toBe(true);
  });

  it("reads Oh My Pi managed skills and MCP servers", async () => {
    await skill(
      path.join(homeDir, ".omp", "agent", "managed-skills", "omp-demo"),
      "omp-demo",
      "omp skill",
    );
    await write(
      path.join(homeDir, ".omp", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { ompserver: { url: "https://omp.example" } } }),
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    expect(catalog.entries.some((e) => e.name === "omp-demo")).toBe(true);
    expect(catalog.entries.some((e) => e.name === "ompserver")).toBe(true);
  });

  it("separates project-scoped surfaces from global ones", async () => {
    await write(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "x" } } }),
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    const local = catalog.entries.find((e) => e.name === "local");

    expect(local?.scope).toBe("project");
    expect(local?.id).toContain(":project:");
  });

  it("marks an entry with unreadable metadata as degraded", async () => {
    await write(
      path.join(homeDir, ".claude", "skills", "broken", "SKILL.md"),
      "# no frontmatter\n",
    );

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    const broken = catalog.entries.find((e) => e.name === "broken");

    expect(broken).toBeDefined();
    expect(broken?.degraded).toBe(true);
  });

  it("produces a stable fingerprint for the same tree", async () => {
    await skill(path.join(homeDir, ".claude", "skills", "stable"), "stable", "unchanged");
    const first = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    const second = await scanCatalog({ homeDir, cwd: projectDir, env: {} });

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("changes the fingerprint when a skill is added", async () => {
    await skill(path.join(homeDir, ".claude", "skills", "one"), "one", "first");
    const before = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    await skill(path.join(homeDir, ".claude", "skills", "two"), "two", "second");
    const after = await scanCatalog({ homeDir, cwd: projectDir, env: {} });

    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it("returns an empty catalog for an empty home without throwing", async () => {
    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {} });
    expect(catalog.entries).toEqual([]);
    expect(catalog.warnings).toEqual([]);
    expect(catalog.fingerprint).toMatch(/^sha256:/);
  });

  it("honours the Codex skills-root override and does not double count", async () => {
    const shared = path.join(root, "shared-skills");
    await skill(path.join(shared, "shared"), "shared", "shared skill");

    const catalog = await scanCatalog({
      homeDir,
      cwd: projectDir,
      env: { AGENTKIT_CODEX_SKILLS_ROOT: shared },
    });
    const shared_ = catalog.entries.filter((e) => e.name === "shared");

    expect(shared_).toHaveLength(1);
  });

  it("can restrict the scan to selected runtimes", async () => {
    await skill(path.join(homeDir, ".claude", "skills", "claude-only"), "claude-only", "c");
    await skill(path.join(homeDir, ".pi", "agent", "skills", "pi-only"), "pi-only", "p");

    const catalog = await scanCatalog({ homeDir, cwd: projectDir, env: {}, runtimes: ["pi"] });
    expect(catalog.entries.some((e) => e.name === "pi-only")).toBe(true);
    expect(catalog.entries.some((e) => e.name === "claude-only")).toBe(false);
  });

  it("merges only the active runtime's cached MCP tools and hides its coarse server fallback", async () => {
    const cachePath = path.join(root, "capabilities.json");
    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      `[mcp_servers.github]\ncommand = "codex-github"\n`,
    );
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "claude-github" } } }),
    );
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    for (const runtime of ["codex", "claude-code"] as const) {
      updateCapabilityPartition(cache, {
        key: `mcp:${runtime}:user:github`,
        runtime,
        source: "mcp",
        workspaceKey,
        status: "fresh",
        refreshedAt: "2026-09-20T10:00:00.000Z",
        entries: [
          {
            id: `${runtime}:mcp-tool:global:github/search`,
            kind: "mcp-tool",
            name: "github/search",
            description: "Search GitHub",
            runtime,
            scope: "global",
            sourcePath: runtime === "codex" ? "/codex" : "/claude",
            details: {
              type: "mcp-tool",
              client: runtime,
              server: "github",
              tool: "search",
              scopeKey: "user",
              configOrigin: runtime,
              canonicalName: "github/search",
              availability: "available",
              observedAt: "2026-09-20T10:00:00.000Z",
            },
          },
        ],
      });
    }
    saveCapabilityCache(cachePath, cache);

    const catalog = await scanCatalog({
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"],
      capabilityCachePath: cachePath,
    });

    expect(catalog.entries.filter((entry) => entry.kind === "mcp-tool")).toEqual([
      expect.objectContaining({ runtime: "codex", name: "github/search" }),
    ]);
    expect(catalog.entries.some((entry) => entry.kind === "mcp" && entry.name === "github")).toBe(
      false,
    );
  });

  it("does not expose coarse MCP fallbacks when the runtime inventory is empty or failed", async () => {
    const cachePath = path.join(root, "empty-capabilities.json");
    const workspaceKey = createHash("sha256")
      .update(path.resolve(projectDir))
      .digest("hex")
      .slice(0, 16);
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      `[mcp_servers.off]\ncommand = "off"\nenabled = false\n[mcp_servers.unknown]\ncommand = "unknown"\n`,
    );
    const cache = emptyCapabilityCache("2026-09-20T10:00:00.000Z");
    updateCapabilityPartition(cache, {
      key: "mcp:codex:inventory",
      runtime: "codex",
      source: "mcp",
      workspaceKey,
      status: "failed",
      refreshedAt: "2026-09-20T10:00:00.000Z",
      entries: [],
      error: { code: "config", message: "incomplete", at: "2026-09-20T10:00:00.000Z" },
    });
    saveCapabilityCache(cachePath, cache);

    const catalog = await scanCatalog({
      homeDir,
      cwd: projectDir,
      env: {},
      runtimes: ["codex"],
      capabilityCachePath: cachePath,
    });
    expect(catalog.entries.filter((entry) => entry.kind === "mcp")).toEqual([]);
  });
});
