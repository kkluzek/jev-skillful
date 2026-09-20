import { type ChildProcess, spawn } from "node:child_process";
import { replaceControlCharacters } from "./text.js";
import { trustedExecutableOnPath } from "./trusted-executable.js";

export interface ClaudeRuntimeTool {
  name: string;
  description?: string;
  title?: string;
}

export interface ClaudeRuntimeToolServer {
  name: string;
  source: string;
  status: string;
  toolPrefix: string;
  tools: ClaudeRuntimeTool[];
  toolsError: string | null;
}

export interface ClaudeRuntimeToolInventory {
  servers: ClaudeRuntimeToolServer[];
  warnings: string[];
  complete: boolean;
}

export interface ClaudeRuntimeOptions {
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxServers?: number;
  maxTools?: number;
  warmupTimeoutMs?: number;
}

export interface ClaudeRuntimeDependencies {
  resolveExecutable?: () => Promise<string | null>;
  warmup?: typeof warmClaudeMcpConnections;
  inventory?: typeof runClaudeRuntimeInventory;
}

/**
 * Read Claude Code's effective tool inventory from its init event. The child is terminated as soon
 * as init arrives, before a model request can run; hooks are disabled for the probe as a second
 * recursion boundary. This is the only inventory surface that includes Claude-managed OAuth apps.
 */
export async function listClaudeRuntimeTools(
  options: ClaudeRuntimeOptions,
  dependencies: ClaudeRuntimeDependencies = {},
): Promise<ClaudeRuntimeToolInventory> {
  const executable =
    dependencies.resolveExecutable === undefined
      ? await trustedExecutableOnPath("claude", options.env["PATH"], {
          projectDir: options.cwd,
          cwd: options.cwd,
        })
      : await dependencies.resolveExecutable();
  if (executable === null) {
    return {
      servers: [],
      warnings: ["Claude runtime tool discovery skipped: claude is not executable on PATH"],
      complete: false,
    };
  }
  const warmupWarnings = await (dependencies.warmup ?? warmClaudeMcpConnections)(
    executable,
    options,
  );
  try {
    const inventory = await (dependencies.inventory ?? runClaudeRuntimeInventory)(
      executable,
      options,
    );
    return {
      ...inventory,
      warnings: [...warmupWarnings, ...inventory.warnings],
      complete: inventory.complete && warmupWarnings.length === 0,
    };
  } catch (error) {
    return {
      servers: [],
      warnings: [
        ...warmupWarnings,
        `Claude runtime tool inventory failed: ${bounded((error as Error).message)}`,
      ],
      complete: false,
    };
  }
}

/** Ask Claude's owning client to health-check approved MCP servers before capturing system/init. */
export async function warmClaudeMcpConnections(
  executable: string,
  options: ClaudeRuntimeOptions,
): Promise<string[]> {
  const timeoutMs = options.warmupTimeoutMs ?? 5_000;
  const detached = process.platform !== "win32";
  const child = spawn(executable, ["mcp", "list"], {
    cwd: options.cwd,
    stdio: ["ignore", "ignore", "pipe"],
    detached,
    env: definedEnv({
      ...options.env,
      SKILLFUL_DISCOVERY_NESTED: "1",
      NO_COLOR: "1",
    }),
  });
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const finish = (warnings: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(warnings);
    };
    const timer = setTimeout(() => {
      terminate(child, detached);
      finish([`Claude MCP warm-up timed out after ${timeoutMs}ms`]);
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < 4_096) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) =>
      finish([`Claude MCP warm-up failed: ${bounded(error.message)}`]),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) finish([]);
      else {
        const detail = bounded(stderr);
        finish([
          `Claude MCP warm-up exited ${code ?? signal ?? "unknown"}${detail === "" ? "" : `: ${detail}`}`,
        ]);
      }
    });
  });
}

