import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexRuntimeTools, parseCodexMcpStatusPage } from "./codex-app-server.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex app-server MCP status", () => {
  it("extracts exact tools without retaining schemas", () => {
    const page = parseCodexMcpStatusPage({
      data: [
        {
          name: "codex_apps",
          pluginId: "github@remote",
          tools: {
            "github.search_issues": {
              name: "github.search_issues",
              title: "Search issues",
              description: "Search GitHub issues",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          },
          toolsError: null,
        },
        {
          name: "broken",
          pluginId: null,
          tools: {},
          toolsError: null,
          authStatus: "notLoggedIn",
        },
      ],
      nextCursor: "next-page",
    });

    expect(page).toEqual({
      servers: [
        {
          name: "broken",
          pluginId: null,
          tools: [],
          toolsError: "authentication required",
        },
        {
          name: "codex_apps",
          pluginId: "github@remote",
          tools: [
            {
              name: "github.search_issues",
              title: "Search issues",
              description: "Search GitHub issues",
            },
          ],
          toolsError: null,
        },
      ],
      nextCursor: "next-page",
    });
    expect(JSON.stringify(page)).not.toContain("inputSchema");
  });

  it("rejects malformed pages and tool records instead of treating them as empty", () => {
    expect(() => parseCodexMcpStatusPage({})).toThrow(/data array/);
    expect(() => parseCodexMcpStatusPage({ data: [{ name: "broken", tools: { x: {} } }] })).toThrow(
      /has no name/,
    );
    expect(() => parseCodexMcpStatusPage({ data: [], nextCursor: 42 })).toThrow(/nextCursor/);
    expect(parseCodexMcpStatusPage({ data: [], nextCursor: "" })).toEqual({
      servers: [],
      nextCursor: "",
    });
    expect(() =>
      parseCodexMcpStatusPage({ data: [{ name: "broken", tools: {}, toolsError: {} }] }),
    ).toThrow(/invalid toolsError/);
    expect(() =>
      parseCodexMcpStatusPage({ data: [{ name: "broken", tools: {}, runtimeStatus: 42 }] }),
    ).toThrow(/invalid runtimeStatus/);
  });

  it("uses an ephemeral project thread and paginates the real stdio protocol", async () => {
    const tempRoot = path.join(process.cwd(), "tmp");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(path.join(tempRoot, "skillful-app-server-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    const project = path.join(root, "project");
    const observed = path.join(root, "observed.jsonl");
    const codex = path.join(bin, "codex");
    await mkdir(bin, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      codex,
      `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const out = ${JSON.stringify(observed)};
for (const key of ["SKILLFUL_DISCOVERY_NESTED"]) fs.appendFileSync(out, JSON.stringify({ env: key, value: process.env[key] }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(out, JSON.stringify(message) + "\\n");
  if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: "thread-1" } } }) + "\\n");
  if (message.id === 3) {
    const second = message.params.cursor === "page-2";
    const data = second
      ? [{ name: "second", pluginId: null, tools: { two: { name: "two", description: "Two" } }, toolsError: null }]
      : [{ name: "first", pluginId: null, tools: { one: { name: "one", description: "One" } }, toolsError: null }];
    process.stdout.write(JSON.stringify({ id: 3, result: { data, ...(second ? {} : { nextCursor: "page-2" }) } }) + "\\n");
  }
});
`,
      "utf8",
    );
    await chmod(codex, 0o755);

    const result = await listCodexRuntimeTools({
      env: { PATH: bin },
      cwd: project,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      complete: true,
      warnings: [],
      servers: [
        expect.objectContaining({
          name: "first",
          tools: [expect.objectContaining({ name: "one" })],
        }),
        expect.objectContaining({
          name: "second",
          tools: [expect.objectContaining({ name: "two" })],
        }),
      ],
    });
    const messages = (await readFile(observed, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ env: "SKILLFUL_DISCOVERY_NESTED", value: "1" }),
        expect.objectContaining({
          method: "thread/start",
          params: expect.objectContaining({ cwd: project, ephemeral: true }),
        }),
        expect.objectContaining({
          method: "mcpServerStatus/list",
          params: expect.objectContaining({ threadId: "thread-1", cursor: "page-2" }),
        }),
      ]),
    );
  });
});
