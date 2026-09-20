import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { replaceControlCharacters } from "./text.js";
import { trustedExecutableOnPath } from "./trusted-executable.js";

export interface CodexRuntimeTool {
  name: string;
  description?: string;
  title?: string;
}

export interface CodexRuntimeToolServer {
  name: string;
  pluginId: string | null;
  tools: CodexRuntimeTool[];
  toolsError: string | null;
}

export interface CodexRuntimeToolInventory {
  servers: CodexRuntimeToolServer[];
  warnings: string[];
  complete: boolean;
}

export interface CodexAppServerOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Project root used to evaluate project/plugin/app policy in an ephemeral thread. */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxPages?: number;
  maxServers?: number;
  maxTools?: number;
}

interface ParsedStatusPage {
  servers: CodexRuntimeToolServer[];
  nextCursor?: string;
}

/**
 * Read Codex's own effective MCP catalog. This includes plugin apps/connectors and applies the
 * client's current enablement and tool policy without calling any tool.
 */
export async function listCodexRuntimeTools(
  options: CodexAppServerOptions,
): Promise<CodexRuntimeToolInventory> {
  const executable = await trustedExecutableOnPath("codex", options.env["PATH"], {
    projectDir: options.cwd,
    cwd: options.cwd,
  });
  if (executable === null) {
    return {
      servers: [],
      warnings: ["Codex runtime tool discovery skipped: codex is not executable on PATH"],
      complete: false,
    };
  }
  try {
    const servers = await runAppServerInventory(executable, options);
    return { servers, warnings: [], complete: true };
  } catch (error) {
    return {
      servers: [],
      warnings: [`Codex app-server tool inventory failed: ${bounded((error as Error).message)}`],
      complete: false,
    };
  }
}

