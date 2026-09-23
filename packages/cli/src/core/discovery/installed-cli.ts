import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CliDiscoveryOptions } from "./cli.js";
import { type CliHelpTree, canProbeCliHelp, probeCliHelp } from "./probe.js";
import { replaceControlCharacters } from "./text.js";
import { isUnsafeProviderPath, trustedExecutableOnPath } from "./trusted-executable.js";

export type CliInstallManager = "homebrew" | "uv" | "pnpm" | "npm" | "bun";
export type CliAutocompleteSource = "carapace" | "homebrew-completion" | "zsh-completion";

export interface InstalledCliCommand {
  name: string;
  commandPath: string[];
  description: string;
  executablePath: string;
  executableRealPath: string;
  scope: "global" | "project";
  manager: CliInstallManager;
  packageName: string;
  version?: string;
  autocompleteSource: CliAutocompleteSource;
  metadataSource: CliAutocompleteSource | "help";
}

export interface InstalledCliDiscoveryResult {
  commands: InstalledCliCommand[];
  warnings: string[];
  /** False means the previous successful cache partition must be retained. */
  complete: boolean;
}

export interface InstalledPackageEntrypoint {
  manager: CliInstallManager;
  packageName: string;
  version?: string;
  name: string;
  reportedPath?: string;
  /** Target declared by the direct package's own manifest, never by a transitive package. */
  expectedTargetPath?: string;
  scope?: "global" | "project";
}

