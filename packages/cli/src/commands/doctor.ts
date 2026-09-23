/**
 * `skillful doctor` — one command that answers "is this actually working?".
 *
 * Read-only by design. A diagnostic that repairs things is not a diagnostic: the user cannot
 * trust a report from a tool that changed the state it is describing. Doctor inspects, runs one
 * real route to measure latency, and prints what it found — including the parts that are wrong.
 *
 * This is also where the failures that the hook deliberately hides end up. The hook swallows
 * every error so it can never disturb an agent session; doctor is the place a user goes to see
 * them.
 */

import { scanCatalog } from "../core/catalog/scan.js";
import { isAdaptiveDisabled } from "../core/hooks/adaptive.js";
import { loadCache } from "../core/hooks/cache.js";
import { hookStatus } from "../core/hooks/install.js";
import { renderInjection } from "../core/hooks/render.js";
import {
  DISABLE_ENV,
  defaultCachePath,
  isDisabled,
  resolveForReport,
} from "../core/hooks/runner.js";
import { type JevTarget, resolveJevTarget } from "../core/jev/client.js";
import { route } from "../core/router/route.js";

export interface DoctorCommandOptions {
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  json?: boolean;
  /** Skip the live route trial. Useful offline; the report says the check did not run. */
  offline?: boolean;
}

interface DoctorReport {
  ok: boolean;
  checks: { name: string; status: "ok" | "warn" | "fail" | "skipped"; detail: string }[];
  runtimes: ReturnType<typeof hookStatus>;
  configPath: string;
  configWarnings: string[];
  catalog: {
    entries: number;
    fingerprint: string;
    warnings: number;
    warningDetails: string[];
  } | null;
  cache: { path: string; entries: number } | null;
  trial: { injected: boolean; latencyMs: number; decision: string; text: string | null } | null;
}

/** A prompt that exercises the whole path without depending on the user's catalog contents. */
const TRIAL_PROMPT = "refactor the authentication middleware to support refresh tokens";

