import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveredExecutable } from "./cli.js";
import {
  type HelpProcessRunner,
  probeCliHelp,
  SandboxedHelpProcessRunner,
  SandboxUnavailableError,
  spawnBounded,
} from "./probe.js";

const executable: DiscoveredExecutable = {
  name: "gh",
  path: "/usr/local/bin/gh",
  realPath: "/opt/homebrew/bin/gh",
  scope: "global",
  shadowed: [],
};

describe("probeCliHelp", () => {
  it("recurses breadth-first with hard depth and node limits", async () => {
    const calls: string[][] = [];
    const runner: HelpProcessRunner = {
      async run(request) {
        calls.push(request.args);
        const command = request.args.filter((arg) => arg !== "--help").join(" ");
        if (command === "") {
          return {
            stdout:
              "GitHub CLI\nCommands:\n  pr  Work with pull requests\n  issue  Work with issues\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (command === "pr") {
          return {
            stdout:
              "Pull requests\nCommands:\n  view  View a pull request\n  list  List pull requests\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: `${command} command\n`, stderr: "", exitCode: 0 };
      },
    };

    const tree = await probeCliHelp(executable, { maxDepth: 2, maxNodes: 4 }, runner);
    expect(tree.nodes.map((node) => node.commandPath.join(" "))).toEqual([
      "gh",
      "gh pr",
      "gh issue",
      "gh pr view",
    ]);
    expect(calls).toEqual([
      ["--help"],
      ["pr", "--help"],
      ["issue", "--help"],
      ["pr", "view", "--help"],
    ]);
  });

  it("refuses unsupported dispatchers even when explicitly named", async () => {
    await expect(
      probeCliHelp(
        { ...executable, name: "npm" },
        {},
        { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
      ),
    ).rejects.toThrow(/no trusted help adapter/i);
  });

  it("reports missing containment without running the executable", async () => {
    let ran = false;
    const runner: HelpProcessRunner = {
      async run() {
        ran = true;
        throw new SandboxUnavailableError("no sandbox");
      },
    };
    await expect(probeCliHelp(executable, {}, runner)).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(ran).toBe(true);
  });

  it("reports when subcommands are truncated by the depth safety limit", async () => {
    const tree = await probeCliHelp(
      executable,
      { maxDepth: 0 },
      {
        run: async () => ({
          stdout: "GitHub CLI\nCommands:\n  repo  Work with repositories\n",
          stderr: "",
          exitCode: 0,
        }),
      },
    );

    expect(tree.nodes).toHaveLength(1);
    expect(tree.warnings.join("\n")).toContain("truncated at depth 0");
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
    "denies real help-process reads from HOME and writes outside its private temp directory",
    async () => {
      const protectedRoot = mkdtempSync(path.join(os.homedir(), ".skillful-sandbox-test-"));
      const executableRoot = mkdtempSync(path.join(os.tmpdir(), "skillful-probe-executable-"));
      const secret = path.join(protectedRoot, "secret.txt");
      const outsideWrite = path.join(protectedRoot, "created.txt");
      const script = path.join(executableRoot, "probe.sh");
      try {
        writeFileSync(secret, "sandbox-secret\n");
        writeFileSync(
          script,
          '#!/bin/sh\nif value=$(/bin/cat "$1"); then echo READ_ALLOWED:$value; else echo READ_DENIED; fi\nif echo escaped >"$2"; then echo WRITE_ALLOWED; else echo WRITE_DENIED; fi\n',
        );
        chmodSync(script, 0o700);

        const result = await new SandboxedHelpProcessRunner().run({
          executable: script,
          args: [secret, outsideWrite],
          timeoutMs: 2_000,
          maxOutputBytes: 16_384,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("READ_DENIED");
        expect(result.stdout).toContain("WRITE_DENIED");
        expect(existsSync(outsideWrite)).toBe(false);
      } finally {
        rmSync(protectedRoot, { recursive: true, force: true });
        rmSync(executableRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(
    process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec") ||
      !existsSync("/usr/bin/nc"),
  )("denies a real help-process connection to a local TCP listener", async () => {
    const executableRoot = mkdtempSync(path.join(os.tmpdir(), "skillful-probe-network-"));
    const script = path.join(executableRoot, "network.sh");
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing TCP port");
      writeFileSync(
        script,
        '#!/bin/sh\nif /usr/bin/nc -z 127.0.0.1 "$1"; then echo NETWORK_ALLOWED; else echo NETWORK_DENIED; fi\n',
      );
      chmodSync(script, 0o700);

      const result = await new SandboxedHelpProcessRunner().run({
        executable: script,
        args: [String(address.port)],
        timeoutMs: 2_000,
        maxOutputBytes: 16_384,
      });

      expect(result.stdout).toContain("NETWORK_DENIED");
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(executableRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "enforces the real timeout and kills the spawned process group",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "skillful-probe-timeout-"));
      const script = path.join(root, "hang.sh");
      const pidFile = path.join(root, "child.pid");
      try {
        writeFileSync(
          script,
          '#!/bin/sh\nif [ "$1" = child ]; then trap "" TERM; /bin/sleep 30; exit; fi\n"$0" child &\necho $! >"$1"\nwait\n',
        );
        chmodSync(script, 0o700);

        await expect(spawnBounded(script, [pidFile], root, 500, 16_384)).rejects.toThrow(
          "timed out",
        );
        const childPid = Number(readFileSync(pidFile, "utf8").trim());
        let alive = true;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            process.kill(childPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch {
            alive = false;
            break;
          }
        }
        expect(alive).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("enforces the real output limit", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skillful-probe-output-"));
    const script = path.join(root, "flood.sh");
    try {
      writeFileSync(script, '#!/bin/sh\nwhile :; do echo "01234567890123456789"; done\n');
      chmodSync(script, 0o700);
      await expect(spawnBounded(script, [], root, 2_000, 1_024)).rejects.toThrow(
        "output exceeded 1024 bytes",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
