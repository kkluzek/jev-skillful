/**
 * Install the hook into `~/.claude/settings.json`.
 *
 * Claude Code's contract, verified against the settings already on this machine: a hook
 * definition is `{matcher, hooks: [{type: "command", command}]}` inside `hooks.UserPromptSubmit`,
 * and the command receives the event JSON on stdin and answers with
 * `hookSpecificOutput.additionalContext` on stdout.
 *
 * The settings file is shared. It already held fourteen hook events and other tools' entries
 * before this installer ran, so the only safe operation is: read everything, remove exactly
 * our own entries, append ours, write it back atomically behind a backup.
 */

import path from "node:path";
import type { CatalogRuntime } from "../../catalog/types.js";
import { claudeConfigDir } from "../../claude-config.js";
import { installJsonHook, type JsonHookSpec, uninstallJsonHook } from "./json-hook.js";
import type { InstallContext, InstallOutcome, UninstallOutcome } from "./types.js";

const RUNTIME: CatalogRuntime = "claude-code";

export const CLAUDE_MANAGED_HOOK_EVENTS = [
  "UserPromptSubmit",
  "SessionStart",
  "PostCompact",
  "PostToolBatch",
  "SubagentStart",
  "SessionEnd",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
] as const;

function spec(ctx: InstallContext): JsonHookSpec {
  return {
    runtime: RUNTIME,
    target: path.join(claudeConfigDir(ctx.homeDir, ctx.env), "settings.json"),
    events: CLAUDE_MANAGED_HOOK_EVENTS,
  };
}

export function installClaudeCode(ctx: InstallContext): InstallOutcome {
  return installJsonHook(ctx, spec(ctx));
}

export function uninstallClaudeCode(ctx: InstallContext): UninstallOutcome {
  return uninstallJsonHook(ctx, spec(ctx));
}
