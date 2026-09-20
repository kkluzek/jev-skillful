import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TrustedExecutableOptions {
  projectDir?: string | null;
  cwd?: string;
}

/**
 * Resolve a metadata-provider executable without allowing a repository-local PATH entry to run.
 * The target CLI itself is resolved separately because project package bins are valid discovery
 * subjects; package managers, completion providers, and owning clients are not.
 */
export async function trustedExecutableOnPath(
  name: string,
  rawPath: string | undefined,
  options: TrustedExecutableOptions = {},
): Promise<string | null> {
  if (rawPath === undefined) return null;
  const unsafeRoots = [options.projectDir, os.tmpdir()]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => path.resolve(value));

  for (const rawRoot of rawPath.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(rawRoot)) continue;
    const root = path.resolve(rawRoot);
    const candidate = path.join(root, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      const resolved = await realpath(candidate);
      if (
        isUnsafeProviderPath(candidate, unsafeRoots) ||
        isUnsafeProviderPath(resolved, unsafeRoots)
      ) {
        continue;
      }
      return candidate;
    } catch {
      // Continue to the next absolute PATH entry.
    }
  }
  return null;
}

export function isUnsafeProviderPath(file: string, unsafeRoots: readonly string[]): boolean {
  const resolved = path.resolve(file);
  const segments = resolved.split(path.sep);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === "node_modules" && segments[index + 1] === ".bin") return true;
    if (segments[index] === ".venv" && segments[index + 1] === "bin") return true;
  }
  return unsafeRoots.some((root) => isWithin(resolved, root));
}

function isWithin(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
