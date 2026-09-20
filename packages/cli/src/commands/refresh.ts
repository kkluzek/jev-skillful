import type { CatalogRuntime } from "../core/catalog/types.js";
import { CapabilityRefreshMarkerError } from "../core/discovery/cache.js";
import {
  type RefreshCapabilitiesOptions,
  type RefreshReport,
  refreshCapabilities,
} from "../core/discovery/refresh.js";
import { isDisabled } from "../core/hooks/runner.js";

export interface RefreshCommandOptions {
  runtimes: readonly Extract<CatalogRuntime, "codex" | "claude-code">[];
  includeCli: boolean;
  includeMcp: boolean;
  json: boolean;
  quiet: boolean;
  /** Session-start hooks must never block client startup on discovery failures. */
  managed: boolean;
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RefreshCommandDependencies {
  refresh?: (options: RefreshCapabilitiesOptions) => Promise<RefreshReport>;
}

/** Explicit/session-start refresh. Prompt routing only reads the cache written here. */
export async function refreshCommand(
  options: RefreshCommandOptions,
  dependencies: RefreshCommandDependencies = {},
): Promise<number> {
  const env = options.env ?? process.env;
  if (env["SKILLFUL_DISCOVERY_NESTED"] === "1") return 0;
  if (options.managed && isDisabled(env)) return 0;
  let report: RefreshReport;
  try {
    report = await (dependencies.refresh ?? refreshCapabilities)({
      homeDir: options.homeDir ?? env["HOME"] ?? ".",
      cwd: options.cwd ?? process.cwd(),
      env,
      ...(options.runtimes.length === 0 ? {} : { runtimes: options.runtimes }),
      includeCli: options.includeCli,
      includeMcp: options.includeMcp,
      // Claude and Codex can start together. A fail-closed marker hides the queued runtime's old
      // cache immediately; this longer wait then lets both background jobs normally finish while
      // leaving five minutes of the SessionStart budget for live discovery after the lock.
      ...(options.managed ? { lockWaitMs: 600_000 } : {}),
    });
  } catch (error) {
    if (error instanceof CapabilityRefreshMarkerError) {
      process.stderr.write(`error: capability refresh safety marker failed: ${error.message}\n`);
      return 2;
    }
    if (!options.managed && !options.quiet) {
      process.stderr.write(`error: capability refresh failed: ${(error as Error).message}\n`);
    }
    return options.managed ? 0 : 2;
  }

  if (!options.quiet) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Refreshed ${report.entriesWritten} capabilities in ${report.partitionsUpdated} partitions.\n`,
      );
      process.stdout.write(`Cache: ${report.cachePath}\n`);
      for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
      for (const failure of report.failures) {
        process.stderr.write(`warning: ${failure.partition}: ${failure.message}\n`);
      }
    }
  }

  // Managed background hooks preserve startup. Explicit refreshes expose incomplete inventories.
  return options.managed || report.failures.length === 0 ? 0 : 2;
}