export function parseClaudeRuntimeInit(
  value: unknown,
  limits: Pick<ClaudeRuntimeOptions, "maxServers" | "maxTools"> = {},
): ClaudeRuntimeToolInventory {
  const root = asRecord(value);
  if (root["type"] !== "system" || root["subtype"] !== "init") {
    throw new Error("Claude runtime event is not a system/init event");
  }
  if (!Array.isArray(root["tools"]) || !Array.isArray(root["mcp_servers"])) {
    throw new Error("Claude runtime init event has no tools or mcp_servers array");
  }
  const maxServers = limits.maxServers ?? 2_000;
  const maxTools = limits.maxTools ?? 10_000;
  if (root["mcp_servers"].length > maxServers) {
    throw new Error(`Claude runtime inventory exceeded ${maxServers} servers`);
  }

  const warnings: string[] = [];
  const prefixOwners = new Map<string, string>();
  const servers: ClaudeRuntimeToolServer[] = root["mcp_servers"].map((raw, index) => {
    const item = asRecord(raw);
    const name = asString(item["name"]);
    const status = asString(item["status"]);
    const source = asString(item["source"]);
    if (name === undefined || status === undefined || source === undefined) {
      throw new Error(`Claude MCP server ${index} is missing name, status, or source`);
    }
    const toolPrefix = `mcp__${toolPart(name)}__`;
    const previous = prefixOwners.get(toolPrefix);
    if (previous !== undefined) {
      warnings.push(
        `Claude MCP servers ${JSON.stringify(previous)} and ${JSON.stringify(name)} share tool prefix ${toolPrefix}`,
      );
    } else {
      prefixOwners.set(toolPrefix, name);
    }
    return {
      name,
      source,
      status,
      toolPrefix,
      tools: [],
      toolsError: status === "connected" ? null : `Claude MCP status: ${status}`,
    };
  });

  const prefixes = [...prefixOwners.keys()].sort((a, b) => b.length - a.length);
  let toolCount = 0;
  for (const [index, raw] of root["tools"].entries()) {
    if (typeof raw !== "string") throw new Error(`Claude tool ${index} is not a string`);
    if (!raw.startsWith("mcp__")) continue;
    toolCount += 1;
    if (toolCount > maxTools)
      throw new Error(`Claude runtime inventory exceeded ${maxTools} tools`);
    const prefix = prefixes.find((candidate) => raw.startsWith(candidate));
    if (prefix === undefined) {
      warnings.push(`Claude runtime tool ${raw} could not be matched to an MCP server`);
      continue;
    }
    const server = servers.find((candidate) => candidate.toolPrefix === prefix);
    const name = raw.slice(prefix.length);
    if (server === undefined || name === "") {
      warnings.push(`Claude runtime tool ${raw} has an invalid MCP namespace`);
      continue;
    }
    server.tools.push({ name });
  }
  for (const server of servers) {
    server.tools.sort((a, b) => a.name.localeCompare(b.name));
    // The init event can arrive while the human-readable server status still says "pending" even
    // though Claude has already published callable exact tool names. The tool surface is the
    // stronger availability signal because it is what the same client exposes to the session.
    if (server.tools.length > 0) server.toolsError = null;
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, warnings, complete: warnings.length === 0 };
}

/** Process-level adapter exported for deterministic integration testing; callers normally use the resolver above. */
export async function runClaudeRuntimeInventory(
  executable: string,
  options: ClaudeRuntimeOptions,
): Promise<ClaudeRuntimeToolInventory> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const detached = process.platform !== "win32";
  const child = spawn(
    executable,
    [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--permission-prompts",
      "none",
      "--max-turns",
      "1",
      "--model",
      "skillful-inventory-no-inference",
      "--settings",
      '{"disableAllHooks":true}',
      "Skillful inventory probe; do not use tools.",
    ],
    {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      env: definedEnv({
        ...options.env,
        SKILLFUL_DISCOVERY_NESTED: "1",
        NO_COLOR: "1",
      }),
    },
  );

  return new Promise<ClaudeRuntimeToolInventory>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const timer = setTimeout(
      () => fail(new Error(`Claude runtime inventory timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();

    const finish = (inventory: ClaudeRuntimeToolInventory): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child, detached);
      resolve(inventory);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate(child, detached);
      const detail = bounded(stderr);
      reject(new Error(`${error.message}${detail === "" ? "" : `: ${detail}`}`));
    };
    const handle = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(new Error(`Claude runtime emitted invalid JSON: ${(error as Error).message}`));
        return;
      }
      const record = asRecord(message);
      if (record["type"] !== "system" || record["subtype"] !== "init") return;
      try {
        finish(parseClaudeRuntimeInit(message, options));
      } catch (error) {
        fail(new Error(`Claude runtime init was invalid: ${(error as Error).message}`));
      }
    };

    child.once("error", (error) => fail(error));
    child.once("exit", (code, signal) => {
      if (!settled)
        fail(
          new Error(
            `Claude runtime exited before inventory completed (${code ?? signal ?? "unknown"})`,
          ),
        );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < 16_384) stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`Claude runtime inventory exceeded ${maxOutputBytes} output bytes`));
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
  });
}

function terminate(child: ChildProcess, detached: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (detached) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (detached) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 500);
  timer.unref?.();
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function toolPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
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
