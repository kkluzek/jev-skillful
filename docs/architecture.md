# Architecture

Skillful resolves the capabilities installed on a machine against the prompt the user just typed,
then injects a short recommendation into the agent's context. This document records the surfaces it
reads and the measurements taken while building it. It is written from what was verified on a real
machine, not from documentation alone.

## Pipeline

```text
prompt
  |
  +-- UserPromptSubmit hook       reads the prompt, consults the cache, applies a 2000ms budget
  |
  +-- Claude PostToolBatch        local phase/failure/adoption gate; normally emits nothing
  |
  +-- SessionStart refresh        asynchronous, exact client MCP/plugin state + CLI trees
  |
  +-- catalog scan (local)        static surfaces + capability cache; no live discovery
  |
  +-- router (one Jev request)    BM25 shortlist -> one `choice` question plus per-candidate `noul`
  |
  +-- inject                      initial: 1 primary + 2 runner-ups; adaptive: 1 primary only
```

## Catalog surfaces

Every supported runtime keeps the same kinds of things in similar layouts. The scanner reads all of
them and normalises the result into one entry shape.

| Runtime | Kind | Where it is read from |
|---|---|---|
| claude-code | skill | `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`, `<project>/.claude/skills`, plus active versions from `claude plugin list --json` (exact `/plugin:skill`) |
| claude-code | agent | `$CLAUDE_CONFIG_DIR/agents/<name>.md`, `<project>/.claude/agents`, plus active plugin agents |
| claude-code | command | `$CLAUDE_CONFIG_DIR/commands/**/<name>.md` (exact `/parent:name`), plus active plugin commands (exact `/plugin:command`) |
| claude-code | mcp | configured client state plus active plugin `.mcp.json`; exact tools are listed only from user/local or approved project targets |
| codex | skill | `$AGENTKIT_CODEX_SKILLS_ROOT`, else `~/.agents/skills/<name>/SKILL.md`, plus `<project>/.agents/skills` and active `codex plugin list --json` versions |
| codex | agent | `~/.codex/agents/<name>.toml` (top-level `name` and `developer_instructions`) |
| codex | command | `~/.codex/prompts/<name>.md` (exact invocation `/prompts:name`) |
| codex | mcp | exact effective servers/tools from `codex app-server --stdio` for an ephemeral thread rooted in the current project |
| pi | skill | `~/.pi/agent/skills/<name>/SKILL.md`, `<project>/.pi/skills` |
| pi | agent | `~/.pi/agent/agents/<name>.md`, `<project>/.pi/agents` |
| pi | rule | `~/.pi/agent/rules/<name>.md` |
| pi | mcp | `~/.pi/agent/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.config/mcp/mcp.json`, `<project>/.pi/mcp.json`, `<project>/.mcp.json` |
| omp | skill | `~/.omp/agent/skills/<name>/SKILL.md`, `~/.omp/agent/managed-skills/<name>/SKILL.md`, `<project>/.omp/skills` |
| omp | agent | `~/.omp/agent/agents/<name>.md` |
| omp | rule | `~/.omp/agent/rules/<name>.md`, `<project>/.omp/rules` |
| omp | mcp | `~/.omp/agent/mcp.json`, `<project>/.omp/mcp.json` |

The Oh My Pi home directory follows the same precedence the AgentKit adapter uses:
`AGENTKIT_OMP_HOME`, then `OMP_HOME` or `PI_CODING_AGENT_DIR`, then `~/.omp/agent`, then `~/.omp`.

### Probe results

Two surfaces were not where the documentation suggested, so they were read out of the owning source
code instead of guessed:

- **Pi has no MCP configuration file of its own.** MCP is provided by the `pi-mcp-adapter` package,
  which reads a shared set of locations. The paths above were taken from that package's `config.ts`.
- **Codex keeps skills outside `~/.codex`.** Skills live in the shared `~/.agents/skills` root that
  other `agents`-convention clients also use, which is why an empty `~/.codex/skills` is expected.

Codex hook placement for this installer was settled by a live probe: executable hook definitions
are read from `~/.codex/hooks.json`. Current Codex also supports inline hook tables in
`config.toml`; the existing `[hooks.state]` table on the measured machine is its trust ledger, not
an inline hook definition. Skillful deliberately uses the JSON surface shared with Claude Code.

## Identity and fingerprint