export interface TrustedRunRequest {
  executable: string;
  args: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface TrustedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface TrustedCommandRunner {
  run(request: TrustedRunRequest): Promise<TrustedRunResult>;
}

export interface InstalledCliDependencies {
  runner?: TrustedCommandRunner;
  probeHelp?: (executable: {
    name: string;
    path: string;
    realPath: string;
    scope: "global" | "project";
    shadowed: string[];
  }) => Promise<CliHelpTree>;
}

interface PackageLocation {
  packageName: string;
  version?: string;
  packagePath: string;
}

interface CarapaceExportNode {
  Name?: unknown;
  Short?: unknown;
  Long?: unknown;
  Commands?: unknown;
}

/**
 * Discover only direct user installations and then intersect them with known completion specs.
 * Package-manager listing commands and Carapace are trusted metadata providers. Only
 * basename-allowlisted direct-install targets may be started by the sandboxed help fallback.
 */
export async function discoverInstalledCliCommands(
  options: CliDiscoveryOptions,
  dependencies: InstalledCliDependencies = {},
): Promise<InstalledCliDiscoveryResult> {
  const runner = dependencies.runner ?? new SpawnTrustedCommandRunner(options.env);
  const warnings: string[] = [];
  const provider = async (name: string): Promise<string | undefined> => {
    if (dependencies.runner !== undefined) {
      return (await specificExecutableOnPath(name, options.env["PATH"])) ?? undefined;
    }
    return (
      (await trustedExecutableOnPath(name, options.env["PATH"], {
        projectDir: options.projectDir,
        cwd: options.cwd,
      })) ?? undefined
    );
  };
  const managers = {
    uv: await provider("uv"),
    pnpm: await provider("pnpm"),
    npm: await provider("npm"),
    bun: await provider("bun"),
    carapace: await provider("carapace"),
    brew: await provider("brew"),
  };

  const groups = await Promise.all([
    managers.brew === undefined ? Promise.resolve([]) : discoverHomebrew(managers.brew, warnings),
    runUv(managers.uv, runner, warnings),
    runPnpm(managers.pnpm, runner, warnings),
    runNpm(managers.npm, runner, warnings),
    runBun(managers.bun, runner, warnings),
    discoverProjectPackages(options.projectDir, warnings),
  ]);
  const installed = groups.flat();

  const completionNames = await discoverNativeCompletionNames(
    managers.brew,
    options.env,
    options.projectDir,
    warnings,
  );
  const carapace = await loadCarapaceIndex(managers.carapace, runner, warnings);
  const eligible = groupEntrypoints(
    installed.filter((item) => carapace.has(item.name) || completionNames.has(item.name)),
  );
  // Everything above defines the authoritative candidate set. An executable shadow is an
  // authoritative exclusion because the user's shell would run the shadow, not the manager-owned
  // target. By contrast, a failed Carapace/help tree below makes the refresh incomplete so a rich
  // previous command tree cannot be replaced by a root-only stub.
  let complete = warnings.length === 0;
  const commands: InstalledCliCommand[] = [];

  await mapLimit(eligible, 4, async (candidates) => {
    let selected:
      | {
          item: InstalledPackageEntrypoint;
          executable: { path: string; realPath: string };
        }
      | undefined;
    for (const item of candidates) {
      const executable = await resolveEntrypoint(item, options.env["PATH"]);
      if (executable !== null) {
        selected = { item, executable };
        break;
      }
    }
    if (selected === undefined) {
      const first = candidates[0];
      if (first === undefined) return;
      warnings.push(
        `${candidates.map((item) => `${item.manager}:${item.packageName}`).join(",")}: ${first.name} is installed but not executable on PATH (no manager-owned target is active)`,
      );
      return;
    }
    const { item, executable } = selected;
    const carapaceMeta = carapace.get(item.name);
    let nodes: Array<{ commandPath: string[]; description: string }> = [];
    let usedHelpFallback = false;
    let structuredTreeFailed = false;
    if (carapaceMeta !== undefined && managers.carapace !== undefined) {
      const result = await safeRun(
        runner,
        {
          executable: managers.carapace,
          args: [item.name, "export"],
          timeoutMs: 5_000,
          maxOutputBytes: 4 * 1024 * 1024,
        },
        warnings,
        `carapace ${item.name} export`,
      );
      if (result?.exitCode === 0) {
        try {
          const parsed = flattenCarapaceExportDetailed(JSON.parse(result.stdout), 4, 500);
          nodes = parsed.nodes;
          if (parsed.incompleteReasons.length > 0) {
            structuredTreeFailed = true;
            warnings.push(
              `carapace ${item.name} export: incomplete tree (${parsed.incompleteReasons.join(", ")})`,
            );
          }
          if (nodes.length === 0) {
            structuredTreeFailed = true;
            warnings.push(`carapace ${item.name} export: response contained no command root`);
          }
          nodes = nodes.map((node) => ({
            ...node,
            commandPath: [item.name, ...node.commandPath.slice(1)],
          }));
        } catch (error) {
          structuredTreeFailed = true;
          warnings.push(`carapace ${item.name} export: invalid JSON: ${(error as Error).message}`);
        }
      } else {
        structuredTreeFailed = true;
      }
    }
    if (nodes.length === 0 && canProbeCliHelp(item.name)) {
      try {
        const tree = await (
          dependencies.probeHelp ??
          ((target) =>
            probeCliHelp(target, {
              maxDepth: 3,
              maxNodes: 500,
              timeoutPerNodeMs: 1_000,
              totalTimeoutMs: 20_000,
            }))
        )({
          name: item.name,
          path: executable.path,
          realPath: executable.realPath,
          scope: item.scope ?? "global",
          shadowed: [],
        });
        nodes = tree.nodes;
        usedHelpFallback = nodes.length > 0;
        warnings.push(...tree.warnings);
        if (usedHelpFallback && tree.warnings.length === 0) structuredTreeFailed = false;
        if (tree.warnings.length > 0) complete = false;
      } catch (error) {
        warnings.push(`${item.name} help fallback: ${(error as Error).message}`);
        complete = false;
      }
    }
    if (structuredTreeFailed) complete = false;
    if (nodes.length === 0) {
      nodes = [{ commandPath: [item.name], description: carapaceMeta?.description ?? "" }];
    }
    const autocompleteSource: CliAutocompleteSource =
      carapaceMeta === undefined
        ? (completionNames.get(item.name) ?? "zsh-completion")
        : "carapace";
    for (const node of nodes) {
      commands.push({
        name: node.commandPath.join(" "),
        commandPath: node.commandPath,
        description: bound(
          node.description || `${item.packageName} command ${node.commandPath.join(" ")}`,
        ),
        executablePath: executable.path,
        executableRealPath: executable.realPath,
        scope: item.scope ?? "global",
        manager: item.manager,
        packageName: item.packageName,
        ...(item.version === undefined ? {} : { version: item.version }),
        autocompleteSource,
        metadataSource: usedHelpFallback ? "help" : autocompleteSource,
      });
    }
  });

  commands.sort((a, b) => a.name.localeCompare(b.name) || a.manager.localeCompare(b.manager));
  return { commands, warnings, complete };
}

export function parseUvToolList(raw: string): InstalledPackageEntrypoint[] {
  return parseUvToolListDetailed(raw).entries;
}

function parseUvToolListDetailed(raw: string): {
  entries: InstalledPackageEntrypoint[];
  unrecognised: string[];
} {
  const out: InstalledPackageEntrypoint[] = [];
  const unrecognised: string[] = [];
  let current: { packageName: string; version?: string } | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const header = /^([^\s]+)\s+v([^\s]+)\s+\(.+\)\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      current = {
        packageName: header[1],
        ...(header[2] === undefined ? {} : { version: header[2] }),
      };
      continue;
    }
    const entry = /^-\s+([^\s]+)\s+\((.+)\)\s*$/.exec(line);
    if (current === undefined || entry?.[1] === undefined || entry[2] === undefined) {
      unrecognised.push(line);
      continue;
    }
    out.push({ manager: "uv", ...current, name: entry[1], reportedPath: path.resolve(entry[2]) });
  }
  return { entries: out, unrecognised };
}

export function parseBunGlobalList(raw: string): {
  root: string | null;
  packages: PackageLocation[];
} {
  const parsed = parseBunGlobalListDetailed(raw);
  return { root: parsed.root, packages: parsed.packages };
}

