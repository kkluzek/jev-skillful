import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { findProjectRoot } from "../catalog/project-scope.js";
import { claudeConfigDir } from "../claude-config.js";
import type { ReminderDocument } from "./types.js";

// Kept byte-for-byte compatible with ~/.config/claude/scripts/memory-health.py.
export const WIKILINK = /\[\[([A-Za-z0-9_-]+)\]\]/g;
export const INDEX_ENTRY = /^\s*[-*]\s+\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/gm;
export const RULE_DEFINITION = /^\*\*\[([a-z0-9-]+)\]/gm;
const VALID_RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

export interface ReminderCorpus {
  documents: ReminderDocument[];
  warnings: string[];
  fingerprint: string;
  sources: Array<{ path: string; mtimeMs: number; size: number }>;
}

function warnOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function safeRead(filePath: string, warnings?: string[], required = false): string | null {
  try {
    if (!statSync(filePath).isFile()) {
      if (warnings !== undefined)
        warnOnce(warnings, `Reminder corpus incomplete: ${filePath} is not a regular file`);
      return null;
    }
    return readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (warnings !== undefined && (required || code !== "ENOENT")) {
      warnOnce(
        warnings,
        `Reminder corpus incomplete: could not read ${filePath} (${code ?? "unknown"})`,
      );
    }
    return null;
  }
}

function realDirectory(dirPath: string, warnings: string[]): string | null {
  try {
    const resolved = realpathSync(dirPath);
    if (!statSync(resolved).isDirectory()) {
      warnOnce(warnings, `Reminder corpus incomplete: ${dirPath} is not a directory`);
      return null;
    }
    return resolved;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warnOnce(
        warnings,
        `Reminder corpus incomplete: could not resolve ${dirPath} (${code ?? "unknown"})`,
      );
    }
    return null;
  }
}

function containedRealFile(
  rootReal: string,
  candidate: string,
  warnings: string[],
  required: boolean,
): string | null {
  try {
    const resolved = realpathSync(candidate);
    if (!resolved.startsWith(`${rootReal}${path.sep}`)) {
      warnOnce(
        warnings,
        `Reminder corpus incomplete: ${candidate} resolves outside the memory directory`,
      );
      return null;
    }
    if (!statSync(resolved).isFile()) {
      warnOnce(warnings, `Reminder corpus incomplete: ${candidate} is not a regular file`);
      return null;
    }
    return resolved;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (required || code !== "ENOENT") {
      warnOnce(
        warnings,
        `Reminder corpus incomplete: could not resolve ${candidate} (${code ?? "unknown"})`,
      );
    }
    return null;
  }
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function frontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---", 4);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined)
      result[match[1].toLowerCase()] = (match[2] ?? "").replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function wikiIdentifiers(content: string): string[] {
  return [...content.matchAll(WIKILINK)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

export function extractRuleCitations(content: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const match of content.matchAll(/\[([^\]]+)\]/g)) {
    const id = match[1];
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (id === undefined || !VALID_RULE_ID.test(id)) continue;
    if (content[start - 1] === "[" || content[end] === "]" || /^\s*\(/.test(content.slice(end)))
      continue;
    const sentenceStart =
      Math.max(
        content.lastIndexOf(".", start - 1),
        content.lastIndexOf("!", start - 1),
        content.lastIndexOf("?", start - 1),
        content.lastIndexOf("\n", start - 1),
      ) + 1;
    const endings = [
      content.indexOf(".", end),
      content.indexOf("!", end),
      content.indexOf("?", end),
      content.indexOf("\n", end),
    ].filter((value) => value >= 0);
    const sentenceEnd = endings.length === 0 ? content.length : Math.min(...endings) + 1;
    const list = result.get(id) ?? [];
    list.push(content.slice(sentenceStart, sentenceEnd).trim().slice(0, 500));
    result.set(id, list);
  }
  return result;
}

function parseRuleBlocks(
  filePath: string,
  content: string,
  citations: Map<string, string[]>,
): ReminderDocument[] {
  const matches = [...content.matchAll(RULE_DEFINITION)];
  return matches.flatMap((match, index) => {
    const id = match[1];
    if (id === undefined) return [];
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? content.length;
    const heading = content.indexOf("\n#", start + 1);
    const end = heading >= 0 && heading < next ? heading : next;
    const body = content.slice(start, end).trim();
    const lead = firstLine(body).replace(/^\*\*\[[^\]]+\]\*\*\s*[:—-]?\s*/, "");
    return [
      {
        id: `rule:${id}`,
        canonicalKey: `rule:${id}`,
        kind: "rule" as const,
        title: id,
        hook: lead || id,
        path: filePath,
        description: lead,
        body,
        identifiers: [id, path.basename(filePath, path.extname(filePath))],
        citations: citations.get(id) ?? [],
      },
    ];
  });
}

function parseProjectSections(filePath: string, content: string): ReminderDocument[] {
  const matches = [...content.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const title = (match[1] ?? "Section").trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const body = content.slice(start, end).trim();
    return {
      id: `project-rule:${filePath}#${title}`,
      canonicalKey: `project-rule:${filePath}#${title}`,
      kind: "rule",
      title: `CLAUDE.md § ${title}`,
      hook: firstLine(body),
      path: filePath,
      description: firstLine(body),
      body,
      identifiers: [title],
      citations: [],
    };
  });
}