export function parseCodexMcpStatusPage(value: unknown): ParsedStatusPage {
  const root = asRecord(value);
  if (!Array.isArray(root["data"])) {
    throw new Error("Codex MCP status page does not contain a data array");
  }
  const data = root["data"];
  const servers: CodexRuntimeToolServer[] = [];
  for (const [serverIndex, item] of data.entries()) {
    const record = asRecord(item);
    const name = asString(record["name"]);
    if (name === undefined) throw new Error(`Codex MCP status server ${serverIndex} has no name`);
    if (
      record["tools"] === null ||
      typeof record["tools"] !== "object" ||
      Array.isArray(record["tools"])
    ) {
      throw new Error(`Codex MCP status server ${name} has no tools object`);
    }
    const tools: CodexRuntimeTool[] = [];
    for (const [toolKey, raw] of Object.entries(asRecord(record["tools"]))) {
      const tool = asRecord(raw);
      const toolName = asString(tool["name"]);
      if (toolName === undefined) {
        throw new Error(`Codex MCP status tool ${name}.${toolKey} has no name`);
      }
      const description = optionalString(tool, "description", `tool ${name}.${toolName}`);
      const title = optionalString(tool, "title", `tool ${name}.${toolName}`);
      tools.push({
        name: toolName,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      });
    }
    const runtimeStatus = optionalString(record, "runtimeStatus", `server ${name}`);
    const authStatus = optionalString(record, "authStatus", `server ${name}`);
    let toolsError = optionalString(record, "toolsError", `server ${name}`) ?? null;
    if (toolsError === null && authStatus === "notLoggedIn") toolsError = "authentication required";
    if (
      toolsError === null &&
      (runtimeStatus === "authenticationRequired" ||
        runtimeStatus === "failed" ||
        runtimeStatus === "cancelled")
    ) {
      toolsError = `Codex MCP runtime status: ${runtimeStatus}`;
    }
    if (runtimeStatus === "disabled") tools.length = 0;
    tools.sort((a, b) => a.name.localeCompare(b.name));
    servers.push({
      name,
      pluginId: optionalString(record, "pluginId", `server ${name}`) ?? null,
      tools,
      toolsError,
    });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  const rawNextCursor = root["nextCursor"];
  if (rawNextCursor !== undefined && rawNextCursor !== null && typeof rawNextCursor !== "string") {
    throw new Error("Codex app-server MCP status nextCursor must be a string or null");
  }
  const nextCursor = typeof rawNextCursor === "string" ? rawNextCursor : undefined;
  return { servers, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

async function runAppServerInventory(
  executable: string,
  options: CodexAppServerOptions,
): Promise<CodexRuntimeToolServer[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const maxPages = options.maxPages ?? 25;
  const maxServers = options.maxServers ?? 2_000;
  const maxTools = options.maxTools ?? 10_000;
  const detached = process.platform !== "win32";
  const child = spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached,
    env: definedEnv({ ...options.env, SKILLFUL_DISCOVERY_NESTED: "1" }),
  });

  return new Promise<CodexRuntimeToolServer[]>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let pages = 0;
    let toolCount = 0;
    const servers: CodexRuntimeToolServer[] = [];
    const seenCursors = new Set<string>();
    let threadId: string | undefined;
    const timer = setTimeout(
      () => fail(new Error(`Codex app-server inventory timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      terminate(child, detached);
      resolve(servers.sort((a, b) => a.name.localeCompare(b.name)));
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      terminate(child, detached);
      const detail = bounded(stderr);
      reject(new Error(`${error.message}${detail === "" ? "" : `: ${detail}`}`));
    };
    const send = (message: unknown): void => {
      if (settled) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const requestPage = (cursor?: string): void => {
      pages += 1;
      if (pages > maxPages) {
        fail(new Error(`Codex app-server inventory exceeded ${maxPages} pages`));
        return;
      }
      send({
        method: "mcpServerStatus/list",
        id: 3,
        params: {
          ...(cursor === undefined ? {} : { cursor }),
          ...(threadId === undefined ? {} : { threadId }),
          limit: 100,
          detail: "toolsAndAuthOnly",
        },
      });
    };
    const handle = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(line));
      } catch (error) {
        fail(new Error(`Codex app-server emitted invalid JSON: ${(error as Error).message}`));
        return;
      }
      if (message["id"] === 1) {
        if (message["error"] !== undefined) {
          fail(new Error(`Codex app-server initialize failed: ${rpcError(message["error"])}`));
          return;
        }
        send({ method: "initialized" });
        if (options.cwd === undefined) {
          requestPage();
        } else {
          send({
            method: "thread/start",
            id: 2,
            params: { cwd: path.resolve(options.cwd), ephemeral: true, serviceName: "skillful" },
          });
        }
        return;
      }
      if (message["id"] === 2) {
        if (message["error"] !== undefined) {
          fail(
            new Error(`Codex app-server ephemeral thread failed: ${rpcError(message["error"])}`),
          );
          return;
        }
        threadId = asString(asRecord(asRecord(message["result"])["thread"])["id"]);
        if (threadId === undefined) {
          fail(new Error("Codex app-server ephemeral thread returned no id"));
          return;
        }
        requestPage();
        return;
      }
      if (message["id"] !== 3) return;
      if (message["error"] !== undefined) {
        fail(new Error(`Codex app-server MCP inventory failed: ${rpcError(message["error"])}`));
        return;
      }
      let page: ParsedStatusPage;
      try {
        page = parseCodexMcpStatusPage(message["result"]);
      } catch (error) {
        fail(
          new Error(
            `Codex app-server MCP inventory had an invalid response: ${(error as Error).message}`,
          ),
        );
        return;
      }
      servers.push(...page.servers);
      toolCount += page.servers.reduce((sum, server) => sum + server.tools.length, 0);
      if (servers.length > maxServers) {
        fail(new Error(`Codex app-server inventory exceeded ${maxServers} servers`));
        return;
      }
      if (toolCount > maxTools) {
        fail(new Error(`Codex app-server inventory exceeded ${maxTools} tools`));
        return;
      }
      if (page.nextCursor === undefined) {
        finish();
        return;
      }
      if (seenCursors.has(page.nextCursor)) {
        fail(
          new Error(
            `Codex app-server inventory cursor cycle at ${JSON.stringify(page.nextCursor)}`,
          ),
        );
        return;
      }
      seenCursors.add(page.nextCursor);
      requestPage(page.nextCursor);
    };

    child.once("error", (error) => fail(error));
    child.stdin.on("error", (error) => {
      if (!settled) fail(error);
    });
    child.once("exit", (code, signal) => {
      if (!settled)
        fail(
          new Error(
            `Codex app-server exited before inventory completed (${code ?? signal ?? "unknown"})`,
          ),
        );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < 16_384) stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`Codex app-server inventory exceeded ${maxOutputBytes} output bytes`));
        return;
      }
      stdout += chunk.toString("utf8");
      while (!settled) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line !== "") handle(line);
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "skillful", title: "Skillful", version: "0.3.0" },
        capabilities: {
          optOutNotificationMethods: ["mcpServer/startupStatus/updated", "app/list/updated"],
        },
      },
    });
  });
}

function terminate(child: ChildProcessWithoutNullStreams, detached: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (detached) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      if (detached) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 500);
  killTimer.unref();
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function rpcError(value: unknown): string {
  const record = asRecord(value);
  return bounded(asString(record["message"]) ?? JSON.stringify(value));
}

function bounded(value: string, limit = 300): string {
  const oneLine = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  const parsed = asString(value);
  if (parsed === undefined) throw new Error(`Codex MCP status ${context} has invalid ${key}`);
  return parsed;
}