function parseBunGlobalListDetailed(raw: string): {
  root: string | null;
  packages: PackageLocation[];
  unrecognised: string[];
} {
  const lines = raw.split(/\r?\n/);
  const header = /^(.+?)\s+node_modules\s+\(\d+(?:\s+installed)?\)\s*$/.exec(lines[0] ?? "");
  const root = header?.[1] === undefined ? null : path.join(header[1].trim(), "node_modules");
  if (root === null) {
    return { root, packages: [], unrecognised: lines.filter((line) => line.trim() !== "") };
  }
  const packages: PackageLocation[] = [];
  const unrecognised: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const match = /^[├└]──\s+(.+)@([^@\s]+)\s*$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      unrecognised.push(line);
      continue;
    }
    packages.push({
      packageName: match[1],
      version: match[2],
      packagePath: path.join(root, match[1]),
    });
  }
  return { root, packages, unrecognised };
}

export function flattenCarapaceExport(
  raw: unknown,
  maxDepth = 4,
  maxNodes = 500,
): Array<{ commandPath: string[]; description: string }> {
  return flattenCarapaceExportDetailed(raw, maxDepth, maxNodes).nodes;
}

function flattenCarapaceExportDetailed(
  raw: unknown,
  maxDepth: number,
  maxNodes: number,
): {
  nodes: Array<{ commandPath: string[]; description: string }>;
  incompleteReasons: string[];
} {
  const out: Array<{ commandPath: string[]; description: string }> = [];
  const incompleteReasons = new Set<string>();
  if (!isRecord(raw) || typeof raw["Name"] !== "string" || raw["Name"].trim() === "") {
    return { nodes: out, incompleteReasons: ["invalid root"] };
  }
  const visit = (node: CarapaceExportNode, parent: string[], depth: number): void => {
    if (out.length >= maxNodes) {
      incompleteReasons.add(`truncated at ${maxNodes} nodes`);
      return;
    }
    if (typeof node.Name !== "string" || node.Name.trim() === "") {
      incompleteReasons.add("invalid command node");
      return;
    }
    const commandPath = [...parent, node.Name.trim()];
    const short = typeof node.Short === "string" ? node.Short : "";
    const long =
      typeof node.Long === "string" && !/^https?:\/\//.test(node.Long.trim()) ? node.Long : "";
    out.push({ commandPath, description: bound(short || long) });
    if (node.Commands === undefined || node.Commands === null) return;
    if (!Array.isArray(node.Commands)) {
      incompleteReasons.add("invalid Commands field");
      return;
    }
    if (depth >= maxDepth) {
      if (node.Commands.length > 0) incompleteReasons.add(`truncated at depth ${maxDepth}`);
      return;
    }
    for (const child of node.Commands) {
      if (isRecord(child)) visit(child, commandPath, depth + 1);
      else incompleteReasons.add("invalid command child");
    }
  };
  visit(raw, [], 0);
  return { nodes: out, incompleteReasons: [...incompleteReasons] };
}

export class SpawnTrustedCommandRunner implements TrustedCommandRunner {
  constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}

  async run(request: TrustedRunRequest): Promise<TrustedRunResult> {
    try {
      return await this.runOnce(request.executable, request.args, request);
    } catch (error) {
      if (process.platform !== "win32" && (error as NodeJS.ErrnoException).code === "ENOEXEC") {
        return this.runOnce("/bin/sh", [request.executable, ...request.args], request);
      }
      throw error;
    }
  }

  private async runOnce(
    executable: string,
    args: readonly string[],
    request: TrustedRunRequest,
  ): Promise<TrustedRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: cleanEnv(this.env),
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;
      const maxBytes = request.maxOutputBytes ?? 8 * 1024 * 1024;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminateTrustedChild(child.pid, child.exitCode, child.signalCode);
        reject(error);
      };
      const add = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        bytes += Buffer.byteLength(text);
        if (bytes > maxBytes) return finishError(new Error(`output exceeded ${maxBytes} bytes`));
        if (target === "stdout") stdout += text;
        else stderr += text;
      };
      child.stdout?.on("data", (chunk) => add("stdout", chunk));
      child.stderr?.on("data", (chunk) => add("stderr", chunk));
      child.on("error", finishError);
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      });
      const timer = setTimeout(
        () => finishError(new Error(`timed out after ${request.timeoutMs ?? 15_000}ms`)),
        request.timeoutMs ?? 15_000,
      );
      timer.unref?.();
    });
  }
}

async function runUv(
  file: string | undefined,
  runner: TrustedCommandRunner,
  warnings: string[],
): Promise<InstalledPackageEntrypoint[]> {
  if (file === undefined) return [];
  const result = await safeRun(
    runner,
    { executable: file, args: ["tool", "list", "--show-paths"], timeoutMs: 30_000 },
    warnings,
    "uv tool list",
  );
  if (result?.exitCode !== 0) return [];
  const parsed = parseUvToolListDetailed(result.stdout);
  if (parsed.unrecognised.length > 0) {
    warnings.push(
      `uv tool list: unrecognised non-empty output (${parsed.unrecognised.length} line(s))`,
    );
  }
  return parsed.entries;
}

