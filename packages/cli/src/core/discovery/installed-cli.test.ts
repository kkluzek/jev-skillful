import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverInstalledCliCommands,
  flattenCarapaceExport,
  parseBunGlobalList,
  parseUvToolList,
  type TrustedCommandRunner,
} from "./installed-cli.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "skillful-installed-cli-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function executable(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
}

describe("installed CLI parsers", () => {
  it("extracts only uv tool entry points, not their Python dependencies", () => {
    expect(
      parseUvToolList(
        `ruff v0.9.1 (/tools/ruff)\n- ruff (/bin/ruff)\nhttpie v3.2.4 (/tools/httpie)\n- http (/bin/http)\n- https (/bin/https)\n`,
      ),
    ).toEqual([
      {
        manager: "uv",
        packageName: "ruff",
        version: "0.9.1",
        name: "ruff",
        reportedPath: "/bin/ruff",
      },
      {
        manager: "uv",
        packageName: "httpie",
        version: "3.2.4",
        name: "http",
        reportedPath: "/bin/http",
      },
      {
        manager: "uv",
        packageName: "httpie",
        version: "3.2.4",
        name: "https",
        reportedPath: "/bin/https",
      },
    ]);
  });

  it("parses only Bun's top-level global listing", () => {
    expect(
      parseBunGlobalList(`/global node_modules (191)\n├── @scope/one@1.2.3\n└── plain@4.5.6\n`),
    ).toEqual({
      root: "/global/node_modules",
      packages: [
        {
          packageName: "@scope/one",
          version: "1.2.3",
          packagePath: "/global/node_modules/@scope/one",
        },
        { packageName: "plain", version: "4.5.6", packagePath: "/global/node_modules/plain" },
      ],
    });
  });

  it("flattens a Carapace export without inventing commands", () => {
    expect(
      flattenCarapaceExport({
        Name: "demo",
        Short: "Demo CLI",
        Commands: [
          {
            Name: "repo",
            Short: "Repositories",
            Commands: [{ Name: "list", Short: "List repositories" }],
          },
        ],
      }),
    ).toEqual([
      { commandPath: ["demo"], description: "Demo CLI" },
      { commandPath: ["demo", "repo"], description: "Repositories" },
      { commandPath: ["demo", "repo", "list"], description: "List repositories" },
    ]);
  });
});