An entry's id is `runtime:kind:scope:name`. It deliberately excludes the filesystem path, so moving a
skills directory does not change the identity of anything inside it.

The catalog fingerprint is a sha256 over sorted entry identity, retrieval text and typed capability
identity/availability. It is part of the route cache key, so it changes when a command tree or
tool availability changes while staying stable across incidental file ordering and modification
times. Paths are excluded except where a hashed effective origin is part of the typed identity.

## Measured behaviour

Measurements taken on the development machine while building phase 1.

| Measurement | Result |
|---|---|
| Catalog size on the development machine | 597 entries: 139 claude-code, 154 codex, 130 pi, 174 omp |
| Catalog by kind | 5 mcp surfaces, 72 agents, 16 rules, plus skills and commands |
| Scan duration (node, warm) | 0.14 – 0.27s for the full catalog plus JSON serialisation |
| Jev request latency, K=5 (4 questions) | 0.745 – 0.858s |
| Jev request latency, K=15 (2 questions) | 0.686 – 0.762s |
| Jev request cost | ~1360 input tokens, about $0.00006 per route |

Two consequences shape the design:

- **Latency does not grow with shortlist size.** K=5 and K=15 cost the same, because the fixed
  connection and inference overhead dominates. The 2000ms hook budget therefore has room, and a larger
  shortlist costs quality nothing in latency.
- **Scan duration is not the bottleneck.** A warm scan is roughly a quarter of the budget, which is why
  the hook can afford to scan when the cache misses.

## Design constraints that came from measurement

**Do not use a `noul` question as a gate for "does this task need a capability".** Measured live: the
noul returned 0.39 for a task where the `choice` question had already picked the right capability with
confidence 1.0, and returned 0.10 for both "fix the typo" and "thanks", so it could not tell them apart.
The `none` option inside the `choice` question already handles abstention correctly (chitchat gave a
`none` probability of 1.00, the typo case 0.62). Dropping the gate removes a question, a branch, and a
failure mode.

**Inject at most one primary plus two runner-ups.** K is the size of the shortlist the router reasons
over, not the amount of text injected into the agent. Injecting the whole shortlist would recreate the
"enumerate every skill in the context window" strategy that arXiv:2604.24594 shows does not scale: as
the corpus grows, the agent becomes *less* accurate at picking the right skill.

## Verification notes

The TypeScript 7 toolchain required two adjustments that are easy to get wrong:

- `types: ["node"]` must be set explicitly. TypeScript 7 does not pick up `@types/node` through the
  `@types` walk for these packages, and without it every `node:` import reports TS2591.
- `baseUrl` was **removed** in TypeScript 7 and reports TS5102. The `paths` entries that map
  `@skillful/core` to its source must be declared without it; in TypeScript 7 the substitution values
  resolve relative to the config file that declares them.

The build uses `tsconfig.build.json`, which excludes test files so nothing test-related reaches `dist`.
The editor and `pnpm typecheck` use `tsconfig.json`, which **includes** the test files deliberately:
excluded test files get analysed outside the project and lose the `types` and lib settings they need,
which shows up as spurious `TS2591` errors for `node:` imports.

### Why this is a single package

Skillful is one package (`packages/cli`, published as `skillful`), not a core/cli split.

The first attempt used two workspace packages with the CLI importing `@skillful/core` as a bare
specifier. `tsc` resolved it (through project references, and independently through the pnpm workspace
link), but the editor's TypeScript language server did not, reporting `TS2307` plus cascading `TS7006`
errors on every edit. That split was speculative anyway: `@skillful/core` was `private`, had exactly one
consumer, and nothing shipped it separately.

Collapsing to one package removes the bare workspace specifier entirely, and with it the project
references, the build-ordering requirement, and a `deno.json` import map that had been added as a
workaround. The router, telemetry, and benchmark code all live under `src/core/` and are imported with
relative paths, which every resolver agrees on.

A second lesson from the same episode: the language server was correct, and calling its diagnostics a
"stale cache" was wrong three times. When editor diagnostics and the compiler disagree, neither side is
presumed right — the disagreement has to be explained, and here the explanation was a real resolution
gap rather than a tool defect.

## Runtime hooks

Two mechanisms cover four runtimes, because two pairs of runtimes share a contract:

