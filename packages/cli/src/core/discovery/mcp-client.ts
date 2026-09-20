import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ListedMcpTool, McpListLimits, ResolvedMcpServer } from "./mcp.js";

export interface McpClientListOptions extends McpListLimits {
  timeoutMs?: number;
}

/**
 * Connect through the official SDK, list definitions, and close without ever calling a tool.
 * Server stderr is discarded so refresh output remains structured and secrets are not echoed.
 */
export async function listMcpToolsFromServer(
  server: ResolvedMcpServer,
  options: McpClientListOptions = {},
): Promise<ListedMcpTool[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPages = options.maxPages ?? 25;
  const maxTools = options.maxTools ?? 2_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const client = new Client(
    { name: "skillful-capability-refresh", version: "1.0.0" },
    {
      listMaxPages: options.maxPages ?? 25,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: Math.min(1_000, timeoutMs) } },
    },
  );
  const transport = transportFor(server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let primaryError: unknown;
  let listedTools: ListedMcpTool[] | undefined;
  try {
    await client.connect(transport, { timeout: timeoutMs, signal: controller.signal });
    // Walk pages explicitly. The SDK's aggregate helper treats a repeated cursor as a normal end
    // condition, which would turn a cyclic server into a fresh but partial capability inventory.
    const tools: ListedMcpTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let pageNumber = 0; ; pageNumber += 1) {
      if (pageNumber >= maxPages) {
        throw new Error(`MCP tools/list exceeded ${maxPages} pages`);
      }
      const result = parseToolsPage(
        await client.request(
          {
            method: "tools/list",
            params: cursor === undefined ? {} : { cursor },
          },
          { timeout: timeoutMs, signal: controller.signal },
        ),
      );
      bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      if (bytes > maxBytes) throw new Error(`MCP tools/list exceeded ${maxBytes} bytes`);
      tools.push(...result.tools);
      if (tools.length > maxTools) throw new Error(`MCP tools/list exceeded ${maxTools} tools`);
      if (result.nextCursor === undefined) break;
      if (seenCursors.has(result.nextCursor)) {
        throw new Error(`MCP tools/list cursor cycle at ${JSON.stringify(result.nextCursor)}`);
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    listedTools = tools;
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timer);
  }
  let closeError: unknown;
  try {
    await client.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  if (listedTools === undefined) throw new Error(`MCP server ${server.name} returned no tool list`);
  return listedTools;
}

function parseToolsPage(value: unknown): { tools: ListedMcpTool[]; nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value["tools"])) {
    throw new Error("MCP tools/list returned no tools array");
  }
  const tools = value["tools"].map((raw, index) => {
    if (!isRecord(raw) || !nonEmptyString(raw["name"])) {
      throw new Error(`MCP tools/list tool ${index} has no name`);
    }
    const description = optionalString(raw, "description", `tool ${raw["name"]}`);
    const title = optionalString(raw, "title", `tool ${raw["name"]}`);
    return {
      name: raw["name"],
      ...(description === undefined ? {} : { description }),
      ...(title === undefined ? {} : { title }),
      ...(raw["inputSchema"] === undefined ? {} : { inputSchema: raw["inputSchema"] }),
    };
  });
  const rawCursor = value["nextCursor"];
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== "string") {
    throw new Error("MCP tools/list nextCursor must be a string or null");
  }
  return {
    tools,
    ...(typeof rawCursor === "string" ? { nextCursor: rawCursor } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!nonEmptyString(value)) throw new Error(`MCP tools/list ${context} has invalid ${key}`);
  return value;
}

function transportFor(server: ResolvedMcpServer): Transport {
  if (server.url !== undefined) {
    if (server.transport === "sse") {
      return new SSEClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
        eventSourceInit: {
          fetch: (url, init) => {
            const headers = new Headers(init.headers);
            for (const [name, value] of Object.entries(server.headers)) headers.set(name, value);
            return fetch(url, { ...init, headers });
          },
        },
      });
    }
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    });
  }
  if (server.command === undefined) throw new Error(`MCP server ${server.name} has no transport`);
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...server.env },
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    stderr: "ignore",
    maxBufferSize: 4 * 1024 * 1024,
  });
}
