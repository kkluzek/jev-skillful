# Claude adaptive routing

Claude Code can change phase inside one user turn without receiving another prompt. Skillful uses
`PostToolBatch` to reconsider available capabilities once after a full parallel tool batch and
before Claude's next model call.

## Active event policy

| Event | Behavior |
|---|---|
| `UserPromptSubmit` | Full initial route. Persists the bounded goal and selected primary. |
| `PostToolBatch` | Local phase/failure/adoption gate, followed by an optional Jev route. |
| `SubagentStart` | Initializes child state and optionally passes one strong, unused parent recommendation; no Jev request. |
| `SessionEnd` | Removes the session's private adaptive state. |
| `ConfigChange`, `CwdChanged`, `DirectoryAdded` | Start an asynchronous catalog refresh. |

`PreToolUse`, `PostToolUse`, `Stop`, completion and idle hooks are deliberately not recommendation
surfaces. The first two are too frequent, and the latter group can create completion loops.

## Noise controls

- No normal reroute on the first ordinary batch.
- Discovery-only or unchanged evidence emits nothing.
- At most one normal and one recovery intervention per `prompt_id`.
- A successfully used recommendation suppresses a competing normal suggestion.
- Every MCP, CLI or agent capability observed in the current batch is recorded and removed before
  routing. A successful specialized capability also suppresses the normal reroute for that batch;
  a failed use may still open the single recovery slot.
- Already shown or previously observed-used capability IDs are removed before routing.
- Mid-task output contains one primary, no alternatives, no numeric confidence, and at most 240
  characters.
- Subagents always receive a private child state so their own later batches can reroute. They
  receive visible parent context only when `noneP <= 0.2`, Choice confidence is at least
  `0.6`, the capability is not itself an agent, and the parent has not already used it.
- `SKILLFUL_ADAPTIVE=0` disables only this layer.

Confidence and probability remain telemetry and `--explain` data. Choice confidence describes the
concentration of the offered-option distribution; it is not displayed as a probability that the
suggestion will improve the task.

## Private state

State lives below:

```text
${XDG_STATE_HOME:-~/.local/state}/skillful/adaptive-v1/sessions/<session-hash>/<agent-hash>.json
```

The main agent uses `main.json`. Directories are mode `0700`, files are mode `0600`, session and
agent identifiers appear only as SHA-256 path components, and the active user goal is bounded to
1,000 characters. State is not telemetry. `SessionEnd` recursively removes only that hashed session
directory. If a crash prevents `SessionEnd`, the next prompt prunes hashed session directories older
than 24 hours; the scan is bounded to 256 entries.

The route query contains the bounded original goal, the inferred phase, the recent tool names and a
fixed failure class. Raw tool output is not sent to Jev. Tool input is inspected locally only for
phase and artifact-type detection.

## Fail-open behavior

Every adaptive failure returns `{}` and exit code `0`: missing state, malformed tool payloads,
catalog failures, provider failures, timeouts, disk errors and unexpected exceptions cannot stop
Claude's turn. A degraded mid-task route stays silent instead of repeating the initial setup
reminder inside an agentic loop.