describe("discoverInstalledCliCommands", () => {
  it("intersects explicit top-level installs with autocomplete and uses recursive Carapace metadata", async () => {
    const bin = path.join(root, "bin");
    const packagePath = path.join(root, "pnpm", "demo-package");
    await Promise.all([
      executable(path.join(bin, "pnpm")),
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "ruff")),
      executable(path.join(bin, "transitive")),
      executable(path.join(packagePath, "cli.js")),
    ]);
    await symlink(path.join(packagePath, "cli.js"), path.join(bin, "demo"));
    await writeFile(
      path.join(packagePath, "package.json"),
      JSON.stringify({
        name: "demo-package",
        version: "1.0.0",
        bin: { demo: "cli.js" },
        dependencies: { transitive: "1.0.0" },
      }),
      "utf8",
    );

    const outputs = new Map<string, string>([
      ["pnpm bin -g", bin],
      [
        "pnpm list -g --depth=0 --json",
        JSON.stringify([
          {
            dependencies: {
              "demo-package": { version: "1.0.0", path: packagePath },
            },
          },
        ]),
      ],
      ["uv tool list --show-paths", `ruff v0.9.1 (${root}/uv/ruff)\n- ruff (${bin}/ruff)\n`],
      [
        "carapace --list",
        JSON.stringify({
          demo: [{ name: "demo", description: "Demo" }],
          ruff: [{ name: "ruff", description: "Linter" }],
          transitive: [{ name: "transitive", description: "Must not leak" }],
        }),
      ],
      [
        "carapace demo export",
        JSON.stringify({
          Name: "demo",
          Short: "Demo CLI",
          Commands: [{ Name: "run", Short: "Run a demo" }],
        }),
      ],
      ["carapace ruff export", JSON.stringify({ Name: "ruff", Short: "Fast Python linter" })],
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => ({
        stdout: outputs.get(`${path.basename(file)} ${args.join(" ")}`) ?? "",
        stderr: "",
        exitCode: outputs.has(`${path.basename(file)} ${args.join(" ")}`) ? 0 : 1,
      }),
    };

    const result = await discoverInstalledCliCommands(
      {
        cwd: root,
        projectDir: null,
        env: { PATH: bin },
      },
      { runner },
    );

    expect(result.commands.map((item) => item.commandPath.join(" "))).toEqual([
      "demo",
      "demo run",
      "ruff",
    ]);
    expect(result.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ commandPath: ["transitive"] })]),
    );
    expect(result.commands[0]).toEqual(
      expect.objectContaining({
        manager: "pnpm",
        packageName: "demo-package",
        autocompleteSource: "carapace",
      }),
    );
  });

  it("discovers only direct npm and Bun globals, never package dependencies", async () => {
    const bin = path.join(root, "bin");
    const npmRoot = path.join(root, "npm-node_modules");
    const bunRoot = path.join(root, "bun-global", "node_modules");
    const npmPackage = path.join(npmRoot, "npm-direct");
    const bunPackage = path.join(bunRoot, "bun-direct");
    await Promise.all([
      executable(path.join(bin, "npm")),
      executable(path.join(bin, "bun")),
      executable(path.join(bin, "carapace")),
      executable(path.join(npmPackage, "cli.js")),
      executable(path.join(bunPackage, "cli.js")),
      executable(path.join(bin, "transitive-cli")),
    ]);
    await Promise.all([
      symlink(path.join(npmPackage, "cli.js"), path.join(bin, "npm-cli")),
      symlink(path.join(bunPackage, "cli.js"), path.join(bin, "bun-cli")),
      writeFile(
        path.join(npmPackage, "package.json"),
        JSON.stringify({
          name: "npm-direct",
          version: "1.0.0",
          bin: { "npm-cli": "cli.js" },
          dependencies: { transitive: "1.0.0" },
        }),
      ),
      writeFile(
        path.join(bunPackage, "package.json"),
        JSON.stringify({
          name: "bun-direct",
          version: "2.0.0",
          bin: { "bun-cli": "cli.js" },
          dependencies: { transitive: "1.0.0" },
        }),
      ),
    ]);
    const outputs = new Map<string, string>([
      [
        "npm ls -g --depth=0 --json",
        JSON.stringify({ dependencies: { "npm-direct": { version: "1.0.0" } } }),
      ],
      ["npm root -g", npmRoot],
      ["npm prefix -g", path.dirname(bin)],
      ["bun pm ls -g", `${path.dirname(bunRoot)} node_modules (1)\n└── bun-direct@2.0.0\n`],
      ["bun pm bin -g", bin],
      [
        "carapace --list",
        JSON.stringify({ "npm-cli": [{}], "bun-cli": [{}], "transitive-cli": [{}] }),
      ],
      ["carapace npm-cli export", JSON.stringify({ Name: "npm-cli", Short: "Npm direct" })],
      ["carapace bun-cli export", JSON.stringify({ Name: "bun-cli", Short: "Bun direct" })],
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        return outputs.has(key)
          ? { stdout: outputs.get(key) ?? "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "npm-cli", manager: "npm", packageName: "npm-direct" }),
        expect.objectContaining({ name: "bun-cli", manager: "bun", packageName: "bun-direct" }),
      ]),
    );
    expect(result.commands.some((command) => command.name === "transitive-cli")).toBe(false);
  });

  it("keeps valid pnpm entries but marks a mixed-schema listing incomplete", async () => {
    const bin = path.join(root, "pnpm-partial-bin");
    const packagePath = path.join(root, "pnpm-partial", "known");
    await Promise.all([
      executable(path.join(bin, "pnpm")),
      executable(path.join(bin, "carapace")),
      executable(path.join(packagePath, "cli.js")),
    ]);
    await symlink(path.join(packagePath, "cli.js"), path.join(bin, "known"));
    await writeFile(
      path.join(packagePath, "package.json"),
      JSON.stringify({ name: "known-package", version: "1.0.0", bin: { known: "cli.js" } }),
    );
    const outputs = new Map<string, string>([
      ["pnpm bin -g", bin],
      [
        "pnpm list -g --depth=0 --json",
        JSON.stringify([
          {
            dependencies: {
              "known-package": { version: "1.0.0", path: packagePath },
              "changed-package": { version: "2.0.0" },
            },
          },
        ]),
      ],
      ["carapace --list", JSON.stringify({ known: [{}] })],
      ["carapace known export", JSON.stringify({ Name: "known", Short: "Known command" })],
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        return outputs.has(key)
          ? { stdout: outputs.get(key) ?? "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );

    expect(result.commands).toEqual([expect.objectContaining({ name: "known", manager: "pnpm" })]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join("\n")).toContain(
      "dependency changed-package has no absolute package path",
    );
  });

  it("drops explicitly installed commands that have no known autocomplete", async () => {
    const bin = path.join(root, "bin");
    await Promise.all([
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "unknown")),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "uv tool list --show-paths") {
          return {
            stdout: `unknown v1.0.0 (${root}/uv/unknown)\n- unknown (${bin}/unknown)\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "carapace --list") return { stdout: "{}", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual([]);
  });

  it("includes only direct project package bins and does not require node_modules/.bin on PATH", async () => {
    const bin = path.join(root, "bin");
    const project = path.join(root, "project");
    const direct = path.join(project, "node_modules", "direct");
    const nested = path.join(direct, "node_modules", "transitive");
    await Promise.all([
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "direct-cli")),
      executable(path.join(direct, "cli.js")),
    ]);
    await mkdir(path.join(project, "node_modules", ".bin"), { recursive: true });
    await symlink(
      path.join(direct, "cli.js"),
      path.join(project, "node_modules", ".bin", "direct-cli"),
    );
    await mkdir(direct, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.17.0", dependencies: { direct: "1.0.0" } }),
      "utf8",
    );
    await writeFile(
      path.join(direct, "package.json"),
      JSON.stringify({
        name: "direct",
        bin: { "direct-cli": "cli.js" },
        dependencies: { transitive: "1.0.0" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(nested, "package.json"),
      JSON.stringify({ name: "transitive", bin: { "transitive-cli": "cli.js" } }),
      "utf8",
    );
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "carapace --list")
          return {
            stdout: JSON.stringify({ "direct-cli": [{}], "transitive-cli": [{}] }),
            stderr: "",
            exitCode: 0,
          };
        if (key === "carapace direct-cli export")
          return {
            stdout: JSON.stringify({ Name: "direct-cli", Short: "Direct command" }),
            stderr: "",
            exitCode: 0,
          };
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: project, projectDir: project, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual([
      expect.objectContaining({
        commandPath: ["direct-cli"],
        scope: "project",
        manager: "pnpm",
        packageName: "direct",
        executablePath: path.join(project, "node_modules", ".bin", "direct-cli"),
      }),
    ]);
  });

  it("rejects a project .bin entry that does not point at the direct package's declared target", async () => {
    const bin = path.join(root, "bin");
    const project = path.join(root, "project-rogue-bin");
    const direct = path.join(project, "node_modules", "direct");
    const rogue = path.join(project, "rogue.js");
    await Promise.all([
      executable(path.join(bin, "carapace")),
      executable(path.join(direct, "cli.js")),
      executable(rogue),
      mkdir(path.join(project, "node_modules", ".bin"), { recursive: true }),
    ]);
    await symlink(rogue, path.join(project, "node_modules", ".bin", "direct-cli"));
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.17.0", dependencies: { direct: "1.0.0" } }),
    );
    await writeFile(
      path.join(direct, "package.json"),
      JSON.stringify({ name: "direct", bin: { "direct-cli": "cli.js" } }),
    );
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) =>
        `${path.basename(file)} ${args.join(" ")}` === "carapace --list"
          ? {
              stdout: JSON.stringify({ "direct-cli": [{}] }),
              stderr: "",
              exitCode: 0,
            }
          : { stdout: "", stderr: "", exitCode: 1 },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: project, projectDir: project, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.warnings.join("\n")).toContain("installed but not executable on PATH");
  });

  it("does not reinterpret a project declared for an unsupported package manager", async () => {
    const bin = path.join(root, "bin");
    const project = path.join(root, "project");
    const direct = path.join(project, "node_modules", "direct");
    await Promise.all([
      executable(path.join(bin, "carapace")),
      executable(path.join(direct, "cli.js")),
      mkdir(path.join(project, "node_modules", ".bin"), { recursive: true }),
    ]);
    await symlink(
      path.join(direct, "cli.js"),
      path.join(project, "node_modules", ".bin", "direct-cli"),
    );
    await Promise.all([
      writeFile(
        path.join(project, "package.json"),
        JSON.stringify({ packageManager: "yarn@4.0.0", dependencies: { direct: "1.0.0" } }),
      ),
      writeFile(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      writeFile(
        path.join(direct, "package.json"),
        JSON.stringify({ name: "direct", bin: { "direct-cli": "cli.js" } }),
      ),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) =>
        `${path.basename(file)} ${args.join(" ")}` === "carapace --list"
          ? {
              stdout: JSON.stringify({ "direct-cli": [{}] }),
              stderr: "",
              exitCode: 0,
            }
          : { stdout: "", stderr: "", exitCode: 1 },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: project, projectDir: project, env: { PATH: bin } },
      { runner },
    );

    expect(result.commands).toEqual([]);
  });

  it("uses bounded help probing only as a fallback when a trusted Carapace export is unavailable", async () => {
    const bin = path.join(root, "bin");
    await Promise.all([
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "terraform")),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "uv tool list --show-paths")
          return {
            stdout: `terraform v1.0.0 (${root}/uv/terraform)\n- terraform (${bin}/terraform)\n`,
            stderr: "",
            exitCode: 0,
          };
        if (key === "carapace --list")
          return { stdout: JSON.stringify({ terraform: [{}] }), stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "no export", exitCode: 1 };
      },
    };
    let probes = 0;
    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      {
        runner,
        probeHelp: async (executable) => {
          probes += 1;
          return {
            executable,
            warnings: [],
            nodes: [
              { commandPath: ["terraform"], description: "Infrastructure as code" },
              { commandPath: ["terraform", "plan"], description: "Show changes" },
            ],
          };
        },
      },
    );

    expect(probes).toBe(1);
    expect(result.commands.map((item) => item.name)).toEqual(["terraform", "terraform plan"]);
  });

  it("marks a broken structured autocomplete tree incomplete instead of freshening a root stub", async () => {
    const bin = path.join(root, "broken-carapace-bin");
    await Promise.all([
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "demo")),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "uv tool list --show-paths") {
          return {
            stdout: `demo v1.0.0 (${root}/uv/demo)\n- demo (${bin}/demo)\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "carapace --list") {
          return { stdout: JSON.stringify({ demo: [{}] }), stderr: "", exitCode: 0 };
        }
        if (key === "carapace demo export") {
          return { stdout: "not-json", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.complete).toBe(false);
    expect(result.commands.map((command) => command.name)).toEqual(["demo"]);
    expect(result.warnings.join("\n")).toContain("invalid JSON");
  });

  it("marks a partially malformed Carapace tree incomplete", async () => {
    const bin = path.join(root, "partial-carapace-bin");
    await Promise.all([
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "demo")),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "uv tool list --show-paths") {
          return {
            stdout: `demo v1.0.0 (${root}/uv/demo)\n- demo (${bin}/demo)\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "carapace --list") {
          return { stdout: JSON.stringify({ demo: [{}] }), stderr: "", exitCode: 0 };
        }
        if (key === "carapace demo export") {
          return {
            stdout: JSON.stringify({
              Name: "demo",
              Short: "Demo command",
              Commands: [{ Name: "valid", Short: "Valid command" }, { Short: "missing name" }],
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands.map((command) => command.name)).toEqual(["demo", "demo valid"]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join("\n")).toContain("incomplete tree");
  });

  it("accepts a direct manager install with a passive zsh completion", async () => {
    const bin = path.join(root, "bin");
    const fpath = path.join(root, "zsh-functions");
    await Promise.all([
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "demo")),
      mkdir(fpath, { recursive: true }),
    ]);
    await writeFile(path.join(fpath, "_demo"), "#compdef demo\n", "utf8");
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        if (`${path.basename(file)} ${args.join(" ")}` === "uv tool list --show-paths") {
          return {
            stdout: `demo v1.0.0 (${root}/uv/demo)\n- demo (${bin}/demo)\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin, FPATH: fpath } },
      { runner },
    );

    expect(result.commands).toEqual([
      expect.objectContaining({
        name: "demo",
        manager: "uv",
        autocompleteSource: "zsh-completion",
        metadataSource: "zsh-completion",
      }),
    ]);
  });

  it("uses Homebrew installed_on_request receipts and never promotes arbitrary PATH entries", async () => {
    const prefix = path.join(root, "homebrew");
    const bin = path.join(prefix, "bin");
    const rogueBin = path.join(root, "rogue-bin");
    const directKeg = path.join(prefix, "Cellar", "direct", "1.0.0");
    const dependencyKeg = path.join(prefix, "Cellar", "dependency", "2.0.0");
    await Promise.all([
      executable(path.join(bin, "brew")),
      executable(path.join(bin, "carapace")),
      executable(path.join(directKeg, "bin", "direct")),
      executable(path.join(dependencyKeg, "bin", "dependency")),
      executable(path.join(rogueBin, "rogue")),
    ]);
    await Promise.all([
      symlink(path.join(directKeg, "bin", "direct"), path.join(bin, "direct")),
      symlink(path.join(dependencyKeg, "bin", "dependency"), path.join(bin, "dependency")),
      writeFile(
        path.join(directKeg, "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: true, source: { version: "1.0.0" } }),
      ),
      writeFile(
        path.join(dependencyKeg, "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: false, source: { version: "2.0.0" } }),
      ),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "carapace --list") {
          return {
            stdout: JSON.stringify({ direct: [{}], dependency: [{}], rogue: [{}] }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "carapace direct export") {
          return {
            stdout: JSON.stringify({ Name: "direct", Short: "Direct formula" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      {
        cwd: root,
        projectDir: null,
        env: { PATH: `${rogueBin}${path.delimiter}${bin}` },
      },
      { runner },
    );

    expect(result.commands.map((item) => item.name)).toEqual(["direct"]);
    expect(result.commands[0]).toEqual(
      expect.objectContaining({ manager: "homebrew", packageName: "direct" }),
    );
  });

  it("keeps only directly requested Homebrew casks that expose autocomplete", async () => {
    const prefix = path.join(root, "homebrew-casks");
    const bin = path.join(prefix, "bin");
    const directCask = path.join(prefix, "Caskroom", "direct-cask", "1.0.0");
    const dependencyCask = path.join(prefix, "Caskroom", "dependency-cask", "2.0.0");
    await Promise.all([
      executable(path.join(bin, "brew")),
      executable(path.join(bin, "carapace")),
      executable(path.join(directCask, "direct-cask")),
      executable(path.join(dependencyCask, "dependency-cask")),
    ]);
    await Promise.all([
      symlink(path.join(directCask, "direct-cask"), path.join(bin, "direct-cask")),
      symlink(path.join(dependencyCask, "dependency-cask"), path.join(bin, "dependency-cask")),
      mkdir(path.join(prefix, "Caskroom", "direct-cask", ".metadata"), { recursive: true }),
      mkdir(path.join(prefix, "Caskroom", "dependency-cask", ".metadata"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(prefix, "Caskroom", "direct-cask", ".metadata", "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: true, source: { version: "1.0.0" } }),
      ),
      writeFile(
        path.join(prefix, "Caskroom", "dependency-cask", ".metadata", "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: false, source: { version: "2.0.0" } }),
      ),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "carapace --list") {
          return {
            stdout: JSON.stringify({ "direct-cask": [{}], "dependency-cask": [{}] }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "carapace direct-cask export") {
          return {
            stdout: JSON.stringify({ Name: "direct-cask", Short: "Direct cask" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );

    expect(result.commands).toEqual([
      expect.objectContaining({
        name: "direct-cask",
        manager: "homebrew",
        packageName: "direct-cask",
      }),
    ]);
  });

  it("resolves the Intel Homebrew repository symlink back to the /usr/local-style prefix", async () => {
    const prefix = path.join(root, "usr-local");
    const bin = path.join(prefix, "bin");
    const repositoryBrew = path.join(prefix, "Homebrew", "bin", "brew");
    const keg = path.join(prefix, "Cellar", "direct", "1.0.0");
    await Promise.all([
      executable(repositoryBrew),
      executable(path.join(bin, "carapace")),
      executable(path.join(keg, "bin", "direct")),
    ]);
    await Promise.all([
      symlink(repositoryBrew, path.join(bin, "brew")),
      symlink(path.join(keg, "bin", "direct"), path.join(bin, "direct")),
      writeFile(
        path.join(keg, "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: true, source: { version: "1.0.0" } }),
      ),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "carapace --list") {
          return { stdout: JSON.stringify({ direct: [{}] }), stderr: "", exitCode: 0 };
        }
        if (key === "carapace direct export") {
          return {
            stdout: JSON.stringify({ Name: "direct", Short: "Direct formula" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );

    expect(result.commands).toEqual([
      expect.objectContaining({ name: "direct", manager: "homebrew", packageName: "direct" }),
    ]);
  });

  it("selects the manager whose same-named executable is actually active on PATH", async () => {
    const brewPrefix = path.join(root, "homebrew-collision");
    const brewBin = path.join(brewPrefix, "bin");
    const brewKeg = path.join(brewPrefix, "Cellar", "dual", "1.0.0");
    const npmPrefix = path.join(root, "npm-collision");
    const npmBin = path.join(npmPrefix, "bin");
    const npmRoot = path.join(npmPrefix, "lib", "node_modules");
    const npmPackage = path.join(npmRoot, "dual-package");
    await Promise.all([
      executable(path.join(brewBin, "brew")),
      executable(path.join(brewKeg, "bin", "dual")),
      executable(path.join(npmBin, "npm")),
      executable(path.join(npmBin, "carapace")),
      executable(path.join(npmPackage, "cli.js")),
    ]);
    await Promise.all([
      symlink(path.join(brewKeg, "bin", "dual"), path.join(brewBin, "dual")),
      symlink(path.join(npmPackage, "cli.js"), path.join(npmBin, "dual")),
      writeFile(
        path.join(brewKeg, "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: true, source: { version: "1.0.0" } }),
      ),
      writeFile(
        path.join(npmPackage, "package.json"),
        JSON.stringify({ name: "dual-package", version: "2.0.0", bin: { dual: "cli.js" } }),
      ),
    ]);
    const outputs = new Map<string, string>([
      [
        "npm ls -g --depth=0 --json",
        JSON.stringify({ dependencies: { "dual-package": { version: "2.0.0" } } }),
      ],
      ["npm root -g", npmRoot],
      ["npm prefix -g", npmPrefix],
      ["carapace --list", JSON.stringify({ dual: [{}] })],
      ["carapace dual export", JSON.stringify({ Name: "dual", Short: "Active dual" })],
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        return outputs.has(key)
          ? { stdout: outputs.get(key) ?? "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      {
        cwd: root,
        projectDir: null,
        env: { PATH: `${npmBin}${path.delimiter}${brewBin}` },
      },
      { runner },
    );

    expect(result.commands).toEqual([
      expect.objectContaining({ name: "dual", manager: "npm", packageName: "dual-package" }),
    ]);
  });

  it("fails closed when a Homebrew receipt omits installed_on_request", async () => {
    const prefix = path.join(root, "homebrew-invalid-receipt");
    const bin = path.join(prefix, "bin");
    const keg = path.join(prefix, "Cellar", "direct", "1.0.0");
    await Promise.all([
      executable(path.join(bin, "brew")),
      executable(path.join(bin, "carapace")),
      executable(path.join(keg, "bin", "direct")),
    ]);
    await symlink(path.join(keg, "bin", "direct"), path.join(bin, "direct"));
    await writeFile(
      path.join(keg, "INSTALL_RECEIPT.json"),
      JSON.stringify({ source: { version: "1.0.0" } }),
    );
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        if (`${path.basename(file)} ${args.join(" ")}` === "carapace --list") {
          return { stdout: JSON.stringify({ direct: [{}] }), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join("\n")).toContain("installed_on_request is not a boolean");
  });

  it("accepts a requested Homebrew formula through its linked native completion", async () => {
    const prefix = path.join(root, "homebrew-completion");
    const bin = path.join(prefix, "bin");
    const keg = path.join(prefix, "Cellar", "direct", "1.0.0");
    const completions = path.join(prefix, "share", "zsh", "site-functions");
    await Promise.all([
      executable(path.join(bin, "brew")),
      executable(path.join(keg, "bin", "direct")),
      mkdir(completions, { recursive: true }),
    ]);
    await symlink(path.join(keg, "bin", "direct"), path.join(bin, "direct"));
    await Promise.all([
      writeFile(
        path.join(keg, "INSTALL_RECEIPT.json"),
        JSON.stringify({ installed_on_request: true, source: { version: "1.0.0" } }),
      ),
      writeFile(path.join(completions, "_direct"), "#compdef direct\n"),
    ]);

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner: { run: async () => ({ stdout: "", stderr: "", exitCode: 1 }) } },
    );
    expect(result.commands).toEqual([
      expect.objectContaining({
        name: "direct",
        manager: "homebrew",
        autocompleteSource: "homebrew-completion",
      }),
    ]);
  });

  it("does not route a same-named PATH shadow instead of the manager-owned executable", async () => {
    const prefix = path.join(root, "homebrew-shadow");
    const bin = path.join(prefix, "bin");
    const rogueBin = path.join(root, "shadow-first");
    const keg = path.join(prefix, "Cellar", "direct", "1.0.0");
    await Promise.all([
      executable(path.join(bin, "brew")),
      executable(path.join(bin, "carapace")),
      executable(path.join(keg, "bin", "direct")),
      executable(path.join(rogueBin, "direct")),
    ]);
    await symlink(path.join(keg, "bin", "direct"), path.join(bin, "direct"));
    await writeFile(
      path.join(keg, "INSTALL_RECEIPT.json"),
      JSON.stringify({ installed_on_request: true, source: { version: "1.0.0" } }),
    );
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "carapace --list") {
          return { stdout: JSON.stringify({ direct: [{}] }), stderr: "", exitCode: 0 };
        }
        if (key === "carapace direct export") {
          return {
            stdout: JSON.stringify({ Name: "direct", Short: "Direct formula" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      {
        cwd: root,
        projectDir: null,
        env: { PATH: `${rogueBin}${path.delimiter}${bin}` },
      },
      { runner },
    );
    expect(result.commands).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.warnings.join("\n")).toContain("installed but not executable on PATH");
  });

  it("marks unrecognised successful manager output incomplete instead of clearing cache", async () => {
    const bin = path.join(root, "bin-malformed");
    await Promise.all([
      executable(path.join(bin, "uv")),
      executable(path.join(bin, "carapace")),
      executable(path.join(bin, "known")),
    ]);
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "uv tool list --show-paths") {
          return {
            stdout: `known v1.0.0 (${root}/known)\n- known (${bin}/known)\nnew-schema-without-known-fields\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "carapace --list") {
          return { stdout: JSON.stringify({ known: [{}] }), stderr: "", exitCode: 0 };
        }
        if (key === "carapace known export") {
          return {
            stdout: JSON.stringify({ Name: "known", Short: "Known command" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual([expect.objectContaining({ name: "known", manager: "uv" })]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join("\n")).toContain("unrecognised non-empty output");
  });

  it("marks a partially parseable Bun listing incomplete", async () => {
    const bin = path.join(root, "bun-malformed-bin");
    const bunRoot = path.join(root, "bun-malformed", "node_modules");
    const packagePath = path.join(bunRoot, "known-bun");
    await Promise.all([
      executable(path.join(bin, "bun")),
      executable(path.join(bin, "carapace")),
      executable(path.join(packagePath, "cli.js")),
    ]);
    await symlink(path.join(packagePath, "cli.js"), path.join(bin, "known-bun"));
    await writeFile(
      path.join(packagePath, "package.json"),
      JSON.stringify({ name: "known-bun", version: "1.0.0", bin: { "known-bun": "cli.js" } }),
    );
    const runner: TrustedCommandRunner = {
      run: async ({ executable: file, args }) => {
        const key = `${path.basename(file)} ${args.join(" ")}`;
        if (key === "bun pm ls -g") {
          return {
            stdout: `${path.dirname(bunRoot)} node_modules (1)\n└── known-bun@1.0.0\nchanged-format\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (key === "bun pm bin -g") return { stdout: bin, stderr: "", exitCode: 0 };
        if (key === "carapace --list") {
          return { stdout: JSON.stringify({ "known-bun": [{}] }), stderr: "", exitCode: 0 };
        }
        if (key === "carapace known-bun export") {
          return {
            stdout: JSON.stringify({ Name: "known-bun", Short: "Known Bun command" }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    };

    const result = await discoverInstalledCliCommands(
      { cwd: root, projectDir: null, env: { PATH: bin } },
      { runner },
    );
    expect(result.commands).toEqual([
      expect.objectContaining({ name: "known-bun", manager: "bun" }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.warnings.join("\n")).toContain("bun pm ls -g: unrecognised non-empty output");
  });
});
