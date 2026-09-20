import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiscoveredExecutable } from "./cli.js";
import { parseCliHelp } from "./cli.js";

const TRUSTED_DOUBLE_DASH_HELP = new Set([
  "aws",
  "cargo",
  "docker",
  "gh",
  "helm",
  "kubectl",
  "rustup",
  "terraform",
  "uv",
]);

export function canProbeCliHelp(name: string): boolean {
  return TRUSTED_DOUBLE_DASH_HELP.has(name);
}

export interface CliHelpNode {
  commandPath: string[];
  description: string;
}

export interface CliHelpTree {
  executable: DiscoveredExecutable;
  nodes: CliHelpNode[];
  warnings: string[];
}

export interface ProbeCliHelpOptions {
  maxDepth?: number;
  maxNodes?: number;
  timeoutPerNodeMs?: number;
  totalTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HelpRunRequest {
  executable: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface HelpRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface HelpProcessRunner {
  run(request: HelpRunRequest): Promise<HelpRunResult>;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Recursively enrich one direct-install executable selected by a basename allowlist. The adapter fixes the one allowed
 * help grammar; Skillful never guesses by trying `help`, `-h`, and `--help` in sequence.
 */
export async function probeCliHelp(
  executable: DiscoveredExecutable,
  options: ProbeCliHelpOptions = {},
  runner: HelpProcessRunner = new SandboxedHelpProcessRunner(),
): Promise<CliHelpTree> {
  if (!canProbeCliHelp(executable.name)) {
    throw new Error(`No trusted help adapter for ${executable.name}`);
  }
  const maxDepth = clamp(options.maxDepth ?? 2, 0, 5);
  const maxNodes = clamp(options.maxNodes ?? 100, 1, 500);
  const timeoutPerNodeMs = clamp(options.timeoutPerNodeMs ?? 1_000, 100, 10_000);
  const totalTimeoutMs = clamp(options.totalTimeoutMs ?? 15_000, timeoutPerNodeMs, 60_000);
  const maxOutputBytes = clamp(options.maxOutputBytes ?? 256 * 1024, 1_024, 1024 * 1024);
  const startedAt = Date.now();
  const queue: Array<{ tail: string[]; depth: number }> = [{ tail: [], depth: 0 }];
  const seen = new Set<string>([""]);
  const nodes: CliHelpNode[] = [];
  const warnings: string[] = [];

  while (queue.length > 0 && nodes.length < maxNodes) {
    if (Date.now() - startedAt >= totalTimeoutMs) {
      warnings.push(`Help probing stopped after ${totalTimeoutMs}ms total`);
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    const result = await runner.run({
      executable: executable.realPath,
      args: [...current.tail, "--help"],
      timeoutMs: Math.max(100, Math.min(timeoutPerNodeMs, remaining)),
      maxOutputBytes,
    });
    const parsed = parseCliHelp(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode !== 0 && parsed.description === "" && parsed.subcommands.length === 0) {
      warnings.push(
        `${[executable.name, ...current.tail].join(" ")}: help exited ${result.exitCode}`,
      );
    }
    nodes.push({
      commandPath: [executable.name, ...current.tail],
      description: parsed.description,
    });
    if (current.depth >= maxDepth) {
      if (parsed.subcommands.length > 0) {
        warnings.push(
          `${[executable.name, ...current.tail].join(" ")}: help tree truncated at depth ${maxDepth}`,
        );
      }
      continue;
    }
    for (const child of parsed.subcommands) {
      const tail = [...current.tail, child.name];
      const key = tail.join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ tail, depth: current.depth + 1 });
    }
  }

  if (queue.length > 0 && nodes.length >= maxNodes) {
    warnings.push(`Help probing stopped at ${maxNodes} command nodes`);
  }
  return { executable, nodes, warnings };
}

/** macOS containment backend. Other platforms fail closed until an equivalent backend exists. */
export class SandboxedHelpProcessRunner implements HelpProcessRunner {
  async run(request: HelpRunRequest): Promise<HelpRunResult> {
    if (process.platform !== "darwin") {
      throw new SandboxUnavailableError(
        "Recursive CLI help requires an isolation backend; this build currently supports macOS sandbox-exec only.",
      );
    }
    const sandbox = "/usr/bin/sandbox-exec";
    try {
      await access(sandbox);
    } catch {
      throw new SandboxUnavailableError("/usr/bin/sandbox-exec is unavailable");
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "skillful-help-"));
    const profile = sandboxProfile(tempDir, request.executable);
    try {
      return await spawnBounded(
        sandbox,
        ["-p", profile, request.executable, ...request.args],
        tempDir,
        request.timeoutMs,
        request.maxOutputBytes,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function sandboxProfile(tempDir: string, executable: string): string {
  const home = process.env["HOME"];
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    `(allow file-write* (subpath ${sandboxString(tempDir)}))`,
    `(allow file-read* (literal ${sandboxString(executable)}))`,
    "(deny network*)",
  ];
  if (home !== undefined && home !== "") {
    rules.push(`(deny file-read* (subpath ${sandboxString(home)}))`);
  }
  return rules.join("\n");
}

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

export async function spawnBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<HelpRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: cwd,
        TMPDIR: cwd,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: process.env["LANG"] ?? "C.UTF-8",
        LC_ALL: process.env["LC_ALL"] ?? "C.UTF-8",
        NO_COLOR: "1",
        PAGER: "cat",
        GIT_PAGER: "cat",
        TERM: "dumb",
      },
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const stop = (reason?: Error) => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      if (reason !== undefined && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(reason);
      }
    };
    const add = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > maxOutputBytes) {
        stop(new Error(`CLI help output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk) => add("stdout", chunk));
    child.stderr?.on("data", (chunk) => add("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    const timer = setTimeout(
      () => stop(new Error(`CLI help timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
