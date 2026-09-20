export interface DiscoveredExecutable {
  name: string;
  path: string;
  realPath: string;
  scope: "global" | "project";
  shadowed: string[];
}

export interface CliDiscoveryOptions {
  cwd: string;
  projectDir: string | null;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ParsedCliHelp {
  description: string;
  subcommands: Array<{ name: string; description: string }>;
}

/** Parse a conservative common subset of help text. It never interprets the text as instructions. */
export function parseCliHelp(raw: string): ParsedCliHelp {
  const text = sanitise(raw, 256 * 1024);
  const lines = text.split(/\r?\n/);
  const description = bound(
    lines
      .find((line) => line.trim() !== "" && !/^(usage|commands?|options?):/i.test(line.trim()))
      ?.trim() ?? "",
  );
  const subcommands: Array<{ name: string; description: string }> = [];
  let inCommands = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(available\s+)?commands?:\s*$/i.test(trimmed)) {
      inCommands = true;
      continue;
    }
    if (inCommands && /^[A-Za-z][A-Za-z -]+:\s*$/.test(trimmed)) break;
    if (!inCommands || trimmed === "") continue;
    const match = /^\s{1,8}([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (match[1] === "help" || match[1].startsWith("-")) continue;
    subcommands.push({ name: match[1], description: bound(match[2]) });
    if (subcommands.length >= 100) break;
  }
  return { description, subcommands };
}

function sanitise(value: string, limit: number): string {
  return [...value.slice(0, limit)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join("");
}

function bound(value: string, limit = 200): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`;
}