async function runPnpm(
  file: string | undefined,
  runner: TrustedCommandRunner,
  warnings: string[],
): Promise<InstalledPackageEntrypoint[]> {
  if (file === undefined) return [];
  const [result, bin] = await Promise.all([
    safeRun(
      runner,
      {
        executable: file,
        args: ["list", "-g", "--depth=0", "--json"],
        timeoutMs: 30_000,
      },
      warnings,
      "pnpm list -g",
    ),
    safeRun(
      runner,
      { executable: file, args: ["bin", "-g"], timeoutMs: 30_000 },
      warnings,
      "pnpm bin -g",
    ),
  ]);
  if (result?.exitCode !== 0 || bin?.exitCode !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const root = Array.isArray(parsed) ? parsed[0] : undefined;
    if (!isRecord(root)) throw new Error("expected a non-empty JSON array");
    if (root["dependencies"] !== undefined && !isRecord(root["dependencies"])) {
      throw new Error("dependencies is not a JSON object");
    }
    const dependencies = isRecord(root["dependencies"]) ? root["dependencies"] : {};
    const locations = packageLocationsFromDependencyTable(dependencies, warnings);
    return packageEntrypoints("pnpm", locations, warnings, "global", bin.stdout.trim());
  } catch (error) {
    warnings.push(`pnpm list -g: invalid output: ${(error as Error).message}`);
    return [];
  }
}

async function runNpm(
  file: string | undefined,
  runner: TrustedCommandRunner,
  warnings: string[],
): Promise<InstalledPackageEntrypoint[]> {
  if (file === undefined) return [];
  const [listing, root, prefix] = await Promise.all([
    safeRun(
      runner,
      {
        executable: file,
        args: ["ls", "-g", "--depth=0", "--json"],
        timeoutMs: 30_000,
      },
      warnings,
      "npm ls -g",
    ),
    safeRun(
      runner,
      { executable: file, args: ["root", "-g"], timeoutMs: 30_000 },
      warnings,
      "npm root -g",
    ),
    safeRun(
      runner,
      { executable: file, args: ["prefix", "-g"], timeoutMs: 30_000 },
      warnings,
      "npm prefix -g",
    ),
  ]);
  if (listing?.exitCode !== 0 || root?.exitCode !== 0 || prefix?.exitCode !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(listing.stdout);
    if (!isRecord(parsed)) throw new Error("expected a JSON object");
    if (parsed["dependencies"] !== undefined && !isRecord(parsed["dependencies"])) {
      throw new Error("dependencies is not a JSON object");
    }
    const dependencies = isRecord(parsed["dependencies"]) ? parsed["dependencies"] : {};
    const rootDir = root.stdout.trim();
    const locations = Object.entries(dependencies).map(([packageName, value]) => ({
      packageName,
      ...(isRecord(value) && typeof value["version"] === "string"
        ? { version: value["version"] }
        : {}),
      packagePath: path.join(rootDir, packageName),
    }));
    return packageEntrypoints(
      "npm",
      locations,
      warnings,
      "global",
      path.join(prefix.stdout.trim(), "bin"),
    );
  } catch (error) {
    warnings.push(`npm ls -g: invalid output: ${(error as Error).message}`);
    return [];
  }
}

async function runBun(
  file: string | undefined,
  runner: TrustedCommandRunner,
  warnings: string[],
): Promise<InstalledPackageEntrypoint[]> {
  if (file === undefined) return [];
  const [result, bin] = await Promise.all([
    safeRun(
      runner,
      { executable: file, args: ["pm", "ls", "-g"], timeoutMs: 30_000 },
      warnings,
      "bun pm ls -g",
    ),
    safeRun(
      runner,
      { executable: file, args: ["pm", "bin", "-g"], timeoutMs: 30_000 },
      warnings,
      "bun pm bin -g",
    ),
  ]);
  if (result?.exitCode !== 0 || bin?.exitCode !== 0) return [];
  const parsed = parseBunGlobalListDetailed(result.stdout);
  if (result.stdout.trim() !== "" && parsed.root === null) {
    warnings.push("bun pm ls -g: unrecognised non-empty output");
    return [];
  }
  if (parsed.unrecognised.length > 0) {
    warnings.push(
      `bun pm ls -g: unrecognised non-empty output (${parsed.unrecognised.length} line(s))`,
    );
  }
  return packageEntrypoints("bun", parsed.packages, warnings, "global", bin.stdout.trim());
}

