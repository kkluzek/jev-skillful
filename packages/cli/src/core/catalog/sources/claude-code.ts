import path from "node:path";
import { claudeConfigDir, claudeStatePath } from "../../claude-config.js";
import {
  collectMarkdownItems,
  collectMarkdownRecursive,
  collectSkillFiles,
  describeMcpServer,
  readMarkdownItem,
  readMcpJsonFile,
  readSkillParts,
  serversFromRecord,
} from "../collect.js";
import { readJsonSafe } from "../fsx.js";
import {
  type CatalogEntry,
  type CatalogScope,
  type CatalogSource,
  catalogId,
  normaliseDescription,
  type ScanContext,
} from "../types.js";

/**
 * Claude Code surfaces.
 *
 * Verified layout under `~/.claude`:
 * - `skills/<name>/SKILL.md` with YAML frontmatter carrying `name` and `description`
 * - `agents/<name>.md`, `commands/**<name>.md`
 *
 * MCP servers live outside that tree, in Claude's state JSON as a `mcpServers` map plus
 * a per-project `projects[<path>].mcpServers` map, and in a project-local `.mcp.json`.
 */

interface ClaudeJson {
  mcpServers?: unknown;
  projects?: Record<
    string,
    {
      mcpServers?: unknown;
      enabledMcpjsonServers?: unknown;
      disabledMcpjsonServers?: unknown;
    }
  >;
}

export const claudeCodeSource: CatalogSource = {
  runtime: "claude-code",
  async scan(ctx) {
    const entries: CatalogEntry[] = [];
    const globalRoot = claudeConfigDir(ctx.homeDir, ctx.env);
    const projectRoot = ctx.projectDir === null ? null : path.join(ctx.projectDir, ".claude");

    for (const [root, scope] of [
      [globalRoot, "global"],
      [projectRoot, "project"],
    ] as const) {
      if (root === null) continue;
      await scanTree(root, scope, ctx, entries);
    }

    await scanMcp(ctx, entries);
    return entries;
  },
};

async function scanTree(
  root: string,
  scope: CatalogScope,
  _ctx: ScanContext,
  entries: CatalogEntry[],
): Promise<void> {
  // A skill is a directory containing SKILL.md. Depth 3 covers `skills/<name>`.
  for (const skill of await collectSkillFiles(path.join(root, "skills"), { maxDepth: 2 })) {
    const item = await readSkillParts(skill.file, skill.dir);
    entries.push({
      id: catalogId("claude-code", "skill", item.name, scope),
      kind: "skill",
      name: item.name,
      description: normaliseDescription(item.description),
      ...(item.whenToUse === undefined ? {} : { whenToUse: normaliseDescription(item.whenToUse) }),
      runtime: "claude-code",
      scope,
      sourcePath: skill.file,
      ...(item.degraded ? { degraded: true } : {}),
    });
  }

  for (const agent of await collectMarkdownItems(path.join(root, "agents"))) {
    entries.push({
      id: catalogId("claude-code", "agent", agent.name, scope),
      kind: "agent",
      name: agent.name,
      description: agent.description,
      ...(agent.whenToUse === undefined
        ? {}
        : { whenToUse: normaliseDescription(agent.whenToUse) }),
      runtime: "claude-code",
      scope,
      sourcePath: agent.file,
      ...(agent.degraded ? { degraded: true } : {}),
    });
  }

  const commandsDir = path.join(root, "commands");
  for (const file of await collectMarkdownRecursive(commandsDir, { maxDepth: 2 })) {
    const relative = path.relative(commandsDir, file).replace(/\.md$/i, "");
    const name = `/${relative.split(path.sep).join(":")}`;
    const item = await readMarkdownItem(file);
    entries.push({
      id: catalogId("claude-code", "command", name, scope),
      kind: "command",
      name,
      description: item?.description ?? "",
      ...(item?.whenToUse === undefined ? {} : { whenToUse: normaliseDescription(item.whenToUse) }),
      runtime: "claude-code",
      scope,
      sourcePath: file,
      ...(item?.degraded === true ? { degraded: true } : {}),
    });
  }
}

async function scanMcp(ctx: ScanContext, entries: CatalogEntry[]): Promise<void> {
  const claudeJsonPath = claudeStatePath(ctx.homeDir, ctx.env);
  const claudeJson = await readJsonSafe<ClaudeJson>(claudeJsonPath);

  // Global servers from Claude's configured state file.
  for (const server of serversFromRecord(claudeJson?.mcpServers)) {
    entries.push(mcpEntry(server, "global", claudeJsonPath));
  }

  // Project-scoped servers recorded in the same file, keyed by project path.
  if (claudeJson?.projects !== undefined && ctx.projectDir !== null) {
    const record = claudeJson.projects[ctx.projectDir];
    for (const server of serversFromRecord(record?.mcpServers)) {
      entries.push(mcpEntry(server, "project", claudeJsonPath));
    }
  }

  // Project-local .mcp.json, the shared cross-client convention.
  if (ctx.projectDir !== null) {
    const projectMcp = path.join(ctx.projectDir, ".mcp.json");
    const local = claudeJson?.projects?.[ctx.projectDir];
    const enabled = new Set(stringArray(local?.enabledMcpjsonServers));
    const disabled = new Set(stringArray(local?.disabledMcpjsonServers));
    for (const server of await readMcpJsonFile(projectMcp)) {
      if (enabled.has(server.name) && !disabled.has(server.name)) {
        entries.push(mcpEntry(server, "project", projectMcp));
      }
    }
  }

  // ~/.claude/mcp.json is read by the shared MCP adapter ecosystem.
  const claudeDirMcp = path.join(claudeConfigDir(ctx.homeDir, ctx.env), "mcp.json");
  for (const server of await readMcpJsonFile(claudeDirMcp)) {
    entries.push(mcpEntry(server, "global", claudeDirMcp));
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mcpEntry(
  server: { name: string; url?: string; command?: string; type?: string; args?: string[] },
  scope: CatalogScope,
  sourcePath: string,
): CatalogEntry {
  const meta: Record<string, string> = {};
  if (server.type !== undefined) meta.type = server.type;
  if (server.url !== undefined) meta.url = server.url;
  if (server.command !== undefined) meta.command = server.command;
  if (server.args !== undefined) meta.args = server.args.join(" ");

  return {
    id: catalogId("claude-code", "mcp", server.name, scope),
    kind: "mcp",
    name: server.name,
    description: normaliseDescription(describeMcpServer(server)),
    runtime: "claude-code",
    scope,
    sourcePath,
    meta,
  };
}