export async function doctorCommand(options: DoctorCommandOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env["HOME"] ?? ".";
  const cwd = options.cwd ?? process.cwd();

  const checks: DoctorReport["checks"] = [];

  const disabled = isDisabled(env);
  checks.push({
    name: "hook enabled",
    status: disabled ? "warn" : "ok",
    detail: disabled
      ? `${DISABLE_ENV} is set. The hook will inject nothing until it is unset.`
      : "Hook is enabled.",
  });

  const resolved = resolveForReport(env, homeDir);
  let target: JevTarget | undefined;
  let providerError: string | undefined;
  try {
    target = resolveJevTarget({
      provider: resolved.config.provider,
      env,
      baseUrl: resolved.config.baseUrl,
      model: resolved.config.model,
    });
  } catch (error) {
    providerError = (error as Error).message;
  }
  const hasKey = target !== undefined;
  checks.push({
    name: "Jev provider",
    status: hasKey ? "ok" : "fail",
    detail:
      target !== undefined
        ? `${target.provider} selected with ${target.apiKeyEnv}.`
        : `${providerError ?? "No provider credential found"} Routing will degrade to a reminder until it is fixed. Skillful reads keys only from the environment and never writes them to disk.`,
  });

  for (const warning of resolved.warnings) {
    checks.push({ name: "config", status: "warn", detail: warning });
  }

  const runtimes = hookStatus(homeDir, env);
  const installedCount = runtimes.filter((entry) => entry.installed).length;
  checks.push({
    name: "runtime hooks",
    status: installedCount > 0 ? "ok" : "warn",
    detail:
      installedCount > 0
        ? `${installedCount} of ${runtimes.length} supported runtimes have a Skillful hook.`
        : "No Skillful hook installed. Run: skillful install",
  });
  const claude = runtimes.find((entry) => entry.runtime === "claude-code");
  if (claude?.present === true) {
    const adaptiveDisabled = isAdaptiveDisabled(env);
    checks.push({
      name: "Claude adaptive hooks",
      status: !claude.installed ? "fail" : adaptiveDisabled ? "warn" : "ok",
      detail: !claude.installed
        ? claude.detail
        : adaptiveDisabled
          ? "SKILLFUL_ADAPTIVE disables PostToolBatch and SubagentStart recommendations."
          : "PostToolBatch, SubagentStart, SessionEnd and refresh hooks are installed and enabled.",
    });
  }

  let catalog: DoctorReport["catalog"] = null;
  try {
    const scanned = await scanCatalog({ homeDir, cwd, env });
    catalog = {
      entries: scanned.entries.length,
      fingerprint: scanned.fingerprint.slice(0, 12),
      warnings: scanned.warnings.length,
      warningDetails: scanned.warnings.slice(0, 50),
    };
    checks.push({
      name: "catalog",
      status: scanned.entries.length > 0 && scanned.warnings.length === 0 ? "ok" : "warn",
      detail:
        scanned.entries.length > 0 && scanned.warnings.length > 0
          ? `${scanned.entries.length} capabilities found; ${scanned.warnings.length} discovery warnings. First: ${scanned.warnings[0]}`
          : scanned.entries.length > 0
            ? `${scanned.entries.length} capabilities found.`
            : "No capabilities found. Nothing can be routed until something is installed.",
    });
  } catch (error) {
    checks.push({
      name: "catalog",
      status: "fail",
      detail: `Catalog scan failed: ${(error as Error).message}`,
    });
  }

  const cachePath = defaultCachePath(homeDir);
  const store = loadCache(cachePath);
  const cacheEntries = Object.keys(store.entries).length;

  let trial: DoctorReport["trial"] = null;
  if (options.offline === true) {
    checks.push({
      name: "live route",
      status: "skipped",
      detail: "--offline: trial route not run.",
    });
  } else if (!hasKey) {
    checks.push({
      name: "live route",
      status: "skipped",
      detail: "No API key, so no route was attempted.",
    });
  } else if (catalog !== null) {
    const scanned = await scanCatalog({ homeDir, cwd, env });
    const startedAt = Date.now();
    const result = await route(TRIAL_PROMPT, {
      entries: scanned.entries,
      thresholds: resolved.config.thresholds,
      quotaGroups: resolved.config.quotaGroups,
      provider: resolved.config.provider,
      model: resolved.config.model,
      baseUrl: resolved.config.baseUrl,
      uploadPrompt: resolved.config.uploadPrompt,
      jev: { env },
    });
    const elapsed = Date.now() - startedAt;
    const text = renderInjection(result);

    trial = {
      injected: text !== null,
      latencyMs: elapsed,
      decision: result.decision.kind,
      text,
    };

    checks.push({
      name: "live route",
      status: result.decision.kind === "degraded" ? "fail" : "ok",
      detail:
        result.decision.kind === "degraded"
          ? `Route degraded (${result.decision.reason}): ${result.decision.detail ?? ""}`
          : `Route completed in ${elapsed}ms with decision "${result.decision.kind}".`,
    });

    checks.push({
      name: "latency budget",
      status: elapsed <= resolved.config.thresholds.budgetMs ? "ok" : "fail",
      detail: `Trial route took ${elapsed}ms against a ${resolved.config.thresholds.budgetMs}ms budget.`,
    });
  }

  const ok = !checks.some((check) => check.status === "fail");
  const report: DoctorReport = {
    ok,
    checks,
    runtimes,
    configPath: resolved.configPath,
    configWarnings: resolved.warnings,
    catalog,
    cache: { path: cachePath, entries: cacheEntries },
    trial,
  };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  process.stdout.write(`${renderDoctor(report)}\n`);
  return ok ? 0 : 1;
}

/** Human-readable report. Kept here rather than inline so tests can assert on it. */
export function renderDoctor(report: DoctorReport): string {
  const out: string[] = [];
  const mark: Record<string, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skipped: "--  " };

  out.push(report.ok ? "Skillful doctor: healthy" : "Skillful doctor: problems found");
  out.push("");

  for (const check of report.checks) {
    out.push(`  [${mark[check.status] ?? "?   "}] ${check.name}: ${check.detail}`);
  }

  out.push("");
  out.push("  Runtimes:");
  for (const entry of report.runtimes) {
    const state = !entry.present ? "not found" : entry.installed ? "hooked" : "present, no hook";
    out.push(`    ${entry.runtime}: ${state}`);
    if (entry.present) out.push(`      ${entry.target}`);
  }

  out.push("");
  out.push(`  Config file: ${report.configPath}`);
  if (report.catalog !== null) {
    out.push(
      `  Catalog: ${report.catalog.entries} entries, fingerprint ${report.catalog.fingerprint}`,
    );
    for (const warning of report.catalog.warningDetails) out.push(`    warning: ${warning}`);
  }
  if (report.cache !== null) {
    out.push(`  Cache: ${report.cache.entries} entries at ${report.cache.path}`);
  }

  if (report.trial !== null) {
    out.push("");
    out.push(`  Trial route (${report.trial.latencyMs}ms, ${report.trial.decision}):`);
    out.push(`    ${report.trial.text ?? "(nothing would be injected)"}`);
  }

  return out.join("\n");
}