async function discoverProjectPackages(
  projectDir: string | null,
  warnings: string[],
): Promise<InstalledPackageEntrypoint[]> {
  if (projectDir === null) return [];
  try {
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, "package.json"), "utf8"),
    ) as unknown;
    if (!isRecord(manifest)) {
      warnings.push("project package.json: expected a JSON object");
      return [];
    }
    const manager = await projectPackageManager(projectDir, manifest);
    if (manager === null) return [];
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const table = manifest[field];
      if (table !== undefined && !isRecord(table)) {
        warnings.push(`project package.json: ${field} is not a JSON object`);
        continue;
      }
      if (isRecord(table)) for (const name of Object.keys(table)) names.add(name);
    }
    const locations = [...names].map((packageName) => ({
      packageName,
      packagePath: path.join(projectDir, "node_modules", packageName),
    }));
    return packageEntrypoints(manager, locations, warnings, "project");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      warnings.push(`project package.json: ${(error as Error).message}`);
    return [];
  }
}

async function projectPackageManager(
  projectDir: string,
  manifest: Record<string, unknown>,
): Promise<Extract<CliInstallManager, "pnpm" | "npm" | "bun"> | null> {
  const declared =
    typeof manifest["packageManager"] === "string"
      ? manifest["packageManager"].split("@")[0]
      : undefined;
  if (declared === "pnpm" || declared === "npm" || declared === "bun") return declared;
  if (declared !== undefined) return null;

  const signals: Array<[Extract<CliInstallManager, "pnpm" | "npm" | "bun">, string[]]> = [
    ["pnpm", ["pnpm-lock.yaml"]],
    ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
    ["bun", ["bun.lock", "bun.lockb"]],
  ];
  const detected: Array<Extract<CliInstallManager, "pnpm" | "npm" | "bun">> = [];
  for (const [manager, files] of signals) {
    if (await anyFileExists(files.map((file) => path.join(projectDir, file))))
      detected.push(manager);
  }
  return detected.length === 1 ? (detected[0] ?? null) : null;
}

function packageLocationsFromDependencyTable(
  table: Record<string, unknown>,
  warnings: string[],
): PackageLocation[] {
  return Object.entries(table).flatMap(([packageName, value]) => {
    if (!isRecord(value) || typeof value["path"] !== "string" || !path.isAbsolute(value["path"])) {
      warnings.push(`pnpm list -g: dependency ${packageName} has no absolute package path`);
      return [];
    }
    if (value["version"] !== undefined && typeof value["version"] !== "string") {
      warnings.push(`pnpm list -g: dependency ${packageName} has a non-string version`);
      return [];
    }
    return [
      {
        packageName,
        ...(typeof value["version"] === "string" ? { version: value["version"] } : {}),
        packagePath: value["path"],
      },
    ];
  });
}

