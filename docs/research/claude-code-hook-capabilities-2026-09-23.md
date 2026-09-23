# Claude Code hook capabilities for adaptive capability routing

Research date: **2026-09-23**

Local Claude Code checked: **2.1.280**

Scope: recommending installed skills, CLI commands, MCP tools, agents, and slash commands during long-running Claude Code tasks without turning the recommendation layer into noise.

## Executive conclusion

`UserPromptSubmit` remains the best place for a full Skillful route because it contains the user's explicit intent and can add context before Claude starts acting. It is not sufficient for a long turn: Claude can discover a new subproblem, encounter a failure, delegate work, or enter a new implementation/testing phase without another user message.

The best mid-turn extension is **not** a router on every tool call. It is a small adaptive layer with these priorities:

1. **`PostToolBatch` as the normal mid-turn decision point.** It runs once after a complete batch of parallel tool calls and immediately before the next model request. That makes it materially less noisy than `PostToolUse`, which fires once per completed tool call. Use local state and deterministic gates first; call Jev only when the batch contains evidence of a changed phase or a newly unmet need.
2. **Failure and denial as high-signal recovery evidence, coalesced through `PostToolBatch` first.** A failed command, missing executable, unavailable MCP tool, authentication problem, or denied permission can justify a new recommendation even when the task text has not changed. Dedicated `PostToolUseFailure` or `PermissionDenied` hooks should be added only if the batch payload proves too lossy; otherwise they duplicate the same moment and increase the chance of two reminders.
3. **`SubagentStart` for one scoped recommendation at delegation boundaries.** A subagent begins with a narrower role, but this event does not contain the delegated prompt. It can receive a role-specific recommendation derived from already stored parent state; task-specific delegation routing needs a separately tested `PreToolUse` seam for the `Agent` tool.
4. **`ConfigChange`, `InstructionsLoaded`, `CwdChanged`, and `DirectoryAdded` for catalog invalidation or refresh, not recommendations.** They can make the installed-capability view stale.
5. **`Stop`, `TaskCompleted`, `TeammateIdle`, and `SubagentStop` only as rare, one-shot quality gates.** Blocking completion merely to advertise an optional tool is counterproductive and can create loops.

The confidence values should primarily control **whether, when, and how much** to inject. Raw `confidence`, `noneP`, BM25, and per-candidate probabilities are implementation diagnostics, not generally useful instructions for Claude. The normal injection should name one recommended capability and why it fits. Mention an alternative only when the decision is genuinely close and the distinction is actionable. A human-readable strength label is useful only for exceptional cases such as a recovery intervention; it should not appear on every recommendation.

Primary references:

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul)
- Local first-party evidence: `claude --version`, `claude --help`, and the installed Claude Code 2.1.280 package
- Current Skillful implementation: [`packages/cli/src/core/hooks/runner.ts`](../../packages/cli/src/core/hooks/runner.ts), [`packages/cli/src/core/hooks/render.ts`](../../packages/cli/src/core/hooks/render.ts), and [`packages/cli/src/core/hooks/installers/claude-code.ts`](../../packages/cli/src/core/hooks/installers/claude-code.ts)

## The hook execution model that constrains the design

