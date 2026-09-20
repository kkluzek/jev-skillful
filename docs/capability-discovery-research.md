# Capability discovery research

Status: design record with an implemented v1. Sources were checked on 2026-09-20. “Observed” means a claim is supported by a linked specification, official product documentation, or the named source repository. “Implication” and “Recommendation” are design judgments for Jev Skillful. Claims that could not be tied to an unambiguous primary source are marked **UNVERIFIED**.

## Executive conclusion

Jev Skillful should become a *cross-surface recommender*, not another MCP proxy and not an automatic command executor. The safe, bounded v1 is:

1. index static skills and commands plus manager-proven CLI entrypoints without running targets;
2. refresh Codex through its effective App Server inventory and Claude Code through that client's
   zero-inference init inventory, retaining configured-state discovery only as a fail-closed fallback;
3. optionally enrich explicitly trusted CLI executables with bounded `--help` probes;
4. retrieve compact summaries with provider-aware BM25, then let Jev choose or abstain;
5. return the exact host, effective workspace, server and tool/command identity, while leaving schema loading and execution to Codex or Claude Code.

Do **not** recursively run `--help` for every program found on `PATH`. `--help` is still arbitrary program execution; a timeout limits duration, not filesystem, credential, process-tree or network effects. Do **not** merge Codex and Claude Code MCP availability merely because server or tool names match.

## Protocol facts: MCP discovery

### Current protocol and compatibility

- **Observed:** The current MCP revision is `2026-07-28`. It is stateless at the protocol layer: every request carries required protocol-version and client-capability metadata. This revision retired `initialize`, `notifications/initialized` and `Mcp-Session-Id`; `server/discover` is optional. JSON Schema 2020-12 support is required. ([MCP basic protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/index), [2026-07-28 release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/))
- **Observed:** Older, still relevant revision `2025-11-25` requires `initialize` as the first interaction, a server response with negotiated version/capabilities, and then `notifications/initialized` before normal requests. ([legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle))
- **Implication:** The refresher needs explicit modern and legacy adapters. “Call initialize, then list” is not universally current; “never initialize” breaks legacy servers. Prefer an official SDK's negotiated compatibility path over hand-written JSON-RPC.

### Lists, schemas, change notifications and caching

