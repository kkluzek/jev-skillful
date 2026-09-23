# Skillful

A capability router for coding agents. It watches your prompts, decides whether an installed
skill, exact MCP tool, CLI subcommand, subagent or slash command is relevant, and injects at most
one suggestion into the agent's context.

```bash
npx @mrgoonie/skillful install
```

You bring a TypeSafe, Vercel AI Gateway, or OpenRouter key. There is no Skillful server or
account, and nothing is collected.

## The problem

The usual way to make an agent aware of a skill is to list every skill in the context window. This
does not scale. [Skill Retrieval Augmentation for Agentic AI](https://arxiv.org/abs/2604.24594)
found that as the skill corpus grows, context budget is consumed quickly and **the agent becomes
less accurate at picking the right skill**. The same work also found that current agents tend to
load skills at a similar rate regardless of whether the task actually needs an external capability
— so the bottleneck is both *which* capability and *whether* to load one at all.

That is the situation this project targets. A development machine here has around 230 skills across
two agent runtimes, plus MCP servers, subagents and commands.

## How it works

```text
Your prompt
  │
  ├─ Hook (Claude Code / Codex / Pi / OMP)
  │    cache lookup by prompt hash + catalog fingerprint + provider/policy context
  │    hit  → inject (<250ms)
  │    miss → route within a 2000ms budget
  │    error or over budget → inject one reminder line, never fail the prompt
  │
  ├─ Claude adaptive routing (inside the same user turn)
  │    PostToolBatch → local phase/failure/adoption gate → optional Jev route
  │    at most 1 normal + 1 recovery suggestion per prompt; 240-character cap
  │    SubagentStart can inherit one strong, unused parent recommendation
  │
  ├─ Session-start refresh (client-specific, asynchronous)
│    exact MCP tools for this Codex or Claude Code configuration
│    active Codex/Claude plugins and their exact skill/command names
│    direct Homebrew/uv/npm/pnpm/Bun installs that have Carapace/Homebrew/zsh completion
  │    Carapace export → bounded recursive command trees without running target CLIs
  │
  ├─ Claude reminder layer (resume and after compaction)
  │    fixed memory/rule surfaces → weighted BM25 top 12 → one batched Jev gate
  │    inject at most 3 titles/hooks; never inject a memory or rule body
  │
  ├─ Catalog scan (local, no tokens or child processes)
  │    cached tools plus skills, agents and exact slash invocations, normalised
  │    BM25 + per-kind quota → a bounded shortlist
  │
  ├─ One Jev request (TypeSafe / Vercel AI Gateway / OpenRouter)
  │    a `choice` question over the shortlist plus `none`
  │    per-candidate `noul` questions to rank the runners-up
  │
  └─ Initial prompt: at most 1 primary + 2 runner-ups; mid-task: 1 primary or nothing
```

Two design choices are worth stating because they are deliberate:

**The shortlist is what the model sees, not what gets injected.** Injecting the whole shortlist
on every prompt would reproduce the exact "enumerate every available skill" pattern that made
retrieval necessary. Initial prompt routing is capped at one suggestion plus two alternatives;
adaptive mid-task routing emits one suggestion only.

**Abstaining is a first-class outcome.** A prompt that does not need a capability gets nothing
injected. Trivial prompts, questions and chit-chat are handled by the `none` option in the same
question that picks the capability, rather than by a separate classifier with its own failure mode.

## Jev providers

Skillful can call the same Jev decision API through three billing routes:

| Provider | Key | Endpoint | Default model |
|---|---|---|---|
| TypeSafe | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` |

Set `SKILLFUL_PROVIDER=typesafe|vercel|openrouter` to isolate the billing route. Without it,
Skillful uses the first non-empty key in that table order. An explicit provider with a missing key
fails closed; it never falls through to another provider. `SKILLFUL_MODEL` and
`SKILLFUL_BASE_URL` remain explicit overrides.

This fork also includes a macOS Keychain launcher that shares the dedicated Vercel credential used
by the `typesafe-mcp` fork without writing it to Claude or Codex configuration:

```bash
scripts/install-skillful-vercel-macos
```

See [Vercel provider setup](docs/install.md#vercel-ai-gateway-from-macos-keychain) and the
[editable fork workflow](FORK.md).

## What is actually measured

This section reports what has been measured, and nothing that has not.

**Routing quality** is measured by `skillful eval` against 67 development fixtures and 22 holdout
fixtures, over a corpus of 533 sanitised catalog entries:

| Metric | Result | Target |
|---|---|---|
| `recall@K` (holdout) | **0.600** | 0.90 |
| `recall@K` (development) | **0.824** | 0.90 |
| MRR (development) | 0.574 | — |
| `top1Accuracy` (development) | 0.731 | 0.80 |
| `noneF1` (development) | 0.813 | 0.80 |
| `agreementRate` | 0.985 | 0.90 |
| p95 route latency | 406ms | 1500ms |

**The routing targets are not met, and the gap is not a tuning problem.** `recall@K` depends only
on the shortlist, which is built entirely by BM25 and the quotas, so it can be swept with no API
calls at all. Growing the shortlist from 13 entries to 21 raised recall from 0.600 to 0.650. Recall
saturates well below the target because BM25 matches tokens: it retrieves a capability only when a
prompt happens to share vocabulary with a capability description, and prompts are phrased as tasks
while descriptions are phrased as capability statements. Closing the gap needs a different
retrieval stage, not a different parameter.

Two further limits, recorded rather than tuned away. Prompts in Vietnamese reached `recall@K`
0.429, matching only through loanwords, because capability descriptions are written in English and
there is no shared vocabulary to match on. And MCP retrieval cannot be measured fairly against a
sanitised corpus, because an MCP entry's catalog description is the transport string read from a
config file, which after redaction carries no retrievable text.

**The outcome benchmark harness is built, and the benchmark has not been run.** Whether injecting a
suggestion actually makes an agent complete a task better is the question that matters, and it is
unanswered. The harness is complete — real SWE-bench tasks, frozen Docker environments, a paired
analysis tested against hand-computed answers — and no `bench-outcome.json` exists, because none was
fabricated. Two of four runtimes cannot complete a headless run here: Claude Code's OAuth session has
expired and Codex was quota-limited on the measurement machine at the time.

So the status is **not run**, which is not the same as `not-proven`. `not-proven` would mean the data
was collected and the interval spans zero; here there is no interval at all. Until there is, this
project claims a routing improvement and **makes no claim about task outcomes**. Any use of the words
"makes your agent better" would be unsupported. See [docs/bench.md](docs/bench.md).

A caution worth carrying: an earlier version of these numbers showed `recall@K` 0.804 on the
development set. That figure was inflated. MCP descriptions contained private service URLs and
BM25 was matching a server's name out of the URL. Sanitising the corpus removed the text and the
number fell to its honest value. A retrieval result that depends on a leaked URL is not a result.

## What it has been verified to do

- Installs a hook for all four runtimes, idempotently, with a timestamped backup before modifying
  any file, and removes exactly what it added.
- Leaves another tool's hooks untouched. If a configuration file cannot be parsed, install reports
  it and writes nothing.
- Fails open. A missing key, an unreachable network, an upstream error, or an expired budget each
  produce one reminder line and exit 0. Nothing is ever written to stderr, because a hook that
  disturbs an agent session is worse than one that suggests nothing.
- A cold route through the hook took 1446ms against a 2000ms budget; the same prompt again hit the
  cache in 221ms with byte-identical output; `thanks!` injected nothing.
- Session refresh is asynchronous. A newly started conversation never waits for discovery. Before
  waiting for the shared cache lock, refresh publishes a fail-closed marker that immediately hides
  affected old partitions; it then checkpoints and replaces completed partitions atomically. Stale
  or failed entries remain diagnostic-only.
- Claude Code reroutes only at a meaningful `PostToolBatch` phase change or a classified failure.
  A successful use of the current recommendation suppresses a competing suggestion. State is
  deduplicated per prompt and subagent, and `SessionEnd` removes it.
- A read-only Claude Code 2.1.280 session on 2026-09-23 recorded the Skillful prompt context, five
  live `PostToolBatch` hooks and successful `SessionEnd` cleanup while running all 465 tests.

## Commands

```bash
npx @mrgoonie/skillful install              # install the hook for every runtime present
npx @mrgoonie/skillful doctor               # is it working? includes a live trial route
npx @mrgoonie/skillful uninstall            # remove it, leaving other hooks alone

npx @mrgoonie/skillful catalog --summary    # what capabilities were found
npx @mrgoonie/skillful refresh --json       # refresh exact MCP tools and installed CLI commands
npx @mrgoonie/skillful route --prompt "..." --explain   # the decision, with the shortlist and scores
npx @mrgoonie/skillful eval --recall-only   # sweep quotas offline, no key and no cost
npx @mrgoonie/skillful eval --replay FILE   # score against recorded responses, no key
npx @mrgoonie/skillful export-case --prompt "..."   # a redacted case to paste in an issue
```

## Privacy

- The prompt is sent to the selected Jev provider endpoint as part of the routing request.
- At session start, Skillful refreshes only the selected runtime. Codex is queried through an
  ephemeral App Server thread. Claude Code first performs a bounded `claude mcp list` health-check,
  then is queried through its own effective `system/init`
  inventory, which includes that client's managed connectors and OAuth state. The fixed inventory
  probe disables hooks and is terminated as soon as init arrives, before model inference. A
  fail-closed compatibility fallback may send MCP `initialize` and `tools/list` only to configured,
  approved targets. Skillful never calls an MCP tool and never sends the user's prompt to MCP.
- `SKILLFUL_UPLOAD_PROMPT=false` routes without transmitting the prompt. The shortlist is still
  chosen locally, so this trades retrieval quality for not sending the text.
- Route decisions are cached in `~/.cache/skillful/routes.json` so a repeated prompt does not pay
  twice. The cache never stores your prompt and never stores a key.
- Capability metadata is cached privately in `~/.cache/skillful/capabilities-v2.json`. It contains
  names, descriptions and local source paths, but no MCP credentials.
- Claude reminder indexes and per-session deduplication state are private local files. The reminder
  decision log contains the observed query text and therefore is sensitive; see
  [docs/reminder-layer.md](docs/reminder-layer.md) for paths, retention and disable controls.
- Claude adaptive routing stores the current prompt and bounded recommendation state in a private
  `0600` file below `~/.local/state/skillful/adaptive-v1/` (or `XDG_STATE_HOME`). It is used only
  for the active session, removed by the installed `SessionEnd` hook, and pruned after 24 hours if
  a crash prevents normal cleanup. It is not telemetry and
  is never uploaded independently; only the bounded adaptive route query reaches the selected Jev
  provider. Set `SKILLFUL_ADAPTIVE=0` to disable this layer without disabling initial prompt routing.
- Nothing is collected. There is no telemetry that leaves the machine.

## Security

`skillful install` writes an extension for Pi and OMP. Extensions run with your full user
permissions. Skillful's is about forty lines: it spawns the CLI, reads one line of JSON back, and
injects it. Read it at `~/.pi/agent/extensions/skillful/index.ts` before trusting it. See
[SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Documentation

- [docs/install.md](docs/install.md) — install, uninstall, doctor, troubleshooting
- [docs/architecture.md](docs/architecture.md) — the catalog, the router, the four hook mechanisms
- [docs/routing.md](docs/routing.md) — the questions, thresholds and quota design
- [docs/evaluation.md](docs/evaluation.md) — how the router is measured, and the results
- [docs/measurement.md](docs/measurement.md) — the three layers, RAE, and how to read the dashboard
- [docs/telemetry.md](docs/telemetry.md) — what is logged, what is never logged, and how to turn it off
- [docs/bench.md](docs/bench.md) — the outcome benchmark, its evidence threshold, and its status
- [docs/reminder-layer.md](docs/reminder-layer.md) — Claude memory/rule retrieval and its limits
- [docs/adaptive-routing.md](docs/adaptive-routing.md) — mid-task Claude routing, limits and state
- [docs/reminder-retrieval-evaluation.md](docs/reminder-retrieval-evaluation.md) — observed BM25 gate results
- [docs/troubleshooting.md](docs/troubleshooting.md) — when it does not work

## Contributing

Contributions are welcome, and the most valuable one is a bad routing case. Open an issue with
`skillful export-case` output; that is how the fixture set grows into something that measures
reality rather than the author's guesses.

A change to routing, retrieval, thresholds or fixtures is expected to include eval numbers. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