Claude Code reads hook configuration from managed, user, project, local-project, and plugin scopes. The user-level file is `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set. The measured installation uses a custom `CLAUDE_CONFIG_DIR`. Hooks from different scopes are combined; identical handler definitions are deduplicated. The hooks reference documents these scopes and the full lifecycle. ([configuration](https://code.claude.com/docs/en/hooks#configuration))

All hook inputs share `session_id`, `transcript_path`, `cwd`, `permission_mode`, and `hook_event_name`. Current Claude Code can also provide `prompt_id` for correlation and, for subagent execution, `agent_id` and `agent_type`. The transcript file may lag behind events because writes are buffered, so it must not be treated as the sole real-time event source. ([common input fields](https://code.claude.com/docs/en/hooks#common-input-fields))

### Handler types

- **Command hooks** receive JSON on stdin and communicate by exit status, stderr, and optionally structured JSON on stdout. They can run for every event. `timeout` is in seconds; the general default is 600 seconds. Current event-specific exceptions include 30 seconds for `UserPromptSubmit`, `PreModelSwitch`, and `PostModelSwitch`, and 10 seconds for `MessageDisplay`. ([command hook fields](https://code.claude.com/docs/en/hooks#command-hook-fields))
- **HTTP hooks** POST the same JSON to an endpoint. Status `2xx` is success, non-`2xx` is non-blocking by default, and `4xx` responses can carry a structured blocking decision. The documented default timeout is 600 seconds. ([HTTP hook fields](https://code.claude.com/docs/en/hooks#http-hook-fields))
- **Prompt hooks** ask a small model to make a one-shot decision. They are supported on the current decision-capable events, including `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, and task/team completion events. `PermissionRequest` supports prompt hooks but not agent hooks. `SessionStart` supports neither prompt nor agent hooks. The documented prompt-hook default timeout is 30 seconds. ([prompt hook fields](https://code.claude.com/docs/en/hooks#prompt-hook-fields))
- **Agent hooks** run a tool-using verification subagent on the supported decision-capable events. Their documented default timeout is 60 seconds. They fit evidence-heavy verification, but are excessive for Skillful's hot routing path. ([agent hook fields](https://code.claude.com/docs/en/hooks#agent-hook-fields))
- **MCP tool hooks** invoke an already configured and connected MCP tool. At launch, `SessionStart` fires before MCP clients are available, so Claude Code skips MCP-tool hooks there; a command hook is required for context needed on the first turn. ([MCP tool hook fields](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields))

For Skillful's hot path, a command hook is the appropriate host integration: it preserves the existing local catalog/cache boundary and avoids making the hook definition itself dependent on an MCP server. The Jev request remains an implementation detail of Skillful.

### Ordering, concurrency, blocking, and errors

Within one matcher group, matching handlers run in parallel and Claude deduplicates identical handlers. Different event lifecycles are independent. This means a `PostToolUse` design must assume several router processes can start at once when tools run concurrently. `PostToolBatch` exists precisely at the batch boundary and avoids that fan-out for the normal mid-turn route. ([hook execution details](https://code.claude.com/docs/en/hooks#hook-execution-details))

For command hooks:

- exit `0`: success; stdout is parsed as JSON when valid, otherwise plain stdout can be added to context for events that support it;
- exit `2`: blocking error; stderr is fed back to Claude only for events whose lifecycle can be blocked;
- any other exit: non-blocking error shown to the user, with execution continuing;
- after exit `0`, Claude ignores stderr, so diagnostics must not rely on it becoming agent context. ([exit code output](https://code.claude.com/docs/en/hooks#exit-code-output))

Structured output can use top-level `continue`, `stopReason`, `suppressOutput`, and `systemMessage`, plus event-specific `hookSpecificOutput`. `additionalContext` is added to Claude's context for the next model request. Large context over roughly 10,000 characters is moved into a file rather than inserted inline. ([advanced JSON output](https://code.claude.com/docs/en/hooks#advanced-json-output))

Ordinary `async: true` command hooks cannot affect the event that launched them. Their structured `additionalContext` or `systemMessage` is delivered on a later turn; each event starts a separate process and Claude Code does not deduplicate running async jobs. Ordinary async hooks do not use `timeout`. Current Claude Code also documents `asyncRewake: true`: it preserves a timeout and can wake an idle Claude session on exit `2`. That is powerful but should be reserved for a genuinely important newly discovered capability or failure, never routine routing. ([run hooks in the background](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background-without-blocking))

## Pre-implementation baseline

The live user-level Claude Code configuration was inspected on 2026-09-23, and the credential launcher was exercised rather than assuming that a plain `skillful` process inherited the same environment.

- Claude Code is version `2.1.280`.
- Skillful then installed `UserPromptSubmit`, asynchronous `SessionStart` refresh, `SessionStart` resume/compact reminder delivery, and `PostCompact` state capture.
- It did **not** yet install `PostToolBatch`, `PostToolUseFailure`, `PermissionDenied`, or `SubagentStart` capability routing.
- `~/.local/bin/skillful-vercel doctor --json` reported an operational Vercel-backed provider, 547 catalog entries, and a successful live route in 803 ms against the 2,000 ms budget.
- The same user configuration already has several unrelated `UserPromptSubmit` handlers. Matching handlers run in parallel, but every returned context fragment accumulates for Claude, so a new Skillful intervention must be shorter and rarer than the existing initial recommendation.

At that point Claude received a Skillful capability suggestion at the beginning of a user turn, but no fresh capability decision merely because the task changed phase halfway through that turn. The implementation described below supersedes that baseline.

## Event-by-event assessment

The table describes command-hook behavior unless stated otherwise. `Matcher` means the regular-expression field on the enclosing hook group; an omitted matcher, an empty matcher, or `*` matches every occurrence for events that support matching.

| Event | When and useful input | Output/control | Matcher, timing, and failure behavior | Fit for Skillful |
|---|---|---|---|---|
| **SessionStart** | At session startup, resume, clear, compact, or fork. Includes `source`; may include model/agent context. | `hookSpecificOutput.additionalContext` is added before Claude begins. The event cannot block session startup; exit 2 reports stderr to the user. | Matcher filters `startup`, `resume`, `clear`, `compact`, or `fork`. The general 600 s command timeout applies unless configured otherwise. Async refresh is appropriate because its output is not needed immediately. | **Keep.** Refresh the catalog asynchronously. On `resume`/`compact`, inject at most one state-aware reminder, never a catalog dump. It is a session boundary, not a mid-task observer. |
| **UserPromptSubmit** | After the user submits text and before Claude processes it. Includes `prompt`. | Plain stdout or `additionalContext` augments the prompt. `decision: "block"`/reason or exit 2 can reject the prompt. | Matchers are ignored. Documented default command timeout: 30 s. A synchronous router adds latency directly to every user message. | **Primary full route.** Best semantic signal. Preserve a strict budget and abstention. Record the route as session state for later mid-turn comparison. Never block the user's prompt. |
| **PreToolUse** | After Claude proposes a tool call, before execution. Includes `tool_name`, `tool_input`, `tool_use_id`; MCP calls can include an `mcp_server` object. | Can `allow`, `deny`, `ask`, or `defer`; can modify tool input, add permission rules, and add context. | Matcher filters tool name, including MCP names such as `mcp__server__tool`. Documented default command timeout: 600 s. It is on the critical path. | **Do not run Jev generally.** It is too frequent and delays work. At most use a cache-only, deterministic detector for a few exact anti-patterns, without denying or rewriting tool calls. Prefer observing the completed batch instead. |
| **PermissionRequest** | When a tool needs a permission decision. Includes the requested tool/input and permission suggestions. It also fires in non-interactive/print operation; if no hook supplies a decision there, the tool is denied. | Can allow or deny, update input, and persist permission updates. | Matcher filters tool name. It is a synchronous authorization boundary. | **Not a recommender.** A capability suggestion must not silently expand permissions. It may record that the current approach requires permission so a later recovery route can prefer an already-authorized alternative. |
| **PostToolUse** | Immediately after one tool succeeds. Includes `tool_name`, original `tool_input`, `tool_response`, and `tool_use_id`. | Can add context for the next model request and can replace/update the tool output. A blocking decision can tell Claude to respond to feedback, but cannot undo the tool side effect. | Matcher filters tool name. Fires once per tool and therefore can fan out for parallel calls. | **Fallback only.** Avoid a full router here when `PostToolBatch` is available. Use narrow matchers only for uniquely valuable signals. Never route on routine Read/Glob/Grep calls. |
| **PostToolUseFailure** | After a started tool call fails. Includes `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, and possibly duration metadata. | Can add context that Claude receives before choosing the recovery step. It cannot undo or retry the failed tool itself. | Matcher filters tool name. A non-zero non-blocking hook error is shown to the user; exit 2 supplies feedback where supported. | **High-value recovery trigger.** Locally classify missing command/tool, auth, network, schema/argument, and ordinary task/test failure. Call Jev only for classes where another capability could help. Ignore user interrupts. |
| **Notification** | When Claude Code emits notifications such as permission prompts, idle prompts, authentication success, or elicitation dialogs. Includes `message`, optional `title`, and `notification_type`. | Intended for external notification handling; it is not a reliable agent-context recommendation channel. | Matcher filters notification type. | **No routing.** It observes UI state, not task intent. Using it for capability advice would notify the human at the wrong abstraction layer. |
| **SubagentStart** | When a subagent starts. Includes `agent_id` and `agent_type`; common session/transcript fields correlate it with the parent, but the event does **not** contain the delegated prompt. | `additionalContext` can be injected into the new subagent at its start. It cannot block creation. | Matcher filters agent type such as `Explore`, `Plan`, or a custom agent name. | **Limited one-shot boundary.** It can supply a role-specific or parent-state recommendation, but it cannot reliably route the delegated task by itself. Suppress anything already shown unless the subagent needs a runtime-specific capability. An experimental alternative is narrowly handling `PreToolUse` for the `Agent` tool and augmenting its prompt, but that mutates delegation and requires explicit schema tests. |
| **SubagentStop** | When a subagent is about to stop. Includes `agent_id`, `agent_type`, and the subagent's last assistant message. | A blocking decision/exit 2 can keep the subagent working and provide feedback. | Matcher filters agent type. The hook must check `stop_hook_active` to avoid loops. | **Rare quality gate only.** Do not block because an optional tool was unused. Consider one retry only when a prior high-confidence recommendation was necessary and the result explicitly reports an unresolved blocker. |
| **Stop** | When the main agent finishes responding; it does not fire on a user interrupt. Includes the final assistant message and `stop_hook_active`. | `decision: "block"` with `reason`, or exit 2, forces Claude to continue. | Matchers are ignored. A hook that causes another stop must use `stop_hook_active` and external one-shot state to prevent loops. | **Do not use for normal recommendations.** Optionally use a single recovery continuation after repeated failure and only when the expected gain is high. Prefer telemetry/audit with no injected output. |
| **TeammateIdle** | When an agent-team teammate is about to become idle. Includes `team_name` and `teammate_name`. | Exit 2 blocks idling and sends feedback; exit 0 allows it. JSON decisions are not the control mechanism here. | Matchers are ignored. | **Normally no routing.** There is little semantic input. A one-shot message is defensible only if state already records an unresolved blocker and a not-yet-shown high-confidence capability. |
| **TaskCompleted** | When a task is being marked complete, including agent-team tasks. Includes `task_id`, `task_subject`, optional `task_description`, and teammate/team fields. | Exit 2 blocks completion and feeds back the reason; exit 0 allows completion. | Matchers are ignored. | **Not an advertising surface.** It may enforce an explicit acceptance criterion, but “consider tool X” is not sufficient reason to block completion. Log recommendation adoption here instead. |
| **PreCompact** | Immediately before manual or automatic context compaction. Includes `trigger` and custom compact instructions for manual compaction. | Exit 2 or `decision: "block"` can prevent compaction. There is no reason for ordinary capability routing to do so. | Matcher filters `manual` or `auto`. | **State checkpoint.** Persist the last goal, shown capability IDs, failure counters, phase, and cooldowns. Do not route or block compaction. |
| **PostCompact** | Immediately after compaction, with `trigger` and `compact_summary`. | No decision control or additional-context injection is documented. | Matcher filters `manual` or `auto`. | **State transition only.** Current Skillful correctly stores a pending reminder and delivers it at the following `SessionStart(source=compact)`. Reset counters carefully without forgetting already shown recommendations. |
| **SessionEnd** | When the session ends. Includes `reason`, e.g. clear, logout, prompt-input exit, or another termination reason. | Cleanup only; cannot block termination. | Matcher filters the reason. | **Telemetry and cleanup.** Finalize session metrics, expire locks, and remove ephemeral state. Never make a recommendation. |

Event definitions and payload examples are in the official [hook events reference](https://code.claude.com/docs/en/hooks#hook-events). The Agent SDK exposes a smaller programmatic subset and accepts async Python callbacks with matchers; its hook output model follows the same allow/deny/context concepts. ([Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks))

### Additional current events that matter

Claude Code 2.1.280's current reference includes useful lifecycle events beyond the original requested list:

- **`PostToolBatch`**: fires once after all tool calls in a batch finish, before the next model request. Claude Code 2.1.280's local first-party schema supplies `tool_calls[]` entries containing `tool_name`, `tool_input`, `tool_use_id`, and an optional `tool_response`. It can add context but cannot undo any completed tool. This is the preferred normal mid-turn trigger. ([PostToolBatch](https://code.claude.com/docs/en/hooks#posttoolbatch))
- **`PermissionDenied`**: separates a denied permission from a tool execution failure. Use it as a recovery signal and prefer a capability that does not require the refused permission. ([hook events](https://code.claude.com/docs/en/hooks#hook-events))
- **`InstructionsLoaded`**: reports instruction-file loading. Use it to invalidate project-context fingerprints, not to inject a recommendation. ([hook events](https://code.claude.com/docs/en/hooks#hook-events))
- **`CwdChanged` and `DirectoryAdded`**: indicate that project scope changed. Invalidate or refresh the project catalog partition. ([hook events](https://code.claude.com/docs/en/hooks#hook-events))
- **`ConfigChange`**: fires when settings, skills, plugins, or related configuration changes. It can block a change except for policy-driven settings, but Skillful should use it only to refresh its catalog. ([hook events](https://code.claude.com/docs/en/hooks#hook-events))
- **`PreModelSwitch` and `PostModelSwitch`**: expose model changes. They may matter for telemetry or route-budget policy, but not for capability selection itself. ([hook events](https://code.claude.com/docs/en/hooks#hook-events))

The full event registry embedded in the locally installed 2.1.280 binary is: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, and `MessageDisplay`. Several are observability, UI, setup, or lifecycle seams rather than useful recommendation points.

### Complete event disposition for Skillful

| Event | What Skillful should do | Agent-facing recommendation? |
|---|---|---|
| `UserPromptSubmit` | Full initial route from explicit user intent; persist goal and route state. | **Yes, primary surface.** |
| `PostToolBatch` | Coalesce the whole reasoning step, detect phase/failure novelty, and conditionally reroute. | **Yes, primary mid-task surface.** |
| `PostToolUseFailure` | Optional richer failure classifier if batch serialization is insufficient. Share the batch dedupe key. | Only as a fallback, never in addition to the same batch. |
| `PermissionDenied` | Record the rejected privilege and exclude equivalent capabilities from recovery routing. | Only as a fallback if the next batch lacks the denial evidence. |
| `SubagentStart` | Reuse persisted parent/role state; the event itself lacks the delegated prompt. | At most one scoped hint, otherwise abstain. |
| `PreToolUse` | Keep for deterministic guardrails or narrowly measured delegation experiments, not remote routing. | No general recommendation. |
| `PostToolUse` | Observe adoption only when a narrow matcher is necessary; avoid per-tool fan-out. | No general recommendation. |
| `PermissionRequest` | Leave authorization semantics separate from recommendation semantics. | No. |
| `UserPromptExpansion` | Record explicit skill/command adoption; the user already selected a command. | No additional hint. |
| `TaskCreated` | Persist task subject/description for later agent-team correlation. | No by default. |
| `TaskCompleted` | Measure adoption/outcome or enforce an explicit acceptance criterion owned by the task. | No capability advertising. |
| `Stop` | Audit completion state; an optional one-shot quality gate only after separate outcome evidence. | Off by default. |
| `StopFailure` | Log API/service failure or notify the user; its output cannot steer the failed turn. | No. |
| `SubagentStop` | Optional one-shot quality gate with loop protection. | Off by default. |
| `TeammateIdle` | Agent-team quality gate only when a concrete unresolved criterion exists. | Off by default. |
| `SessionStart` | Refresh catalog asynchronously; deliver compact/resume state that was already selected. | Existing bounded reminder only. |
| `Setup` | One-time installation or CI preparation, not live task routing. | No. |
| `PreCompact` | Checkpoint route/adoption/cooldown state before context changes. | No. |
| `PostCompact` | Read `compact_summary`, update task fingerprint, and stage next `SessionStart` context. | No direct injection. |
| `SessionEnd` | Finalize metrics and delete ephemeral locks/state according to retention policy. | No. |
| `InstructionsLoaded` | Invalidate the project-context fingerprint when instructions change or load lazily. | No. |
| `ConfigChange` | Invalidate affected skill/plugin/MCP/catalog partitions. | No. |
| `CwdChanged` | Switch the active project-scope catalog partition. | No. |
| `DirectoryAdded` | Add and refresh the new repository root's partition. | No. |
| `FileChanged` | Watch only known capability/config files and invalidate their partitions. | No. |
| `WorktreeCreate` | Record the new workspace identity; do not replace Git behavior for routing. | No. |
| `WorktreeRemove` | Expire state tied to the removed workspace. | No. |
| `PreModelSwitch` | Optionally record the upcoming model for budget/telemetry policy. | No. |
| `PostModelSwitch` | Update model-specific telemetry or latency expectations. | No. |
| `Elicitation` | Do not interfere with an MCP server's request for user input. | No. |
| `ElicitationResult` | Observe only if needed for audit; never rewrite user answers for routing. | No. |
| `Notification` | Human notification plumbing only. | No. |
| `MessageDisplay` | Display transformation only; it is not a dependable context channel to Claude. | No. |

### Implemented resolution

The hook parser now preserves bounded `prompt_id`, `agent_id`, `agent_type`, and `tool_calls` fields. The installer manages `PostToolBatch`, `SubagentStart`, `SessionEnd`, `ConfigChange`, `CwdChanged`, and `DirectoryAdded` in addition to the original events. Separate `PostToolUseFailure` and `PermissionDenied` recommendation hooks remain intentionally absent: recovery evidence is coalesced at `PostToolBatch`, avoiding two reminders for one failure.

Initial rendering retains at most one primary and two runner-ups within 480 characters. Adaptive rendering is stricter: one primary, no runner-ups, no raw confidence data, and a 240-character hard cap.

## Proposed adaptive routing architecture

### 1. Separate catalog freshness, observation, decision, and injection

Do not make each hook a miniature full router.

1. **Catalog plane** — asynchronous `SessionStart` refresh plus invalidation from `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, and `DirectoryAdded`. It publishes an atomic, runtime- and scope-specific catalog snapshot.
2. **Observation plane** — lightweight synchronous event consumers normalize user prompts, tool batches, failures, delegation, and completion events into bounded facts. They never run package-manager discovery or MCP handshakes.
3. **State plane** — one per-session record, updated under an atomic lock: current goal fingerprint, current phase, last routed evidence fingerprint, recommendations shown, capabilities apparently used, failure classes, cooldown timestamps, and intervention count.
4. **Decision plane** — deterministic eligibility gate, local shortlist, then at most one bounded Jev call. The full Jev request is made only when a new decision could change Claude's next action.
5. **Injection plane** — event-specific, small, idempotent output. It never blocks ordinary tool execution, the user prompt, or completion merely to advertise a capability.

### 2. Event policy

| Tier | Events | Policy |
|---|---|---|
| A: always eligible | `UserPromptSubmit` | Full route, subject to existing length, budget, cache, and abstention gates. |
| B: high-signal | `SubagentStart`; optionally dedicated `PostToolUseFailure` and `PermissionDenied` later | At subagent start, reuse only a still-relevant parent or role-specific recommendation. Add separate failure hooks only if batch observation lacks the evidence needed for recovery. |
| C: adaptive batch | `PostToolBatch` | Route only when novelty/phase/stuck/failure gates pass and cooldown/dedupe permit it. This is the default coalescing point for both success and recovery evidence. |
| D: state only | `SessionStart`, `PreCompact`, `PostCompact`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `DirectoryAdded`, `SessionEnd` | Refresh, checkpoint, invalidate, or clean up. Inject only the existing resume/compact reminder behavior. |
| E: exceptional gate | `Stop`, `SubagentStop`, `TeammateIdle`, `TaskCompleted` | Off by default for recommendations. Allow one intervention only under a separately measured, high-confidence recovery policy. |
| Excluded | `PermissionRequest`, `Notification`, routine `PreToolUse`, routine `PostToolUse` | Authorization/UI/high-frequency surfaces are the wrong place for general routing. |

### 3. The mid-turn eligibility gate

Before calling Jev on `PostToolBatch`, require all of the following:

1. **New evidence**: a stable hash of normalized tool names, bounded inputs, result status, failure class, and inferred phase differs from the last routed evidence.
2. **Actionable change**: at least one feature indicates that another capability could change the next action. Examples: the agent started manual HTTP/browser work; a test/build phase began; a data or document format appeared; a new external service was mentioned in tool output; or the batch contains repeated searching without progress.
3. **No demonstrated adoption**: the best candidate was not already shown and its command/MCP/skill was not subsequently used.
4. **Cooldown**: no normal mid-turn route in the previous two model cycles or configurable wall-clock window. Failure routes can bypass the normal cooldown once.
5. **Budget**: the session has not exceeded a small intervention budget, initially one normal mid-turn injection plus one recovery injection per user turn.
6. **Viable shortlist**: local retrieval finds a candidate above a minimum lexical/semantic threshold before any Jev request.
7. **Material-utility gate**: deterministic phase/failure/adoption policy must establish that an interruption is justified before the request. The request then tells Choice to select `none` unless a capability would materially improve the next immediate step. A separate Noul gate was not added because this repository has measured a general “needs capability” Noul as an unreliable abstention signal.

This gate should abstain aggressively. “Claude used another tool” is not itself evidence that it needs advice.

### 4. Phase and stuck signals

Use deterministic observations rather than asking Jev to interpret an unbounded transcript:

- **discovery → implementation**: first Edit/Write after a sequence of reads;
- **implementation → verification**: tests, typecheck, build, browser check, or deployment validation begins;
- **local → external-system work**: URLs, service names, cloud CLI, or MCP-related errors appear;
- **format-specific work**: PDF, spreadsheet, presentation, image, video, or database artifacts become concrete;
- **stuck**: the same failure class repeats, command-not-found occurs, the same search/read pattern repeats without a write or successful result, or Claude explicitly reports a blocker;
- **capability adopted**: the recommended skill is invoked, the CLI invocation hint appears, the matching MCP tool runs, or a matching agent starts.

Tool inputs and outputs are untrusted data. Bound each field, redact likely secrets, never execute discovered text, and avoid uploading full outputs. A compact route query should contain the current user goal, the new phase/failure fact, and the not-yet-shown candidate summaries.

### 5. Dedupe and hysteresis

Store at least:

```text
session_id
prompt_id / user-turn generation
goal_fingerprint
catalog_fingerprint
phase
shown: capability_id -> {first_event, last_event, strength, adopted}
last_evidence_fingerprint
normal_interventions_this_turn
recovery_interventions_this_turn
cooldown_until_cycle
stop_intervention_used
```

Use hysteresis so small score changes do not flip between two tools. A new primary replaces the previous recommendation only when it exceeds the previous candidate by a meaningful calibrated margin or when new evidence invalidates the earlier choice. Never repeat the same capability in the same turn unless Claude attempted it and the new message explains a materially different invocation or recovery step.

Parallel hooks must update this state atomically. This is another reason to prefer `PostToolBatch`: a per-`PostToolUse` implementation otherwise needs both process-level locking and a short coalescing window before it even knows the batch is complete.

## Ranking and confidence presentation

Current Skillful already computes several distinct values:

- local BM25 shortlist score;
- primary choice probability;
- `noneP`, the probability that no capability is needed;
- primary `confidence`;
- per-candidate `noul` probability for runner-up ranking.

These values answer different questions. A Choice winner probability is the selected option's share of the distribution. Choice `confidence` compresses how concentrated or flat the complete distribution is; it is not an empirical probability that the recommendation will improve the task. A Noul is itself the probability of a yes answer and has no separate confidence field. TypeSafe recommends choosing thresholds according to risk and validating them on the target domain. ([TypeSafe confidence](https://docs.typesafe.ai/confidence), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul))

The current renderer intentionally emits at most one primary and two runner-ups within 480 characters, and does **not** show the numeric confidence. That is a sound default. ([current renderer](../../packages/cli/src/core/hooks/render.ts))

### Why raw numbers should remain hidden

1. A number without calibration evidence is false precision. `0.82` does not tell Claude whether historical recommendations at 0.82 were correct 82% of the time.
2. The model does not need a second probabilistic task. It needs a concrete capability identity, invocation hint, and relevant reason.
3. Frequent low-value metadata increases the chance that Claude treats every `[skillful]` block as boilerplate.
4. `noneP` and shortlist scores are especially implementation-specific. They belong in telemetry and `--explain`, not normal context.

### What to inject instead

Normal high-confidence route:

```text
[skillful] Recommended now: mcp__github__search_issues — search the repository's issue history before implementing another workaround.
```

Close decision where the alternative changes the method:

```text
[skillful] Recommended now: agent-browser — the task has moved to interactive UI verification.
Alternative if rendering is unnecessary: lightpanda.
```

Recovery route:

```text
[skillful] Recovery suggestion: use uvx ruff instead of the missing global `ruff` executable.
```

Only the close-decision case should mention an alternative. Do not inject two runner-ups merely because they cleared an independent threshold. If calibrated outcome data eventually supports strength labels, use coarse wording such as `recommended`, `possible`, or `recovery suggestion`; do not expose decimals.

The decision policy can still use precise values internally. A reasonable initial shape is:

- suppress when `noneP` is high or the winner is below the existing primary threshold;
- inject only the primary when the margin over candidate 2 is large;
- show one alternative when both candidates clear the usefulness threshold and their probability gap is small;
- require a stricter threshold for mid-turn injections than for `UserPromptSubmit`;
- require the strictest threshold for `Stop`/idle continuation;
- make the deterministic eligibility gate answer “worth interrupting now” before Choice answers “which capability”; do not add an unmeasured second semantic gate;
- evaluate each threshold against outcome lift and ignored-suggestion rate, not injection rate.

### Direct-deployment defaults

The user explicitly chose immediate activation without shadow mode. The deployed limits are:

- adaptive output active immediately after installation;
- at most one normal and one recovery intervention per `prompt_id`;
- never repeat a capability within the same user turn after it has been shown, used, or ignored for two model cycles;
- no normal mid-turn reroute until at least two `PostToolBatch` cycles after the initial prompt route;
- one primary only; alternatives remain disabled mid-task;
- cap mid-turn context at about 240 characters, half the current initial-prompt budget;
- keep the local eligibility path in the low tens of milliseconds and spend the network/Jev latency only on an eligible batch;
- keep `Stop`, `SubagentStop`, `TaskCompleted`, and `TeammateIdle` recommendation output disabled.

## Failure and loop analysis

| Failure mode | Consequence | Required guard |
|---|---|---|
| Router on every `PostToolUse` | Parallel process fan-out, repeated advice, cost and latency | Prefer `PostToolBatch`; per-tool fallback only with narrow matchers and coalescing |
| Same recommendation every cycle | Claude learns to ignore the prefix | Session dedupe plus “adopted/declined/shown” state |
| Raw transcript as query | Stale records, privacy leakage, prompt injection from tool output | Event facts first; bounded/redacted transcript tail only as fallback |
| `PreToolUse` remote route | Every tool is delayed; recommendation can arrive too late or interfere | Cache-only observation or no hook |
| `Stop` blocks repeatedly | Infinite agent loop and unbounded cost | `stop_hook_active`, external one-shot token, maximum one continuation |
| Advice after permission denial requests the same privilege | Repeated permission loop | Record denied permission and exclude equivalent candidates |
| Async route returns late | Advice applies to a later phase and becomes misleading | Evidence/goal fingerprint in result; discard if current state changed |
| Catalog changes mid-session | Stale or nonexistent recommendation | Atomic catalog versions; invalidate on config/instruction/directory events |
| Numeric confidence is uncalibrated | False authority | Hide decimals; calibrate on held-out routes and actual adoption/outcomes |
| Failure of the recommender | Main task is blocked or polluted with diagnostics | Preserve Skillful's exit-0, empty-output, fail-open contract for advisory hooks |

`asyncRewake` deserves a separate safety rule: at most one live rewake per session phase, only for a high-severity recovery or newly available capability that is likely to resolve a recorded blocker, and only after verifying that the evidence fingerprint still matches. Ordinary suggestions should wait for the next natural model turn.

## Implemented sequence

1. Added typed, bounded parsing for batch, prompt and subagent correlation fields.
2. Added private per-session/per-agent state with delivery acknowledgement, adoption tracking and `SessionEnd` cleanup.
3. Added direct `PostToolBatch` injection with one normal and one recovery slot per prompt.
4. Added one-shot `SubagentStart` inheritance for a strong, unused parent recommendation.
5. Added asynchronous refreshes for configuration and workspace-scope changes.
6. Kept `Stop`, per-tool recommendation hooks and completion/idle output disabled.
7. Added `SKILLFUL_ADAPTIVE=0` as an immediate rollback switch that leaves initial prompt routing active.

Minimum acceptance evidence should include:

- maximum hook-added latency at p50/p95/p99;
- Jev calls and injected messages per user turn;
- duplicate recommendation rate;
- recommendation adoption rate by event source;
- ignored/contradicted suggestion rate;
- recovery success after a failure-triggered injection;
- task outcome lift using the existing routed-agent-effect methodology;
- explicit loop tests for Stop, SubagentStop, TeammateIdle, and async rewake;
- clean failure when the catalog, credential, network, state file, or Jev response is unavailable.

## Concrete recommendation for Jev Skillful

The target design should be:

```text
SessionStart / config-scope events
  -> async catalog refresh or invalidation

UserPromptSubmit
  -> synchronous full route
  -> inject 0 or 1 primary (+ 1 actionable alternative only when close)
  -> persist goal and shown/adoption state

PostToolBatch
  -> cheap feature extraction
  -> novelty + phase + cooldown + budget gate
  -> optional bounded Jev route
  -> usually inject nothing; otherwise one primary before next model request

PostToolBatch failure evidence
  -> failure classifier
  -> exclude impossible/rejected options
  -> optional high-threshold recovery route

PostToolUseFailure / PermissionDenied (optional later)
  -> only when batch evidence is insufficient
  -> share the same dedupe state, never emit a second reminder for the same failure

SubagentStart
  -> reuse one scoped, deduplicated recommendation from persisted parent/role state
  -> abstain when the event lacks enough task-specific evidence

Stop / TaskCompleted / idle events
  -> telemetry by default
  -> exceptional one-shot continuation only after measured justification
```

This gives Claude the missing mid-task awareness without converting every lifecycle event into another reminder. The core product decision is not “which hook can inject text?”; many can. It is “which event adds enough new evidence to justify spending attention?” `UserPromptSubmit`, `PostToolBatch`, high-signal failures, and delegation boundaries meet that test. The rest should maintain state, refresh the catalog, or stay silent.

## Validation performed

- `claude --version` returned `2.1.280`.
- The active user-level hook configuration was installed and inspected at `$CLAUDE_CONFIG_DIR/settings.json`. It contains exactly one managed entry for `PostToolBatch`, `SubagentStart`, `SessionEnd`, `ConfigChange`, `CwdChanged`, and `DirectoryAdded`, while preserving the existing prompt, reminder and foreign hooks.
- A second install reported `unchanged`, proving idempotence. The installer created the documented `settings.json.bak.skillful.<timestamp>` backup.
- `skillful doctor` reports `Claude adaptive hooks: ok`. Two transient Vercel HTTP 503 responses exposed that the client retried only 429/529, so 502/503/504 were added to the bounded retry set. The final live route succeeded in 860 ms with decision `injected`.
- A real launcher sequence processed `UserPromptSubmit`, two `PostToolBatch` events, persisted `batchCount: 2` and phase `verification`, then removed the session state on `SessionEnd`. The provider 503 made the adaptive output correctly fail open as `{}`.
- Live state permissions were verified as `0700` for the hashed session directory and `0600` for `main.json`; cleanup removed the directory.
- The first real adaptive success suggested `pnpm test` after that command had already succeeded. A regression test then drove current-batch adoption filtering; the repeated real sequence returned `{}` and stored the CLI capability in `usedIds`.
- A fresh, read-only Claude Code `--print` session proved host integration rather than launcher-only behavior: debug logs recorded one Skillful `UserPromptSubmit` context (94 characters), five successful silent `PostToolBatch` executions, and a successful Skillful `SessionEnd`. Claude ran `pnpm test` and reported 465 passing tests across 32 files.
- CLI discovery was refreshed after adding macOS `ENOEXEC` fallback for trusted pnpm 12.5.1 shims and Bun 1.4.2's `(N installed)` header. The catalog grew from 547 to 3,523 capabilities; remaining warnings are fail-closed incomplete MCP/project partitions.
- `pnpm test` passed 465 tests across 32 files; `pnpm typecheck`, `pnpm build`, and Biome checks for all changed TypeScript files passed.
- Every repository-relative link in this document resolves to an existing file.
- The document has no trailing whitespace.
- Repository-wide `pnpm lint` still includes pre-existing generated `packages/cli/dist` diagnostics; validation therefore used a zero-error Biome run over every changed TypeScript file.
