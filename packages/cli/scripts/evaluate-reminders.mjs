#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildReminderCorpus } from "../dist/core/reminder/corpus.js";
import { rankReminderDocuments } from "../dist/core/reminder/rank.js";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : null))
    .filter(Boolean),
);
if (!args.cwd || !args.transcripts) {
  process.stderr.write("usage: evaluate-reminders.mjs --cwd DIR --transcripts DIR [--limit 20]\n");
  process.exit(1);
}
const limit = Math.max(1, Number(args.limit ?? 20));
const homeDir = process.env.HOME ?? ".";
const corpus = await buildReminderCorpus({ homeDir, cwd: args.cwd, env: process.env });
const ruleIds = new Map(
  corpus.documents
    .filter((document) => document.kind === "rule")
    .map((document) => [document.title, document.canonicalKey]),
);
const memoryPaths = new Set(
  corpus.documents
    .filter((document) => document.kind === "memory")
    .map((document) => path.resolve(document.path)),
);
const kindByCanonicalKey = new Map(
  corpus.documents.map((document) => [document.canonicalKey, document.kind]),
);

function textBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function casesFrom(filePath) {
  const cases = [];
  let active = null;
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.slice(-2_000_000).split(/\r?\n/)) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const role = item?.message?.role;
    const content = item?.message?.content;
    if (role === "user") {
      const text = textBlocks(content);
      const isToolResult =
        Array.isArray(content) && content.some((block) => block?.type === "tool_result");
      if (!isToolResult && text.trim()) {
        if (active?.expected.size) cases.push(active);
        active = { query: text.slice(-8000), expected: new Set() };
      }
      continue;
    }
    if (role !== "assistant" || active === null) continue;
    const visible = textBlocks(content);
    for (const match of visible.matchAll(/\[([a-z0-9]+(?:-[a-z0-9]+)+)\]/g)) {
      if (ruleIds.has(match[1])) active.expected.add(ruleIds.get(match[1]));
    }
    if (Array.isArray(content))
      for (const block of content) {
        if (block?.type !== "tool_use" || block?.name !== "Read") continue;
        const file = block?.input?.file_path;
        if (typeof file === "string" && memoryPaths.has(path.resolve(file)))
          active.expected.add(`memory:${path.resolve(file)}`);
      }
  }
  if (active?.expected.size) cases.push(active);
  return cases;
}

const files = readdirSync(args.transcripts)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => path.join(args.transcripts, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, 200);
const observed = [];
for (const file of files) {
  observed.push(...casesFrom(file));
  if (observed.length >= limit) break;
}
const cases = observed.slice(0, limit);

function metrics(includeCitations) {
  let hit3 = 0;
  let hit12 = 0;
  const byKind = { memory: { total: 0, hit3: 0, hit12: 0 }, rule: { total: 0, hit3: 0, hit12: 0 } };
  for (const item of cases) {
    const ranking = rankReminderDocuments(corpus.documents, item.query, { includeCitations })
      .slice(0, 12)
      .map((candidate) => candidate.document.canonicalKey);
    const expected = [...item.expected];
    const three = expected.some((id) => ranking.slice(0, 3).includes(id));
    const twelve = expected.some((id) => ranking.slice(0, 12).includes(id));
    if (three) hit3 += 1;
    if (twelve) hit12 += 1;
    for (const kind of ["memory", "rule"]) {
      const relevant = expected.filter((id) => kindByCanonicalKey.get(id) === kind);
      if (!relevant.length) continue;
      byKind[kind].total += 1;
      if (relevant.some((id) => ranking.slice(0, 3).includes(id))) byKind[kind].hit3 += 1;
      if (relevant.some((id) => ranking.slice(0, 12).includes(id))) byKind[kind].hit12 += 1;
    }
  }
  return { total: cases.length, hit3, hit12, byKind };
}

const ids = cases.map((item) => createHash("sha256").update(item.query).digest("hex").slice(0, 12));
process.stdout.write(
  `${JSON.stringify({ corpus: { documents: corpus.documents.length, warnings: corpus.warnings.length }, sample: { count: cases.length, ids }, withoutCitationContexts: metrics(false), withCitationContexts: metrics(true) }, null, 2)}\n`,
);