async function packageEntrypoints(
  manager: CliInstallManager,
  locations: readonly PackageLocation[],
  warnings: string[],
  scope: "global" | "project" = "global",
  globalBinDir?: string,
): Promise<InstalledPackageEntrypoint[]> {
  const out: InstalledPackageEntrypoint[] = [];
  await Promise.all(
    locations.map(async (location) => {
      try {
        const manifest: unknown = JSON.parse(
          await readFile(path.join(location.packagePath, "package.json"), "utf8"),
        );
        if (!isRecord(manifest)) {
          warnings.push(`${location.packagePath}/package.json: expected a JSON object`);
          return;
        }
        const bins = manifest["bin"];
        if (typeof bins === "string") {
          const name = unscopedName(location.packageName);
          out.push({
            manager,
            packageName: location.packageName,
            ...(location.version === undefined ? {} : { version: location.version }),
            name,
            expectedTargetPath: path.resolve(location.packagePath, bins),
            ...(scope === "project"
              ? { reportedPath: path.join(nodeModulesRoot(location.packagePath), ".bin", name) }
              : globalBinDir === undefined
                ? {}
                : { reportedPath: path.join(globalBinDir, name) }),
            ...(scope === "project" ? { scope } : {}),
          });
        } else if (isRecord(bins)) {
          for (const [name, target] of Object.entries(bins)) {
            if (typeof target !== "string") continue;
            out.push({
              manager,
              packageName: location.packageName,
              ...(location.version === undefined ? {} : { version: location.version }),
              name,
              expectedTargetPath: path.resolve(location.packagePath, target),
              ...(scope === "project"
                ? { reportedPath: path.join(nodeModulesRoot(location.packagePath), ".bin", name) }
                : globalBinDir === undefined
                  ? {}
                  : { reportedPath: path.join(globalBinDir, name) }),
              ...(scope === "project" ? { scope } : {}),
            });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.push(`${location.packagePath}/package.json: ${(error as Error).message}`);
      }
    }),
  );
  return out;
}

async function discoverHomebrew(
  brewPath: string,
  warnings: string[],
): Promise<InstalledPackageEntrypoint[]> {
  const prefix = await resolveHomebrewPrefix(brewPath);
  const formulae = await receiptPackages(path.join(prefix, "Cellar"), "homebrew", warnings);
  const casks = await caskReceiptPackages(path.join(prefix, "Caskroom"), warnings);
  const all = [...formulae, ...casks];
  const linkedExecutables = await indexExecutableDirectories(
    [path.join(prefix, "bin"), path.join(prefix, "sbin")],
    warnings,
  );
  const out: InstalledPackageEntrypoint[] = [];
  for (const item of all) {
    const marker = item.cask
      ? `${path.sep}Caskroom${path.sep}${item.packageName}${path.sep}`
      : `${path.sep}Cellar${path.sep}${item.packageName}${path.sep}`;
    for (const [name, executable] of linkedExecutables) {
      if (!executable.realPath.includes(marker)) continue;
      out.push({
        manager: "homebrew",
        packageName: item.packageName,
        version: item.version,
        name,
        reportedPath: executable.path,
      });
    }
  }
  return out;
}

async function resolveHomebrewPrefix(brewPath: string): Promise<string> {
  let prefix: string;
  try {
    prefix = path.dirname(path.dirname(await realpath(brewPath)));
  } catch {
    prefix = path.dirname(path.dirname(brewPath));
  }
  // Intel Homebrew keeps the repository at /usr/local/Homebrew/bin/brew while Cellar, bin and
  // completions remain rooted at /usr/local. Apple Silicon keeps brew directly under the prefix.
  return path.basename(prefix) === "Homebrew" ? path.dirname(prefix) : prefix;
}

async function receiptPackages(
  cellar: string,
  _manager: "homebrew",
  warnings: string[],
): Promise<Array<{ packageName: string; version: string; cask: false }>> {
  const out: Array<{ packageName: string; version: string; cask: false }> = [];
  for (const packageName of await safeReadDir(cellar, warnings)) {
    const versions = await safeReadDir(path.join(cellar, packageName), warnings);
    for (const version of versions) {
      const receipt = await readReceipt(
        path.join(cellar, packageName, version, "INSTALL_RECEIPT.json"),
        warnings,
      );
      if (receipt?.installedOnRequest === true) out.push({ packageName, version, cask: false });
    }
  }
  return out;
}

async function caskReceiptPackages(
  caskroom: string,
  warnings: string[],
): Promise<Array<{ packageName: string; version: string; cask: true }>> {
  const out: Array<{ packageName: string; version: string; cask: true }> = [];
  for (const packageName of await safeReadDir(caskroom, warnings)) {
    const receipt = await readReceipt(
      path.join(caskroom, packageName, ".metadata", "INSTALL_RECEIPT.json"),
      warnings,
    );
    if (receipt?.installedOnRequest === true)
      out.push({ packageName, version: receipt.version ?? "unknown", cask: true });
  }
  return out;
}

async function readReceipt(
  file: string,
  warnings: string[],
): Promise<{ installedOnRequest: boolean; version?: string } | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(value)) {
      warnings.push(`${file}: expected a JSON object`);
      return null;
    }
    if (typeof value["installed_on_request"] !== "boolean") {
      warnings.push(`${file}: installed_on_request is not a boolean`);
      return null;
    }
    const source = isRecord(value["source"]) ? value["source"] : undefined;
    const versions =
      source !== undefined && isRecord(source["versions"]) ? source["versions"] : undefined;
    const version =
      typeof source?.["version"] === "string"
        ? source["version"]
        : typeof versions?.["stable"] === "string"
          ? versions["stable"]
          : undefined;
    return {
      installedOnRequest: value["installed_on_request"],
      ...(version === undefined ? {} : { version }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      warnings.push(`${file}: ${(error as Error).message}`);
    return null;
  }
}

async function loadCarapaceIndex(
  file: string | undefined,
  runner: TrustedCommandRunner,
  warnings: string[],
): Promise<Map<string, { description: string }>> {
  if (file === undefined) return new Map();
  const result = await safeRun(
    runner,
    { executable: file, args: ["--list"], maxOutputBytes: 8 * 1024 * 1024 },
    warnings,
    "carapace --list",
  );
  if (result?.exitCode !== 0) return new Map();
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed)) {
      warnings.push("carapace --list: expected a JSON object");
      return new Map();
    }
    const out = new Map<string, { description: string }>();
    for (const [name, variants] of Object.entries(parsed)) {
      if (!Array.isArray(variants)) {
        warnings.push(`carapace --list: ${name} has no variants array`);
        continue;
      }
      const described = variants.find(
        (item) => isRecord(item) && typeof item["description"] === "string",
      );
      out.set(name, {
        description: isRecord(described) ? bound(String(described["description"])) : "",
      });
    }
    return out;
  } catch (error) {
    warnings.push(`carapace --list: invalid JSON: ${(error as Error).message}`);
    return new Map();
  }
}

