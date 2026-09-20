import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listClaudeRuntimeTools,
  parseClaudeRuntimeInit,
  runClaudeRuntimeInventory,
  warmClaudeMcpConnections,
} from "./claude-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseClaudeRuntimeInit", () => {
  it("completes the bounded MCP warm-up before capturing the runtime inventory", async () => {
    const order: string[] = [];
    const result = await listClaudeRuntimeTools(
      { env: {} },
      {
        resolveExecutable: async () => "/trusted/claude",
        warmup: async () => {
          order.push("warmup");
          return [];
        },
        inventory: async () => {
          order.push("inventory");
          return { servers: [], warnings: [], complete: true };
        },
      },
    );

    expect(order).toEqual(["warmup", "inventory"]);
    expect(result.complete).toBe(true);
  });

  it("keeps an otherwise empty runtime snapshot non-authoritative when warm-up fails", async () => {
    const result = await listClaudeRuntimeTools(
      { env: {} },
      {
        resolveExecutable: async () => "/trusted/claude",
        warmup: async () => ["Claude MCP warm-up timed out after 100ms"],
        inventory: async () => ({ servers: [], warnings: [], complete: true }),
      },
    );

    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("Claude MCP warm-up timed out after 100ms");
  });

  it("runs the production warm-up as nested `claude mcp list`", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skillful-claude-warmup-args-"));
    roots.push(root);
    const executable = path.join(root, "fake-claude");
    const observed = path.join(root, "observed.json");
    await writeFile(
      executable,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args: process.argv.slice(2), nested: process.env.SKILLFUL_DISCOVERY_NESTED }));\n`,
      "utf8",
    );
    await chmod(executable, 0o755);

    expect(
      await warmClaudeMcpConnections(executable, {
        env: { PATH: "/usr/bin:/bin" },
        warmupTimeoutMs: 2_000,
      }),
    ).toEqual([]);
    expect(JSON.parse(await readFile(observed, "utf8"))).toEqual({
      args: ["mcp", "list"],
      nested: "1",
    });
  });

  it("terminates a stuck MCP warm-up at its independent deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skillful-claude-warmup-"));
    roots.push(root);
    const executable = path.join(root, "fake-claude");
    await writeFile(executable, "#!/bin/sh\n/bin/sleep 30\n", "utf8");
    await chmod(executable, 0o755);

    const warnings = await warmClaudeMcpConnections(executable, {
      env: { PATH: "/usr/bin:/bin" },
      warmupTimeoutMs: 100,
    });

    expect(warnings).toEqual(["Claude MCP warm-up timed out after 100ms"]);
  });

  it("maps exact effective Claude tool names to connected client servers", () => {
    const result = parseClaudeRuntimeInit({
      type: "system",
      subtype: "init",
      tools: [
        "Read",
        "mcp__claude_ai_Gmail__search_threads",
        "mcp__plugin_design_figma__get_design_context",
        "mcp__qmd__query",
      ],
      mcp_servers: [
        { name: "claude.ai Gmail", status: "connected", source: "claudeai" },
        { name: "plugin:design:figma", status: "connected", source: "plugin" },
        { name: "qmd", status: "pending", source: "user" },
        { name: "github", status: "needs-auth", source: "user" },
      ],
    });

    expect(result.complete).toBe(true);
    expect(result.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "claude.ai Gmail",
          toolPrefix: "mcp__claude_ai_Gmail__",
          tools: [{ name: "search_threads" }],
          toolsError: null,
        }),
        expect.objectContaining({
          name: "github",
          tools: [],
          toolsError: "Claude MCP status: needs-auth",
        }),
        expect.objectContaining({ name: "qmd", tools: [{ name: "query" }], toolsError: null }),
      ]),
    );
  });

  it("fails closed when an exact MCP tool cannot be attributed", () => {
    const result = parseClaudeRuntimeInit({
      type: "system",
      subtype: "init",
      tools: ["mcp__unmapped__search"],
      mcp_servers: [{ name: "qmd", status: "connected", source: "user" }],
    });

    expect(result.complete).toBe(false);
    expect(result.warnings[0]).toContain("could not be matched");
  });

  it("streams init from the real child boundary, disables hooks, and terminates immediately", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skillful-claude-runtime-"));
    roots.push(root);
    const executable = path.join(root, "fake-claude");
    const observed = path.join(root, "observed.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const observed = ${JSON.stringify(observed)};
fs.appendFileSync(observed, JSON.stringify({ args: process.argv.slice(2), nested: process.env.SKILLFUL_DISCOVERY_NESTED }) + "\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(observed, JSON.stringify({ terminated: true }) + "\\n");
  process.exit(0);
});
const init = JSON.stringify({ type: "system", subtype: "init", tools: ["Read", "mcp__qmd__query"], mcp_servers: [{ name: "qmd", status: "connected", source: "user" }] }) + "\\n";
process.stdout.write(init.slice(0, 17));
setTimeout(() => process.stdout.write(init.slice(17)), 10);
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(executable, 0o755);

    const inventory = await runClaudeRuntimeInventory(executable, {
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 2_000,
    });
    expect(inventory.servers[0]).toEqual(
      expect.objectContaining({ name: "qmd", tools: [{ name: "query" }] }),
    );

    let records: Array<{ args?: string[]; nested?: string; terminated?: boolean }> = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      records = (await readFile(observed, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (records.some((record) => record.terminated === true)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(records[0]?.nested).toBe("1");
    expect(records[0]?.args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "--settings",
        '{"disableAllHooks":true}',
      ]),
    );
    expect(records.some((record) => record.terminated === true)).toBe(true);
  });
});
