import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMcpToolsFromServer } from "./mcp-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("listMcpToolsFromServer", () => {
  it("treats an empty opaque cursor as a real second page cursor", async () => {
    const tempRoot = path.join(process.cwd(), "tmp");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(path.join(tempRoot, "skillful-mcp-empty-cursor-"));
    roots.push(root);
    const serverPath = path.join(root, "fake-mcp-empty-cursor");
    const observed = path.join(root, "observed.jsonl");
    await writeFile(
      serverPath,
      `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const out = ${JSON.stringify(observed)};
let page = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "empty-cursor", version: "1.0.0" } } }) + "\\n");
  } else if (message.method === "tools/list") {
    fs.appendFileSync(out, JSON.stringify(message.params ?? {}) + "\\n");
    page += 1;
    const result = page === 1
      ? { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "" }
      : { tools: [{ name: "second", inputSchema: { type: "object" } }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
      "utf8",
    );
    await chmod(serverPath, 0o755);

    const tools = await listMcpToolsFromServer(
      {
        runtime: "claude-code",
        name: "empty-cursor",
        scope: "global",
        scopeKey: "user",
        sourcePath: "/config",
        originKey: "empty-cursor-origin",
        command: serverPath,
        args: [],
        env: {},
        headers: {},
        disabledTools: [],
      },
      { timeoutMs: 5_000 },
    );

    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    const pages = (await readFile(observed, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { cursor?: string });
    expect(pages).toEqual([{}, { cursor: "" }]);
  });

  it("negotiates with a real stdio server and lists definitions without calling a tool", async () => {
    const tempRoot = path.join(process.cwd(), "tmp");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(path.join(tempRoot, "skillful-mcp-client-"));
    roots.push(root);
    const serverPath = path.join(root, "fake-mcp");
    const observed = path.join(root, "observed.jsonl");
    await writeFile(
      serverPath,
      `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const out = ${JSON.stringify(observed)};
let page = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(out, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } } }) + "\\n");
  } else if (message.method === "tools/list") {
    page += 1;
    const result = page === 1
      ? { tools: [{ name: "search", title: "Search", description: "Search safely", inputSchema: { type: "object" } }], nextCursor: "page-2" }
      : { tools: [{ name: "get", description: "Get safely", inputSchema: { type: "object" } }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  } else if (message.id !== undefined && message.method !== "notifications/initialized") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
  }
});
`,
      "utf8",
    );
    await chmod(serverPath, 0o755);

    const tools = await listMcpToolsFromServer(
      {
        runtime: "claude-code",
        name: "fake",
        scope: "global",
        scopeKey: "user",
        sourcePath: "/config",
        originKey: "fake-origin",
        command: serverPath,
        args: [],
        env: {},
        headers: {},
        disabledTools: [],
      },
      { timeoutMs: 5_000 },
    );

    expect(tools).toEqual([
      {
        name: "search",
        title: "Search",
        description: "Search safely",
        inputSchema: { type: "object" },
      },
      {
        name: "get",
        description: "Get safely",
        inputSchema: { type: "object" },
      },
    ]);
    const messages = (await readFile(observed, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    expect(messages.filter((message) => message.method === "tools/list")).toHaveLength(2);
    expect(messages.map((message) => message.method)).not.toContain("tools/call");
  });

  it("rejects a cyclic cursor from the real SDK transport instead of returning a partial list", async () => {
    const tempRoot = path.join(process.cwd(), "tmp");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(path.join(tempRoot, "skillful-mcp-cycle-"));
    roots.push(root);
    const serverPath = path.join(root, "fake-mcp-cycle");
    await writeFile(
      serverPath,
      `#!${process.execPath}
import readline from "node:readline";
let page = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cycle", version: "1.0.0" } } }) + "\\n");
  } else if (message.method === "tools/list") {
    page += 1;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "tool-" + page, inputSchema: { type: "object" } }], nextCursor: "cycle" } }) + "\\n");
  }
});
`,
      "utf8",
    );
    await chmod(serverPath, 0o755);

    await expect(
      listMcpToolsFromServer(
        {
          runtime: "claude-code",
          name: "cycle",
          scope: "global",
          scopeKey: "user",
          sourcePath: "/config",
          originKey: "cycle-origin",
          command: serverPath,
          args: [],
          env: {},
          headers: {},
          disabledTools: [],
        },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/cursor cycle/);
  });
});