| Runtime | File | Mechanism |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json` | `UserPromptSubmit` initial route; `PostToolBatch` adaptive route; `SubagentStart` handoff; `SessionEnd` cleanup; asynchronous refresh on session/config/scope changes; `PostCompact`/resume reminders |
| Codex | `~/.codex/hooks.json` | `UserPromptSubmit` routes; asynchronous `SessionStart` refreshes Codex MCP/plugin + CLI cache |
| Pi | `~/.pi/agent/extensions/skillful/index.ts` | extension, `before_agent_start` |
| OMP | `~/.omp/agent/extensions/skillful/index.ts` | extension, `before_agent_start` |

The two extension runtimes share one generated file, which forwards the prompt to `skillful hook`
on a child process. That keeps one implementation of routing, caching, budgeting and rendering —
the CLI's — serving all four runtimes instead of a second one that would drift from the first.

### Claude adaptive routing

Claude Code receives a second routing opportunity inside a long user turn. `PostToolBatch` fires
once after a full batch of parallel tool calls and before the next model request, so it is the
coalescing boundary rather than one process per `PostToolUse`.

The hook stores a private per-session and per-agent record containing the bounded user goal, current
phase, batch count, shown and observed-used capability IDs, and the strongest current recommendation.
The file is mode `0600`, its path contains only hashes, and `SessionEnd` removes the session
directory. Delivery-dependent dedupe is committed only after stdout flushes successfully.

Before another Jev call, deterministic code requires new evidence and either a meaningful phase
change or a classified failure. Discovery-only batches remain silent. A successful use of the
current MCP, CLI, agent, skill or command suppresses normal rerouting; a failed use may still open
one recovery slot. Each prompt permits at most one normal and one recovery intervention. The
mid-task renderer emits one primary, no runner-ups, no raw confidence values, and at most 240
characters. `SKILLFUL_ADAPTIVE=0` disables this layer without disabling initial prompt routing.

`SubagentStart` does not expose the delegated prompt. It therefore never makes a new Jev request:
it can pass one strong, unused parent recommendation into that subagent and then deduplicates it in
the subagent's own state. `Stop`, `PostToolUse`, `PreToolUse`, `TaskCompleted` and idle events are
not recommendation surfaces.

### Exact MCP and CLI capability cache

Live discovery is separated from prompt routing. `skillful refresh` writes independent, versioned
cache partitions for each runtime, MCP server, and workspace. A failed server refresh retains its
last known entries as stale diagnostic evidence but excludes them from routing; removing a server
from an authoritative client inventory removes its partition.

The installed `SessionStart` hook is asynchronous for both Codex and Claude Code. It runs once for
`startup`, `resume`, `clear`, or `fork` without blocking the first prompt. Before it waits for the shared
lock, it publishes a per-runtime/workspace marker that makes affected old partitions unroutable.
After acquiring the lock it checkpoints them as stale, then atomically publishes each completed
partition. A queued, timed-out, or interrupted refresh therefore cannot expose an old inventory as
fresh. MCP and effective plugin partitions both require an exact workspace match.

MCP identities include client, effective workspace, server, tool, and a redacted origin identity. Codex and Claude Code are
never merged, even when both define a server with the same name. Claude Code uses a bounded
`claude mcp list` health-check followed by `system/init` metadata with hooks disabled, and
terminates that client process immediately after init, before model inference. This captures
managed connectors and the exact tool names backed
by Claude's own OAuth state. Codex is asked for its own effective tool catalog through
`mcpServerStatus/list` on App Server after starting an ephemeral, project-rooted thread. A
config/SDK compatibility path is non-authoritative and supports stdio, Streamable HTTP, and legacy
SSE. No tool is called; schemas and credentials are not persisted. The displayed invocation is the
concrete client-specific `mcp__server__tool` name.

Plugin files are not found by globbing every historical cache directory. Each client is the
authority for enablement and version selection: `claude plugin list --json` and
`codex plugin list --json` select the active install roots, after which Skillful reads only passive,
bounded manifest and Markdown metadata from those roots.

CLI discovery starts from direct user installations, not from the contents of `$PATH`. Homebrew
install receipts and top-level uv/npm/pnpm/Bun inventories exclude transitive dependencies. The
set is intersected with Carapace, Homebrew, or existing zsh completion availability. Absolute
directories already present in `FPATH` and standard user zsh completion directories are read as
passive metadata; shell startup files are never sourced. `$PATH` is used only to resolve a specific
basename after a manager proves direct ownership. Recursive Carapace `export` JSON is the preferred
metadata source. A bounded, sandboxed `--help` walk exists only for a small explicit adapter set
when structured export is unavailable. BM25 selects within a dedicated CLI quota before Jev makes
the final choice.

Manager compatibility was reverified on 2026-09-23. pnpm 12.5.1 can install a deliberately
shebang-less shell shim; direct macOS `spawn` returns `ENOEXEC`, so the trusted command runner retries
that exact executable and argv through `/bin/sh` only for `ENOEXEC`. Bun 1.4.2 reports global roots
as `node_modules (N installed)`; both that header and the earlier `node_modules (N)` form are parsed.

### Claude reminder layer

Reminder retrieval is separate from capability routing. It reads a fixed corpus: the current
Claude project's `memory/MEMORY.md` targets and bodies, global `CLAUDE.md`, `rules/*.md`,
`verification-doctrine*.md`, and `##` sections in the project-root `CLAUDE.md`. It never scans the
whole project and never writes those sources. The parser uses the same memory index, wikilink and
rule-definition patterns as the installed memory-health script.

Weighted BM25 (including Polish folding, identifier/file splitting, citation contexts and a light
4-gram fallback) produces at most 12 candidates. One batched request to the selected Jev provider
asks a separate `noul` relevance question for each candidate. At most three passing titles are rendered. Memory
and rule bodies help ranking but are never injected. `PostCompact` stores the selection privately;
the next `SessionStart(source=compact)` injects it because Claude discards `PostCompact` context.
If persistence fails, a separate private marker carries the diagnostic to that supported event.
Shown/deduplication state is committed only after the hook JSON flushes to Claude. Resume selects
directly. A five-minute cooldown and per-session IDs suppress repeats.

### Where Skillful installs Codex hooks

Both supported configuration surfaces were considered, and the JSON surface was probed by running
the agent.

- `~/.codex/hooks.json` holds real hook definitions. `hooks.UserPromptSubmit` is an array of
  `{matcher, hooks: [{type, command, commandWindows}]}`, the same shape Claude Code uses.
- On the measured machine, `~/.codex/config.toml` has a `[hooks]` table whose only child is
  `[hooks.state]` — a ledger of `path -> trusted_hash`. Codex also supports inline hook tables in
  this file, but none were present there during the probe.

A temporary entry appended to `hooks.json` produced `hook: UserPromptSubmit` lines in Codex's own
output, so that file is read and its hooks run. The probe also surfaced a caveat the installer
reports rather than hides: the probe command did not itself execute, while the pre-existing hooks —
all `.cjs` files under `~/.codex/hooks/` with a `trusted_hash` recorded in `config.toml` — did. The
installer therefore writes into `hooks.json` and documents the trust step, and deliberately does not
fabricate a `trusted_hash` to authorise its own code inside another tool's security model.

### Measured hook behaviour

Live, on this machine, with the real catalog:

| Check | Result |
|---|---|
| Cold route through `skillful hook` | 1446ms, inside the 2000ms budget |
| Same prompt again, cache hit | 221ms, byte-identical output |
| Trivial prompt (`thanks!`) | `{}` — nothing injected |
| Invalid API key | reminder line, exit 0 |
| Network unreachable, cache miss | reminder line, exit 0 |
| Budget exhausted (`SKILLFUL_BUDGET_MS=1`) | reminder line, exit 0 |

Two defects were found by these checks rather than by the test suite, and both are worth recording
because neither would have been caught by a unit test that trusted the code's own assumptions.

The first: `resolveConfig` computed a `baseUrl` from the config file and from `SKILLFUL_BASE_URL`,
reported its source in `--explain`, and no caller ever forwarded it to the Jev client. The setting
was read and discarded, across every command, since phase 2. It was found because a test that set
`SKILLFUL_BASE_URL` to an unreachable address still returned a correct answer — the request had gone
to the real service. A setting that is resolved and ignored is worse than one that does not exist,
because it looks like it works.

The second: uninstall left an emptied `hooks.UserPromptSubmit: []` behind. Uninstall is required to
leave the configuration as it was found, and an empty array is a visible trace in a diff that would
also survive into the next install. Emptied containers are now pruned, and a file that held nothing
but the Skillful hook is removed.