async function discoverNativeCompletionNames(
  brewPath: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string | null,
  warnings: string[],
): Promise<Map<string, Exclude<CliAutocompleteSource, "carapace">>> {
  const out = new Map<string, Exclude<CliAutocompleteSource, "carapace">>();
  const roots: Array<{
    dir: string;
    source: Exclude<CliAutocompleteSource, "carapace">;
    parse: (name: string) => string;
  }> = [];
  if (brewPath !== undefined) {
    const prefix = await resolveHomebrewPrefix(brewPath);
    roots.push(
      {
        dir: path.join(prefix, "share", "zsh", "site-functions"),
        source: "homebrew-completion",
        parse: zshCompletionName,
      },
      {
        dir: path.join(prefix, "share", "fish", "vendor_completions.d"),
        source: "homebrew-completion",
        parse: (name) => name.replace(/\.fish$/, ""),
      },
      {
        dir: path.join(prefix, "etc", "bash_completion.d"),
        source: "homebrew-completion",
        parse: (name) => name,
      },
    );
  }
  const homeDir = env["HOME"]?.trim();
  const zshRoots = new Set(
    (env["FPATH"] ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item)),
  );
  if (homeDir !== undefined && homeDir !== "") {
    const configHome = env["XDG_CONFIG_HOME"]?.trim() || path.join(homeDir, ".config");
    const dataHome = env["XDG_DATA_HOME"]?.trim() || path.join(homeDir, ".local", "share");
    const cacheHome = env["XDG_CACHE_HOME"]?.trim() || path.join(homeDir, ".cache");
    for (const dir of [
      path.join(homeDir, ".zfunc"),
      path.join(configHome, "zsh", "completions"),
      path.join(configHome, "docker", "completions"),
      path.join(dataHome, "zsh", "site-functions"),
      path.join(cacheHome, "zsh", "completions"),
    ]) {
      zshRoots.add(dir);
    }
  }
  const unsafeRoots = [projectDir].filter((item): item is string => item !== null);
  for (const dir of zshRoots) {
    if (isUnsafeProviderPath(dir, unsafeRoots)) continue;
    roots.push({ dir, source: "zsh-completion", parse: zshCompletionName });
  }
  for (const root of roots) {
    try {
      for (const file of await readdir(root.dir)) {
        const name = root.parse(file);
        if (name !== "" && !out.has(name)) out.set(name, root.source);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        warnings.push(`${root.dir}: ${(error as Error).message}`);
    }
  }
  return out;
}

function zshCompletionName(name: string): string {
  return name.startsWith("_") && name.length > 1 ? name.slice(1) : "";
}

async function specificExecutableOnPath(
  name: string,
  rawPath: string | undefined,
): Promise<string | null> {
  if (rawPath === undefined) return null;
  for (const root of rawPath.split(path.delimiter).filter((item) => path.isAbsolute(item))) {
    const candidate = path.join(root, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next explicit PATH entry.
    }
  }
  return null;
}

