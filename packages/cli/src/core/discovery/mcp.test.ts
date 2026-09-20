import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudePluginList } from "./claude-plugins.js";
import {
  type ClaudePluginInstall,
  canonicalMcpToolName,
  collectMcpTools,
  resolveMcpServers,
} from "./mcp.js";

let root: string;
let homeDir: string;
let projectDir: string;

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skillful-mcp-discovery-"));
  homeDir = path.join(root, "home");
  projectDir = path.join(root, "project");
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runtime-specific MCP configuration", () => {
  it("fails closed when Claude reports a malformed installed plugin", () => {
    expect(() =>
      parseClaudePluginList(
        JSON.stringify([{ id: "broken", enabled: true, installPath: "/plugin" }]),
      ),
    ).toThrow(/missing required fields/);
  });

  it("never merges same-named Codex and Claude servers", async () => {
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      `[mcp_servers.github]\ncommand = "codex-github"\nenabled_tools = ["search", "get"]\ndisabled_tools = ["get"]\n`,
    );
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "claude-github" } } }),
    );

    const codex = await resolveMcpServers({ runtime: "codex", homeDir, projectDir, env: {} });
    const claude = await resolveMcpServers({
      runtime: "claude-code",
      homeDir,
      projectDir,
      env: {},
    });

    expect(codex.servers).toEqual([
      expect.objectContaining({
        runtime: "codex",
        name: "github",
        command: "codex-github",
        enabledTools: ["search"],
        scope: "project",
      }),
    ]);
    expect(claude.servers).toEqual([
      expect.objectContaining({
        runtime: "claude-code",
        name: "github",
        command: "claude-github",
        scope: "project",
      }),
    ]);
  });

  it("lets project Codex config override the user definition within Codex only", async () => {
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      `[mcp_servers.db]\ncommand = "global-db"\n`,
    );
    await write(
      path.join(projectDir, ".codex", "config.toml"),
      `[mcp_servers.db]\ncommand = "project-db"\n`,
    );

    const result = await resolveMcpServers({ runtime: "codex", homeDir, projectDir, env: {} });
    expect(result.servers).toEqual([
      expect.objectContaining({ name: "db", command: "project-db", scope: "project" }),
    ]);
  });

  it("uses Codex's effective MCP inventory and excludes disabled servers", async () => {
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      `[mcp_servers.stale]\ncommand = "must-not-load"\n`,
    );

    const result = await resolveMcpServers(
      { runtime: "codex", homeDir, projectDir, env: { TOKEN: "secret" } },
      {
        listCodexMcpServers: async () => ({
          complete: true,
          warnings: [],
          servers: [
            {
              name: "effective",
              enabled: true,
              transport: {
                type: "stdio",
                command: "effective-server",
                args: ["--stdio"],
                env: { TOKEN: "secret" },
                cwd: projectDir,
              },
            },
            {
              name: "disabled",
              enabled: false,
              transport: { type: "stdio", command: "disabled-server", args: [] },
            },
          ],
        }),
        listCodexPlugins: async () => [],
      },
    );

    expect(result.servers).toEqual([
      expect.objectContaining({
        runtime: "codex",
        name: "effective",
        command: "effective-server",
        args: ["--stdio"],
        env: { TOKEN: "secret" },
        scope: "project",
      }),
    ]);
    expect(result.servers.some((server) => server.name === "stale")).toBe(false);
    expect(result.authoritative).toBe(false);
  });

  it("prefers Codex app-server's effective tool catalog over transport probing", async () => {
    const result = await resolveMcpServers(
      { runtime: "codex", homeDir, projectDir, env: {} },
      {
        listCodexRuntimeTools: async () => ({
          complete: true,
          warnings: [],
          servers: [
            {
              name: "codex_apps",
              pluginId: null,
              tools: [{ name: "github.search_issues", description: "Search GitHub issues" }],
              toolsError: null,
            },
          ],
        }),
        listCodexPlugins: async () => [],
        listCodexMcpServers: async () => {
          throw new Error("transport fallback must not run");
        },
      },
    );

    expect(result.servers).toEqual([
      expect.objectContaining({
        runtime: "codex",
        name: "codex_apps",
        scope: "project",
        prelistedTools: [{ name: "github.search_issues", description: "Search GitHub issues" }],
      }),
    ]);
    expect(canonicalMcpToolName(result.servers[0]!, "github.search_issues")).toBe(
      "mcp__codex_apps__github.search_issues",
    );
  });

  it("prefers Claude's own effective client inventory, including managed OAuth connectors", async () => {
    const result = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir, env: {} },
      {
        listClaudePlugins: async () => [],
        listClaudeRuntimeTools: async () => ({
          complete: true,
          warnings: [],
          servers: [
            {
              name: "claude.ai Gmail",
              source: "claudeai",
              status: "connected",
              toolPrefix: "mcp__claude_ai_Gmail__",
              tools: [{ name: "search_threads" }],
              toolsError: null,
            },
          ],
        }),
      },
    );

    expect(result.authoritative).toBe(true);
    expect(result.servers).toEqual([
      expect.objectContaining({
        name: "claude.ai Gmail",
        toolPrefix: "mcp__claude_ai_Gmail__",
        prelistedTools: [{ name: "search_threads" }],
      }),
    ]);
    expect(canonicalMcpToolName(result.servers[0]!, "search_threads")).toBe(
      "mcp__claude_ai_Gmail__search_threads",
    );
  });

  it("keeps connected managed tools but probes client-specific config when init is still pending", async () => {
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { pending: { command: "pending-server" } } }),
    );
    const result = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir: null, env: {} },
      {
        listClaudePlugins: async () => [],
        listClaudeRuntimeTools: async () => ({
          complete: true,
          warnings: [],
          servers: [
            {
              name: "claude.ai Gmail",
              source: "claudeai",
              status: "connected",
              toolPrefix: "mcp__claude_ai_Gmail__",
              tools: [{ name: "search_threads" }],
              toolsError: null,
            },
            {
              name: "pending",
              source: "user",
              status: "pending",
              toolPrefix: "mcp__pending__",
              tools: [],
              toolsError: "Claude MCP status: pending",
            },
          ],
        }),
      },
    );

    expect(result.authoritative).toBe(false);
    expect(result.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "claude.ai Gmail",
          prelistedTools: [{ name: "search_threads" }],
        }),
        expect.objectContaining({ name: "pending", command: "pending-server" }),
      ]),
    );
  });

  it("forwards only declared local env_vars and resolves env-backed HTTP headers", async () => {
    await write(
      path.join(homeDir, ".codex", "config.toml"),
      [
        "[mcp_servers.local]",
        'command = "local-mcp"',
        'env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]',
        "",
        "[mcp_servers.remote]",
        'url = "https://example.test/mcp"',
        'bearer_token_env_var = "BEARER"',
        'env_http_headers = { "X-Extra" = "EXTRA" }',
      ].join("\n"),
    );

    const result = await resolveMcpServers({
      runtime: "codex",
      homeDir,
      projectDir,
      env: {
        LOCAL_TOKEN: "local",
        REMOTE_TOKEN: "remote",
        BEARER: "secret",
        EXTRA: "value",
        UNDECLARED: "no",
      },
    });

    expect(result.servers.find((server) => server.name === "local")?.env).toEqual({
      LOCAL_TOKEN: "local",
    });
    expect(result.servers.find((server) => server.name === "remote")?.headers).toEqual({
      Authorization: "Bearer secret",
      "X-Extra": "value",
    });
  });

  it("uses CLAUDE_CONFIG_DIR and only loads active Claude plugin MCP servers in scope", async () => {
    const configDir = path.join(root, "claude-config");
    const userPlugin = path.join(root, "plugins", "user");
    const projectPlugin = path.join(root, "plugins", "project");
    const otherProjectPlugin = path.join(root, "plugins", "other-project");
    const disabledPlugin = path.join(root, "plugins", "disabled");
    await write(
      path.join(configDir, "mcp.json"),
      JSON.stringify({ mcpServers: { configured: { command: "configured-server" } } }),
    );
    await write(
      path.join(userPlugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "user-tools", mcpServers: "./.mcp.json" }),
    );
    await write(
      path.join(userPlugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          search: {
            command: "${CLAUDE_PLUGIN_ROOT}/server",
            args: ["--project", "${CLAUDE_PROJECT_DIR}"],
            env: { DATA: "${CLAUDE_PLUGIN_DATA}" },
          },
        },
      }),
    );
    await write(
      path.join(projectPlugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "project-tools",
        mcpServers: { tickets: { url: "https://example.test/mcp" } },
      }),
    );
    for (const pluginRoot of [otherProjectPlugin, disabledPlugin]) {
      await write(
        path.join(pluginRoot, ".mcp.json"),
        JSON.stringify({ mcpServers: { forbidden: { command: "must-not-load" } } }),
      );
    }
    const installs: ClaudePluginInstall[] = [
      { id: "user-tools@market", scope: "user", enabled: true, installPath: userPlugin },
      {
        id: "project-tools@market",
        scope: "project",
        enabled: true,
        installPath: projectPlugin,
        projectPath: projectDir,
      },
      {
        id: "other@market",
        scope: "project",
        enabled: true,
        installPath: otherProjectPlugin,
        projectPath: path.join(root, "other"),
      },
      { id: "disabled@market", scope: "user", enabled: false, installPath: disabledPlugin },
    ];

    const result = await resolveMcpServers(
      {
        runtime: "claude-code",
        homeDir,
        projectDir,
        env: { CLAUDE_CONFIG_DIR: configDir, PWD: projectDir },
      },
      { listClaudePlugins: async () => installs },
    );

    expect(result.servers.map((server) => server.name)).toEqual([
      "configured",
      "plugin:project-tools:tickets",
      "plugin:user-tools:search",
    ]);
    const user = result.servers.find((server) => server.name === "plugin:user-tools:search");
    expect(user).toEqual(
      expect.objectContaining({
        command: path.join(userPlugin, "server"),
        args: ["--project", projectDir],
        env: { DATA: path.join(configDir, "plugins", "data", "user-tools-market") },
        scope: "project",
      }),
    );
    expect(canonicalMcpToolName(user!, "lookup")).toBe("mcp__plugin_user-tools_search__lookup");
    expect(result.servers.some((server) => server.command === "must-not-load")).toBe(false);
  });

  it("marks a plugin MCP file with a non-object JSON root non-authoritative", async () => {
    const pluginRoot = path.join(root, "plugins", "malformed");
    await write(path.join(pluginRoot, ".mcp.json"), "[]\n");

    const result = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir, env: {} },
      {
        listClaudePlugins: async () => [
          { id: "malformed@market", scope: "user", enabled: true, installPath: pluginRoot },
        ],
      },
    );

    expect(result.authoritative).toBe(false);
    expect(result.warnings.join("\n")).toContain("expected a JSON object at the document root");
  });

  it("loads Claude state from CLAUDE_CONFIG_DIR instead of the legacy home path", async () => {
    const configDir = path.join(root, "custom-claude");
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { legacy: { command: "must-not-load" } } }),
    );
    await write(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { active: { command: "active-server" } } }),
    );

    const result = await resolveMcpServers(
      {
        runtime: "claude-code",
        homeDir,
        projectDir: null,
        env: { CLAUDE_CONFIG_DIR: configDir },
      },
      { listClaudePlugins: async () => [] },
    );

    expect(result.servers.map((server) => server.name)).toEqual(["active"]);
    expect(result.servers[0]?.sourcePath).toBe(path.join(configDir, ".claude.json"));
  });

  it("expands Claude variables and preserves explicit SSE transport", async () => {
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "sse",
            url: "${BASE_URL:-https://example.test}/sse",
            cwd: "${PROJECT_DIR}",
            args: ["--tenant", "${TENANT:-default}"],
            env: { TOKEN: "${TOKEN}" },
            headers: { "X-Tenant": "${TENANT:-default}" },
          },
        },
      }),
    );

    const result = await resolveMcpServers(
      {
        runtime: "claude-code",
        homeDir,
        projectDir: null,
        env: { PROJECT_DIR: projectDir, TOKEN: "secret" },
      },
      { listClaudePlugins: async () => [] },
    );

    expect(result.servers[0]).toEqual(
      expect.objectContaining({
        transport: "sse",
        url: "https://example.test/sse",
        cwd: projectDir,
        args: ["--tenant", "default"],
        env: { TOKEN: "secret" },
        headers: { "X-Tenant": "default" },
      }),
    );
  });

  it("applies disabledMcpjsonServers only to the project file, not a local override", async () => {
    await write(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "project-file-server" } } }),
    );
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { shared: { command: "global-server" } },
        projects: {
          [projectDir]: {
            enabledMcpjsonServers: ["shared"],
            disabledMcpjsonServers: ["shared"],
            mcpServers: { shared: { command: "local-server" } },
          },
        },
      }),
    );

    const result = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir, env: {} },
      { listClaudePlugins: async () => [] },
    );
    expect(result.servers).toEqual([
      expect.objectContaining({ name: "shared", command: "local-server" }),
    ]);
  });

  it("never starts project .mcp.json servers until Claude has approved them", async () => {
    await write(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { pending: { command: "untrusted-project-server" } } }),
    );
    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ projects: { [projectDir]: { enabledMcpjsonServers: [] } } }),
    );

    const pending = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir, env: {} },
      { listClaudePlugins: async () => [] },
    );
    expect(pending.servers).toEqual([]);

    await write(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ projects: { [projectDir]: { enabledMcpjsonServers: ["pending"] } } }),
    );
    const approved = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir, env: {} },
      { listClaudePlugins: async () => [] },
    );
    expect(approved.servers).toEqual([
      expect.objectContaining({ name: "pending", command: "untrusted-project-server" }),
    ]);
  });

  it("marks an unreadable Claude state inventory non-authoritative", async () => {
    await write(path.join(homeDir, ".claude.json"), "{not-json");
    const result = await resolveMcpServers(
      { runtime: "claude-code", homeDir, projectDir: null, env: {} },
      { listClaudePlugins: async () => [] },
    );
    expect(result.authoritative).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/invalid JSON/);
  });
});

describe("MCP pagination", () => {
  it("handles an empty-string cursor and returns the complete bounded list", async () => {
    const seen: Array<string | undefined> = [];
    const tools = await collectMcpTools(async (cursor) => {
      seen.push(cursor);
      if (cursor === undefined) {
        return { tools: [{ name: "one", description: "first", inputSchema: {} }], nextCursor: "" };
      }
      return { tools: [{ name: "two", description: "second", inputSchema: {} }] };
    });
    expect(seen).toEqual([undefined, ""]);
    expect(tools.map((tool) => tool.name)).toEqual(["one", "two"]);
  });

  it("rejects cursor cycles instead of looping forever", async () => {
    await expect(
      collectMcpTools(async () => ({ tools: [], nextCursor: "again" }), { maxPages: 5 }),
    ).rejects.toThrow(/cursor cycle/i);
  });
});