function sourceMetadata(
  files: readonly string[],
  warnings: string[],
): Array<{ path: string; mtimeMs: number; size: number }> {
  return files
    .flatMap((filePath) => {
      try {
        const stat = statSync(filePath);
        return stat.isFile() ? [{ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown";
        warnOnce(warnings, `Reminder corpus incomplete: could not stat ${filePath} (${code})`);
        return [];
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildReminderCorpus(options: {
  homeDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<ReminderCorpus> {
  const warnings: string[] = [];
  const documents: ReminderDocument[] = [];
  const configDir = claudeConfigDir(options.homeDir, options.env);
  const encoded = path.resolve(options.cwd).replace(/[/.]/g, "-");
  const memoryDir = path.join(configDir, "projects", encoded, "memory");
  const memoryIndex = path.join(memoryDir, "MEMORY.md");
  const memoryRootReal = realDirectory(memoryDir, warnings);
  const memoryIndexReal =
    memoryRootReal === null
      ? null
      : containedRealFile(memoryRootReal, memoryIndex, warnings, false);
  const indexContent = memoryIndexReal === null ? null : safeRead(memoryIndexReal, warnings, true);
  const files = new Set<string>();
  if (indexContent !== null && memoryIndexReal !== null) files.add(memoryIndexReal);

  if (indexContent === null || [...indexContent.matchAll(INDEX_ENTRY)].length === 0) {
    warnings.push(`Reminder memory index is empty or unavailable: ${memoryIndex}`);
  } else {
    for (const match of indexContent.matchAll(INDEX_ENTRY)) {
      const rawTarget = match[1];
      if (rawTarget === undefined) continue;
      let target: string;
      try {
        target = path.resolve(memoryDir, decodeURIComponent(rawTarget.split("#")[0] ?? rawTarget));
      } catch {
        warnings.push(`Reminder corpus incomplete: invalid memory index target: ${rawTarget}`);
        continue;
      }
      if (memoryRootReal === null || !target.startsWith(`${path.resolve(memoryDir)}${path.sep}`)) {
        warnings.push(
          `Reminder corpus incomplete: memory index target is outside memory: ${rawTarget}`,
        );
        continue;
      }
      const realTarget = containedRealFile(memoryRootReal, target, warnings, true);
      if (realTarget === null) {
        continue;
      }
      const body = safeRead(realTarget, warnings, true);
      if (body === null) continue;
      files.add(realTarget);
      const meta = frontmatter(body);
      const title = meta["title"] || path.basename(realTarget, path.extname(realTarget));
      const description = meta["description"] || firstLine(body.replace(/^---[\s\S]*?---/, ""));
      const canonicalKey = `memory:${realTarget}`;
      documents.push({
        id: `memory-index:${realTarget}`,
        canonicalKey,
        kind: "memory",
        title,
        hook: description,
        path: realTarget,
        description,
        body: "",
        identifiers: [path.basename(realTarget), ...wikiIdentifiers(body)],
        citations: [],
      });
      documents.push({
        id: `memory-body:${realTarget}`,
        canonicalKey,
        kind: "memory",
        title,
        hook: description,
        path: realTarget,
        description,
        body,
        identifiers: [path.basename(realTarget), ...wikiIdentifiers(body)],
        citations: [],
      });
      for (const name of wikiIdentifiers(body)) {
        const exact = path.join(memoryDir, `${name}.md`);
        const exactReal = containedRealFile(memoryRootReal, exact, warnings, false);
        if (exactReal !== null) files.add(exactReal);
        else {
          try {
            const caseInsensitive = readdirSync(memoryDir).find(
              (candidate) => candidate.toLowerCase() === `${name}.md`.toLowerCase(),
            );
            if (caseInsensitive !== undefined)
              warnings.push(`Wikilink name ${name} differs from file ${caseInsensitive}`);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT")
              warnOnce(
                warnings,
                `Reminder corpus incomplete: could not list ${memoryDir} (${code ?? "unknown"})`,
              );
          }
        }
      }
    }
  }

  const globalFiles = [path.join(configDir, "CLAUDE.md")];
  const rulesDir = path.join(configDir, "rules");
  try {
    for (const name of readdirSync(rulesDir))
      if (name.endsWith(".md")) globalFiles.push(path.join(rulesDir, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      warnOnce(
        warnings,
        `Reminder corpus incomplete: could not list ${rulesDir} (${code ?? "unknown"})`,
      );
  }
  try {
    for (const name of readdirSync(configDir))
      if (/^verification-doctrine.*\.md$/i.test(name)) globalFiles.push(path.join(configDir, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      warnOnce(
        warnings,
        `Reminder corpus incomplete: could not list ${configDir} (${code ?? "unknown"})`,
      );
  }
  const readableGlobals = globalFiles.flatMap((filePath) =>
    safeRead(filePath, warnings) === null ? [] : [filePath],
  );
  readableGlobals.forEach((filePath) => {
    files.add(filePath);
  });

  const projectRoot = await findProjectRoot(options.cwd, options.homeDir);
  const projectClaude = projectRoot === null ? null : path.join(projectRoot, "CLAUDE.md");
  const projectContent = projectClaude === null ? null : safeRead(projectClaude, warnings);
  if (projectClaude !== null && projectContent !== null) files.add(projectClaude);

  const memoryCitationFiles = [...files].filter(
    (filePath) =>
      memoryRootReal !== null &&
      filePath.startsWith(`${memoryRootReal}${path.sep}`) &&
      filePath.endsWith(".md"),
  );
  const allCitationFiles = [
    ...readableGlobals,
    ...(projectContent === null || projectClaude === null ? [] : [projectClaude]),
    ...memoryCitationFiles,
  ];
  const citations = new Map<string, string[]>();
  for (const filePath of allCitationFiles) {
    const content = safeRead(filePath, warnings, true) ?? "";
    for (const [id, contexts] of extractRuleCitations(content))
      citations.set(id, [...(citations.get(id) ?? []), ...contexts]);
  }
  for (const filePath of readableGlobals) {
    const content = safeRead(filePath, warnings, true) ?? "";
    if (path.dirname(filePath) === rulesDir) {
      const definedIds = [...content.matchAll(RULE_DEFINITION)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined);
      const id = definedIds[0] ?? path.basename(filePath, path.extname(filePath));
      documents.push({
        id: `rule-file:${filePath}`,
        canonicalKey: `rule-file:${filePath}`,
        kind: "rule",
        title: id,
        hook: firstLine(content),
        path: filePath,
        description: firstLine(content),
        body: content,
        identifiers: [path.basename(filePath, path.extname(filePath)), ...definedIds],
        citations: citations.get(id) ?? [],
      });
    } else {
      documents.push(...parseRuleBlocks(filePath, content, citations));
    }
  }
  if (projectClaude !== null && projectContent !== null)
    documents.push(...parseProjectSections(projectClaude, projectContent));

  const sources = sourceMetadata([...files], warnings);
  const fingerprint = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
  return { documents, warnings, fingerprint, sources };
}