- **Observed:** A server advertises `tools`, `prompts` and `resources` capabilities independently. The corresponding discovery methods are `tools/list`, `prompts/list`, `resources/list`, plus `resources/templates/list`; a configured server is therefore not proof that any particular surface exists. Tool results contain at least name, description and input schema, with optional output schema, annotations, title and icons. ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources), [protocol schema source](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts))
- **Observed:** List endpoints are paginated. Cursors are opaque and must be returned unchanged. An empty string is a legal `nextCursor`, so truthiness-based loops are incorrect. ([MCP Inspector pagination fixture](https://github.com/modelcontextprotocol/inspector/blob/main/docs/test-servers.md), [TypeScript SDK client](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/client/client/client.html))
- **Observed:** In 2026-07-28 list results can include `ttlMs` and `cacheScope`. Change delivery is through a client-opened `subscriptions/listen` stream; legacy revisions use list-changed notifications negotiated by capability. ([2026-07-28 release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [SDK notification guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md))
- **Observed:** The specification treats schemas and annotations as untrusted input. External `$ref` targets must not be fetched automatically; any opt-in resolver needs allowlisting and SSRF protection. Expensive schema constructs require resource bounds. ([MCP basic protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/index), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools))
- **Recommendation:** Paginate with page/item/byte/time ceilings, cursor-cycle detection, and correct handling of `""`. Store only bounded summaries in the retrieval index. Keep full schemas in a separate detail cache and never resolve remote references during discovery.

### Transports and side effects

- **Observed:** Standard transports are newline-delimited JSON-RPC over `stdio` and Streamable HTTP at one endpoint, optionally returning request-scoped SSE. Custom transports are permitted; legacy connection-scoped SSE exists for backward compatibility. ([transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports))
- **Implication:** Discovering a `stdio` server starts a configured subprocess, and discovering an HTTP server can authenticate and contact a remote system. Inventory refresh is therefore a side-effecting, explicit operation, not work for the latency-sensitive prompt hook. Never call `tools/call`, `prompts/get` or `resources/read` while cataloguing.

## Host behavior and scope

### Codex

- **Observed:** Codex supports MCP over `stdio` and Streamable HTTP. Server settings live in user `~/.codex/config.toml` and may also be project-scoped in `.codex/config.toml`. A server can be disabled; `enabled_tools` is an allowlist and `disabled_tools` is applied after it. ([Codex MCP](https://developers.openai.com/codex/mcp), [configuration reference](https://developers.openai.com/codex/config-reference))
- **Observed:** `/mcp` shows active MCP servers and tools; `/skills` browses skills. Codex custom prompts are deprecated in favor of skills, are explicitly invoked as `/prompts:name`, and are loaded only from top-level Markdown files in `~/.codex/prompts`. ([slash commands](https://developers.openai.com/codex/cli/slash-commands), [custom prompts](https://developers.openai.com/codex/custom-prompts))
- **Observed:** Skills are initially disclosed as bounded metadata and loaded fully only when used. Project skills are discovered from `.agents/skills` while walking from the current directory to the repository root; user skills live in `~/.agents/skills`, with admin and system tiers also supported. ([Codex skills](https://developers.openai.com/codex/skills))
- **Observed:** Current Codex source implements allowlist-then-denylist MCP filtering, defers MCP tools when native `tool_search` is available, and uses BM25 over deferred metadata to expose selected tools to the next model call. ([tool filtering](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/tools.rs), [deferred feature](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs), [BM25 tool search](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs))
- **Observed:** Codex App Server exposes a stable JSON-RPC interface. `thread/start` accepts a
  working directory, and `mcpServerStatus/list` returns the effective servers, exact tools and
  authentication state for a thread. ([Codex App Server](https://developers.openai.com/codex/app-server))
- **Implemented:** Skillful starts an ephemeral project-rooted thread and calls only
  `mcpServerStatus/list`. It bounds pages, output, servers, tools and time; stores no schemas or
  credentials; and marks nested discovery so the new thread's `SessionStart` cannot recurse.

### Claude Code

- **Observed:** Skills may be invoked as `/name` or selected automatically from their descriptions. Personal skills live in `~/.claude/skills`, project skills in `.claude/skills`, and nested directories, added directories and plugins add further scopes. Legacy `.claude/commands/*.md` still works, but skills are preferred. Skill content can contain `!` dynamic context that executes a command when loaded. ([Claude Code skills/slash commands](https://code.claude.com/docs/en/slash-commands))
- **Observed:** Claude Code MCP scopes are Local (private to the project), Project (`.mcp.json`, shareable), User and plugin/connector/managed layers. Project configuration requires trust/approval, and precedence is local, project, user, plugin, connector. `/mcp` exposes status and controls. ([Claude Code MCP](https://code.claude.com/docs/en/mcp))
- **Observed:** Claude Code's native Tool Search defers MCP tools and loads matching schemas on demand. Current documentation says only tool names and server instructions are initially present, and documents provider/model fallbacks and description truncation. ([Claude Code MCP, Tool Search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search))
- **Observed:** Tool permissions such as `--allowedTools` and `--disallowedTools` govern approval/denial of calls. They are not equivalent to MCP-server discovery or connection status. MCP tool identities use `mcp__server__tool`. ([CLI flags](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [permissions](https://code.claude.com/docs/en/permissions))

### Required identity invariant

The smallest routable MCP identity must include:

```text
runtime/client + effective workspace + redacted origin identity + server identity + tool identity
```

For example, `codex:user:github/search_issues` and `claude:project:github/search_issues` are separate capabilities. Their command, URL, credentials, filters, trust and live status may differ. Even byte-identical configuration does not justify sharing *availability*; at most it permits content-addressed reuse of a redacted schema blob. Every recommendation must name the runtime and scope it was observed in.

The refresher must therefore:

1. parse Codex and Claude configurations independently;
2. resolve each host's precedence, project root, trust, server-enabled state and tool filters independently;
3. refresh only that host's approved target;
4. cache connectivity and list results under the full identity above;
5. never infer that a tool available in one host is available in the other.

## CLI discovery and enrichment

### What can be learned without execution

- **Observed:** `npm run` adds local `node_modules/.bin` entries to a script's `PATH`; npm installs local executable links there. These are useful project candidates, but an npm script itself executes through a platform shell. ([npm run-script](https://docs.npmjs.com/cli/v9/commands/npm-run-script/), [npm folders](https://docs.npmjs.com/files/folders/))
- **Observed:** Fig's open-source autocomplete repository represents subcommands, options and arguments as TypeScript completion specs. The repository also contains generators and specs that execute shell commands, so it is not a passive data file that can safely be imported from an untrusted checkout. ([withfig/autocomplete](https://github.com/withfig/autocomplete), [generator example](https://github.com/withfig/autocomplete/blob/master/src/gh.ts))
- **Recommendation:** Build the candidate set only from direct user installations reported by
  Homebrew (`installed_on_request`), `uv tool`, pnpm, npm and Bun, plus direct dependencies of the
  current project when its lockfile or `packageManager` identifies pnpm, npm or Bun. Intersect that
  set with Carapace, Homebrew completion files, and the user's existing zsh completion directories.
  Never enumerate arbitrary `$PATH` entries, `.venv/bin`, aliases, functions, or transitive package
  dependencies. `$PATH` may resolve only the basename of an already manager-proven candidate.

Metadata priority should be:

1. explicit user override;
2. pinned, trusted static specification;
3. a strictly static subset of a pinned Fig spec (no import, generator, `loadSpec` or command execution);
4. an explicitly approved help probe;
5. basename-only fallback.

### Why recursive help is a trust boundary

- **Observed:** Node's `spawn` can execute a program directly without a shell, but it inherits the current working directory and environment unless overridden. Its timeout sends a kill signal; the Node documentation explicitly shows that killing a shell parent may leave a descendant alive. Shell mode also enables metacharacter injection. ([Node child processes](https://nodejs.org/api/child_process.html))
- **Observed:** The `cli2mcp` proof of concept parses a CLI's help and exposes it as one MCP tool, but its own security section says the target CLI is not sandboxed and should only be used where its blast radius is accepted. It currently targets `stdio`, re-reads help at startup and uses a fallback variadic-arguments tool where parsing fails. ([cli2mcp](https://github.com/RonieNeubauer/cli2mcp))
- **Implication:** Never probe `npm run`, `pnpm run`, task runners, interpreters, shells or plugin dispatchers generically. `npm run deploy --help` may run `deploy`; it is not documentation access. Never try several guessed help forms automatically.
- **Recommendation:** CLI help enrichment is opt-in per exact resolved executable and adapter. Execute an argument array without a shell, close stdin, use an empty temporary working directory, strip credentials/proxy/agent variables, disable pagers/color/telemetry where supported, cap wall time/output/depth/node count, and kill the process group. Prefer an OS/container boundary with no network and read-only filesystem. Without containment, require explicit consent and label the result `trusted-execution` rather than `safe`.

Starting bounds for evaluation, not protocol constants: depth 2, 100 nodes per executable, 1 second per node, 15 seconds total, and 256 KiB combined output per node. Adapters must define the precise help grammar and child-subcommand syntax.

## Proposed v1 data model and pipeline

### Capability summary

```text
id                  stable, runtime-qualified identity
kind                skill | command | agent | rule | mcp-server | mcp-tool |
                    mcp-prompt | mcp-resource | mcp-resource-template | cli-command
runtime             codex | claude-code | shell
scope               user | project:<realpath> | plugin:<id> | managed | system
provider             MCP server id or resolved executable realpath
canonicalName        exact host/tool or argv path used to invoke it
title/description    bounded untrusted text
invocationHint       non-executing, exact recommendation
availability         configured | pending-trust | disabled | connected | stale | unknown
provenance           config/spec/help source and parser version
risk                 static | trusted-execution | remote-contact
freshness/detailRef  cache timestamps and pointer to schema/help detail
```

Descriptions, help text and MCP schemas are data, never instructions to the scanner or Jev prompt. The router should quote/label them as untrusted and cap every field.

### Two paths

**Hot path (prompt hook):** read an already-built catalog, run provider-aware BM25, send compact summaries to Jev, and emit zero or one primary recommendation plus a small number of alternatives. Apart from the bounded Jev routing request, it performs no discovery process starts, package-manager or MCP network calls, handshakes, or help probes.

**Refresh path (explicit CLI):** scan static files and executables; ask each owning client for its
effective MCP inventory; optionally connect to approved MCP servers only in a compatibility
fallback; and probe allowlisted executables. Before waiting for discovery serialization, publish a
fail-closed marker for the affected runtime/workspace; before live work, checkpoint those partitions
as stale, then atomically publish every completed partition. A failed refresh preserves the previous
partition as diagnostic-only stale data with the error class and timestamp. It must not silently
convert failure into “no tools.”

### Retrieval

Use BM25 over names, aliases, descriptions, kind, runtime and provider, with exact-name and exact-provider boosts. Apply per-kind/provider quotas before Jev so thousands of CLI subcommands cannot crowd out skills or MCP. Jev sees summaries, not full schemas, and may abstain. Evaluate retrieval recall@K separately from final exact-tool precision and abstention quality.

Codex and Claude Code already have native lazy MCP schema search. Jev Skillful should recommend the exact canonical MCP identity and let the selected host expose/load that schema. Injecting full schemas into the prompt would duplicate host behavior, enlarge context and risk stale definitions. A dynamic proxy that changes the host's visible tools is a separate v2 product boundary.

Direct slash input should keep bypassing natural-language routing: the user already selected a command. Built-in slash commands are host controls, not capabilities Jev should infer. Deprecated Codex custom prompts and legacy Claude `.claude/commands` may be indexed for compatibility, clearly marked explicit/deprecated/legacy.

### Cache partitions and invalidation

Use separate direct-install, workspace, `codex:<scope>:<server>` and
`claude:<scope>:<server>` partitions. Keys should include real path and file identity/hash,
scanner/parser version, adapter policy, pinned spec revision, workspace real path/manifest
fingerprint, redacted server configuration identity, protocol revision, and effective
authorization/cache scope. Never persist token/header/environment values.

Writes must be lock-protected and atomic; readers need corruption recovery. Cache negative probe/connection failures only briefly. Honor MCP `ttlMs`/`cacheScope` and list-change events where available, otherwise use a conservative local TTL. A configuration/filter/trust/authentication change invalidates availability immediately.

## Implemented repository state and remaining gaps

The catalog now models concrete `mcp-tool` and `cli-command` entries alongside skills, agents,
commands, rules, and coarse static MCP fallbacks. Versioned private cache partitions carry runtime,
workspace, server/tool or executable identity, freshness, and bounded retrieval metadata. Coarse MCP
fallbacks are hidden once a runtime inventory exists, including an empty or failed inventory, and
stale entries remain diagnostic-only. The current slash heuristic still skips inputs beginning with
`/`, which is appropriate when the user already selected an explicit command.

Claude Code's implemented primary path performs a bounded `claude mcp list` health-check, then
starts its real client with hooks disabled, parses the effective MCP server and exact tool names
from `system/init`, and terminates the process immediately at init. It therefore sees Claude-managed
OAuth connectors without exporting credentials or paying
for model inference. The direct SDK path remains non-authoritative compatibility behavior only.

Current Codex documentation also describes project skill discovery from the current directory up to the repository root plus admin/system tiers. Any scanner changes should be validated against that behavior instead of assuming one project directory. Reading a Claude skill to extract content must not execute its `!` dynamic context.

## Primary-source project review

- **Tool Attention:** [asadani/tool-attention](https://github.com/asadani/tool-attention) is a reference implementation of a state-aware gate, vector retrieval, two-phase summary/schema exposure and an LRU cache. Its headline reductions come from the repository's synthetic 120-tool benchmark; they are author-reported evidence, not general production validation. Useful idea: separate selection metadata from full schema.
- **dynamic-mcp:** [asyrjasalo/dynamic-mcp](https://github.com/asyrjasalo/dynamic-mcp) is a Rust MCP proxy that groups upstream servers and exposes tools/resources/prompts on demand across several transports. It demonstrates proxy-mode feasibility, but its host setup text can lag current official Codex scope behavior; host docs remain authoritative.
- **cli2mcp:** [RonieNeubauer/cli2mcp](https://github.com/RonieNeubauer/cli2mcp) is an early `stdio` bridge based on parsed help. It is useful parser evidence, not evidence that arbitrary help probing is safe or complete.
- **withfig/autocomplete:** [withfig/autocomplete](https://github.com/withfig/autocomplete) is a large declarative completion corpus, but specs are executable TypeScript and can include dynamic generators. Consume only a pinned, statically verified subset.
- **Capability Router:** **UNVERIFIED.** The pasted conversation did not include an owner or URL, and no unique repository matching that name and described behavior could be established. No design claim here relies on it.

## Edge cases and acceptance gates

Before enabling v1 by default, test at least:

- two hosts with the same server/tool names but different command, URL, scope, filters, credentials and live status;
- project trust pending, disabled servers, allowlist+denylist precedence, permission denied versus tool unavailable;
- paginated lists with empty cursor, repeated cursor, oversized page, changing lists, list-change during refresh and legacy versus modern handshake;
- identical tool names across servers, invalid/huge schemas, cyclic or remote `$ref`, hostile descriptions and Unicode/control characters;
- manager-reported executables shadowed on `PATH`, symlink loops, broken links, non-files/devices,
  spaces, Windows executable suffixes, workspace relocation and manifest changes;
- help on stdout, stderr, non-zero success-like exits, hangs, forked descendants, terminal/pager requests, network attempts, filesystem writes and output bombs;
- concurrent refresh/read, interrupted atomic write, corrupted cache, auth change, network failure and stale-result labelling;
- retrieval overload by one kind/provider, exact-name collision, no relevant capability and Jev abstention.

Release gates should measure: static-scan latency, hot-hook latency, BM25 recall@K per kind, Jev exact identity precision, false-positive/abstention rate, stale-availability accuracy, cache size, and **zero unintended process/network execution on the hot path**.

## Deferred beyond v1

- a proxy that dynamically changes tools visible to the host;
- automatic execution of arbitrary completion specs or generators;
- unattended recursive probing of all executables;
- automatic remote `$ref` resolution;
- claiming cross-host availability equivalence;
- resources content indexing or prompt execution;
- automatic invocation of a recommended capability.
