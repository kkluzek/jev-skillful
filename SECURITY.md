# Security

## Reporting a vulnerability

Use [GitHub's private advisory form](https://github.com/kkluzek/jev-skillful/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. A proof of concept is welcome.

## Threat model

Skillful runs on a developer's machine, inside their agent, and writes into configuration files
that other tools also use. The risks worth stating plainly are these.

### Extensions run with your full user permissions

`skillful install` writes an extension for Pi and OMP at
`~/.{pi,omp}/agent/extensions/skillful/index.ts`. Pi and OMP extensions execute arbitrary code with
the full permissions of the user who runs the agent. That is the platform's design, not something
this project can change.

The extension Skillful writes is about forty lines: it spawns the Skillful CLI on a child process,
writes one JSON object to its stdin, reads one JSON object from its stdout, and injects the
`additionalContext` field if there is one. It does nothing else, and it is readable in full. Read it
before you trust it. If you are not comfortable with that, do not install for Pi or OMP; the Claude
Code and Codex hooks are plain command hooks and do not carry the same weight.

### Your prompt is transmitted

`skillful route` sends the prompt to the selected Jev provider, truncated to 1000 characters. The
supported routes are TypeSafe, Vercel AI Gateway's TypeSafe-compatible endpoint, and OpenRouter's
Decisions endpoint. This is the mechanism of the product: the model decides which capability a task
needs, and it needs to read the task. The request carries the shortlisted capability names and
descriptions alongside the prompt.

- Set `SKILLFUL_UPLOAD_PROMPT=false` to withhold the prompt text. The shortlist is still chosen
  locally from your prompt, so routing quality drops; nothing else changes.
- The prompt is truncated before it is sent.
- A session-start capability refresh is limited to the selected runtime. Codex is queried through
  an ephemeral App Server thread for the current project. Claude Code is queried through its own
  effective init inventory with hooks disabled; the child is terminated when init arrives, before
  model inference. This preserves the client's connector/OAuth boundary without copying tokens.
  The fail-closed config fallback may send MCP initialize plus `tools/list` only to configured and
  approved servers. Skillful never calls a tool and never sends the user's prompt to MCP.
- CLI discovery runs only Homebrew, uv, pnpm, npm, Bun and Carapace as metadata providers, and
  passively reads existing Homebrew/zsh completion files. It does not enumerate or execute
  arbitrary PATH entries. A small allowlist can be enriched with recursive `--help` only inside a
  no-network, write-restricted macOS sandbox.
- There is no telemetry, analytics, phone-home, or update check.

Provider keys are read from `TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, or
`OPENROUTER_API_KEY` and nowhere else in the application. `SKILLFUL_PROVIDER` explicitly selects a
route; a missing key then fails closed instead of falling through to another billing provider. A
config file that contains a credential-shaped key is rejected with a warning, because a key written
into a file should be treated as leaked.

The optional macOS `skillful-vercel` launcher is a separate, readable shell boundary. It reads one
dedicated Vercel key from Keychain at process start, removes inherited TypeSafe/OpenRouter keys,
exports the Vercel provider and key only to its Skillful child, then replaces itself with that
process. `skillful install` records the launcher's absolute path; it never copies the key into an
agent configuration file.

### Configuration files

`skillful install` modifies `$CLAUDE_CONFIG_DIR/settings.json` (falling back to
`~/.claude/settings.json`) and `~/.codex/hooks.json`, both of which other tools write to. The
protections are:

- A timestamped backup before any modification.
- A file that cannot be parsed is reported and left alone. It is never overwritten.
- Only entries carrying Skillful's own marker are touched. Every other hook keeps its position.
- Writes are atomic: a temp file, then a rename.
- Uninstall removes only what install added, and removes the file if it held nothing else.

If install ever damages a configuration file, that is a security-relevant bug. Report it.

### The Codex trust ledger

Codex keeps `~/.codex/config.toml` `[hooks.state]`, a ledger mapping hook script paths to a
`trusted_hash`. Skillful installs into `~/.codex/hooks.json` and **does not write to that ledger**.
Fabricating a trust entry would mean authorising its own code inside another tool's security model
without asking you. If the hook does not fire in Codex, approve it once when Codex prompts.

### The route cache

`~/.cache/skillful/routes.json` stores routing decisions, keyed by a hash of the normalised prompt,
catalog fingerprint, and non-secret route context (provider, endpoint, model, thresholds and
quotas). Changing providers cannot serve a decision made through a previous billing route. The file
is written with mode `0600`.

- It never stores prompt text.
- It never stores an API key or any credential.
- It can be deleted at any time; the next prompt simply misses the cache.
- A corrupt route cache is treated as empty rather than as an error.

### Exported cases

`skillful export-case` redacts before writing: home directories become `~`, other absolute paths
become `<path>`, environment values whose names look sensitive become `<redacted-env>`, and
credential shapes, URL credentials, and email addresses are removed. Tests assert on these, using
the exact strings a real machine produces.

The redaction is a filter, and a filter can miss something. Read the output before posting it.

### The capability cache

`~/.cache/skillful/capabilities-v2.json` stores exact MCP tool names/descriptions and installed CLI
command trees. It may contain local executable and configuration paths, so it is written `0600`.
It never stores MCP credentials or tool schemas. Failed refreshes retain the last known inventory
as explicitly stale diagnostic evidence instead of silently replacing it with an empty list; stale
entries are not offered to the router.

A missing capability cache starts empty. A corrupt or unreadable capability cache suppresses broad
MCP fallbacks and remains fail-closed for every client until that client's exact inventory is
refreshed, including when the first repair is only a partial or CLI-only refresh.

The Codex App Server process receives `SKILLFUL_DISCOVERY_NESTED=1`, and a refresh started from its
ephemeral thread exits immediately. This prevents the session-start hook from recursively starting
another inventory process. Discovery requests status and tool metadata only; it never starts an
agent turn or invokes a returned tool.

### Reminder data

The Claude reminder layer reads only the configured Claude memory/rule files and the project-root
`CLAUDE.md`; it never writes them. Its index cache and per-session pending/deduplication state are
created with private permissions. The local JSONL decision log records the bounded query,
candidate IDs and scores so retrieval can be audited. That query can contain private task text.
It is never telemetry, but it must be protected like shell history and may be deleted at any time.
A private cache-side marker carries a `PostCompact` persistence failure to the next supported
`SessionStart`. Delivery is acknowledged only after stdout flushes, preferring a possible duplicate
after a crash over silent loss.

The bounded query and candidate excerpts are sent to the selected Jev provider for relevance
decisions. Set `SKILLFUL_UPLOAD_PROMPT=false` to prevent that transmission; reminder selection then
fails open with an explicit status instead of falling back to an unauthenticated or local guess.

## Supported versions

The latest published version on npm. Fixes are released as patch versions.
