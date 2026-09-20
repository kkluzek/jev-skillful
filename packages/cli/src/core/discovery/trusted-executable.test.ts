import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustedExecutableOnPath } from "./trusted-executable.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trustedExecutableOnPath", () => {
  it("skips a hostile first PATH entry and continues to a trusted system executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skillful-provider-"));
    roots.push(root);
    const hostile = path.join(root, "sh");
    await mkdir(root, { recursive: true });
    await writeFile(hostile, "#!/bin/sh\nexit 99\n", "utf8");
    await chmod(hostile, 0o755);

    await expect(
      trustedExecutableOnPath("sh", `${root}${path.delimiter}/bin`, { cwd: root }),
    ).resolves.toBe("/bin/sh");
  });

  it("rejects repository-local node_modules and virtualenv providers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skillful-provider-"));
    roots.push(root);
    for (const bin of [path.join(root, "node_modules", ".bin"), path.join(root, ".venv", "bin")]) {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(path.join(bin, "codex"), 0o755);
    }
    await expect(
      trustedExecutableOnPath(
        "codex",
        `${path.join(root, "node_modules", ".bin")}${path.delimiter}${path.join(root, ".venv", "bin")}`,
        { projectDir: root },
      ),
    ).resolves.toBeNull();
  });
});