async function anyFileExists(files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    try {
      await access(file, fsConstants.F_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return false;
}

async function indexExecutableDirectories(
  directories: readonly string[],
  warnings: string[],
): Promise<Map<string, { path: string; realPath: string }>> {
  const out = new Map<string, { path: string; realPath: string }>();
  for (const root of directories) {
    for (const name of await safeReadDir(root, warnings)) {
      if (out.has(name)) continue;
      const file = path.join(root, name);
      try {
        const stat = await lstat(file);
        if (!(stat.isFile() || stat.isSymbolicLink())) continue;
        if (process.platform !== "win32") await access(file, fsConstants.X_OK);
        const resolved = await realpath(file);
        out.set(name, { path: file, realPath: resolved });
      } catch {
        // Racy or unreadable PATH entries are simply unavailable.
      }
    }
  }
  return out;
}

async function resolveEntrypoint(
  item: InstalledPackageEntrypoint,
  rawPath: string | undefined,
): Promise<{ path: string; realPath: string } | null> {
  if (item.scope === "project" && item.reportedPath !== undefined) {
    try {
      await access(
        item.reportedPath,
        process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
      );
      const resolved = await realpath(item.reportedPath);
      if (!(await matchesDeclaredTarget(item.reportedPath, resolved, item.expectedTargetPath))) {
        return null;
      }
      return { path: item.reportedPath, realPath: resolved };
    } catch {
      return null;
    }
  }
  const fromPath = await specificExecutableOnPath(item.name, rawPath);
  if (fromPath === null) return null;
  try {
    const resolved = await realpath(fromPath);
    if (!(await matchesExpectedTarget(resolved, item.reportedPath))) return null;
    if (!(await matchesDeclaredTarget(fromPath, resolved, item.expectedTargetPath))) return null;
    return { path: fromPath, realPath: resolved };
  } catch {
    return null;
  }
}

async function matchesDeclaredTarget(
  executablePath: string,
  actualRealPath: string,
  expectedPath: string | undefined,
): Promise<boolean> {
  if (expectedPath === undefined) return true;
  let expectedRealPath: string;
  try {
    expectedRealPath = await realpath(expectedPath);
  } catch {
    return false;
  }
  if (actualRealPath === expectedRealPath) return true;
  try {
    const shim = (await readFile(executablePath, "utf8")).slice(0, 8_192);
    const marker = /^# cmd-shim-target=(.+)$/m.exec(shim)?.[1]?.trim();
    if (marker !== undefined) return (await realpath(marker)) === expectedRealPath;
    return shim.includes(expectedPath) || shim.includes(expectedRealPath);
  } catch {
    return false;
  }
}

async function matchesExpectedTarget(
  actualRealPath: string,
  expectedPath: string | undefined,
): Promise<boolean> {
  if (expectedPath === undefined) return true;
  try {
    return actualRealPath === (await realpath(expectedPath));
  } catch {
    return false;
  }
}

function groupEntrypoints(
  items: readonly InstalledPackageEntrypoint[],
): InstalledPackageEntrypoint[][] {
  const out = new Map<string, InstalledPackageEntrypoint[]>();
  for (const item of items) {
    const key = `${item.scope ?? "global"}\u0000${item.name}`;
    const existing = out.get(key);
    if (existing === undefined) out.set(key, [item]);
    else existing.push(item);
  }
  return [...out.values()];
}

async function safeRun(
  runner: TrustedCommandRunner,
  request: TrustedRunRequest,
  warnings: string[],
  label: string,
): Promise<TrustedRunResult | null> {
  try {
    const result = await runner.run(request);
    if (result.exitCode !== 0)
      warnings.push(
        `${label}: exited ${result.exitCode}${result.stderr.trim() === "" ? "" : `: ${bound(result.stderr)}`}`,
      );
    return result;
  } catch (error) {
    warnings.push(`${label}: ${(error as Error).message}`);
    return null;
  }
}

async function safeReadDir(dir: string, warnings: string[] = []): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(`${dir}: ${(error as Error).message}`);
    }
    return [];
  }
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return {
    PATH: env["PATH"] ?? process.env["PATH"],
    HOME: env["HOME"] ?? process.env["HOME"],
    XDG_CONFIG_HOME: env["XDG_CONFIG_HOME"] ?? process.env["XDG_CONFIG_HOME"],
    XDG_CACHE_HOME: env["XDG_CACHE_HOME"] ?? process.env["XDG_CACHE_HOME"],
    XDG_DATA_HOME: env["XDG_DATA_HOME"] ?? process.env["XDG_DATA_HOME"],
    XDG_STATE_HOME: env["XDG_STATE_HOME"] ?? process.env["XDG_STATE_HOME"],
    BUN_INSTALL: env["BUN_INSTALL"] ?? process.env["BUN_INSTALL"],
    PNPM_HOME: env["PNPM_HOME"] ?? process.env["PNPM_HOME"],
    NPM_CONFIG_USERCONFIG: env["NPM_CONFIG_USERCONFIG"] ?? process.env["NPM_CONFIG_USERCONFIG"],
    NPM_CONFIG_PREFIX: env["NPM_CONFIG_PREFIX"] ?? process.env["NPM_CONFIG_PREFIX"],
    UV_CACHE_DIR: env["UV_CACHE_DIR"] ?? process.env["UV_CACHE_DIR"],
    UV_CONFIG_DIR: env["UV_CONFIG_DIR"] ?? process.env["UV_CONFIG_DIR"],
    UV_DATA_DIR: env["UV_DATA_DIR"] ?? process.env["UV_DATA_DIR"],
    CLAUDE_CONFIG_DIR: env["CLAUDE_CONFIG_DIR"] ?? process.env["CLAUDE_CONFIG_DIR"],
    CODEX_HOME: env["CODEX_HOME"] ?? process.env["CODEX_HOME"],
    LANG: env["LANG"] ?? process.env["LANG"] ?? "C.UTF-8",
    LC_ALL: env["LC_ALL"] ?? process.env["LC_ALL"],
    NO_COLOR: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
  };
}

function terminateTrustedChild(
  pid: number | undefined,
  exitCode: number | null,
  signalCode: NodeJS.Signals | null,
): void {
  if (pid === undefined || exitCode !== null || signalCode !== null) return;
  const detached = process.platform !== "win32";
  try {
    if (detached) process.kill(-pid, "SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch {
    // It may have exited between the timeout and cleanup.
  }
  const timer = setTimeout(() => {
    try {
      if (detached) process.kill(-pid, "SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 500);
  timer.unref?.();
}

function unscopedName(packageName: string): string {
  const slash = packageName.lastIndexOf("/");
  return slash === -1 ? packageName : packageName.slice(slash + 1);
}

function nodeModulesRoot(packagePath: string): string {
  const parts = path.resolve(packagePath).split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  return index === -1
    ? path.dirname(packagePath)
    : parts.slice(0, index + 1).join(path.sep) || path.sep;
}

function bound(value: string, limit = 300): string {
  const oneLine = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
