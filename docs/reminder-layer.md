# Claude reminder layer

This layer retrieves memories and attention rules after a Claude Code resume or compaction. It is
not a second capability router and it does not run on every prompt.

## Sources and parsing

The corpus is deliberately fixed: indexed files from the current Claude project memory directory,
global `CLAUDE.md`, global `rules/*.md`, `verification-doctrine*.md`, and `##` sections from the
nearest project-root `CLAUDE.md`. A memory index entry and its real path must stay inside the real
memory directory; symlink escapes are rejected before content is read.
Dangling `[[wikilinks]]` are legal. Rule citations must be lowercase kebab IDs containing a hyphen;
flags, placeholders, numeric expressions, markdown links and double brackets are rejected.

The sources are read-only. An empty or unavailable `MEMORY.md` index is reported as a fail-open
condition rather than silently treating the corpus as healthy.

## Retrieval and delivery

Weighted BM25 creates a 12-item shortlist. Title/hook text has the highest weight, description and
harvested citation contexts follow, and body text has normal weight. Polish diacritics are folded;
identifiers and filenames produce both whole and split tokens. A light 4-gram fallback handles
minor morphology and typos.

Jev receives one structured state containing the observed query and bounded candidate excerpts,
then answers one independent `noul` relevance question per candidate in the same request. The
default threshold is 0.72; an override outside `[0, 1]` is rejected with a fail-open notice. At
most three results are injected, and output contains only a memory
title/path/one-line hook or a rule ID/lead. Full bodies are never injected.

`PostCompact` cannot inject context in Claude Code. Skillful therefore stores a pending selection
and emits `{}`; `SessionStart(source=compact)` consumes it. `SessionStart(source=resume)` selects
and injects directly. If the `PostCompact` state write fails, a separate private failure marker is
delivered by the next `SessionStart`. Session state provides a five-minute cooldown and ID-based
deduplication. Delivery is acknowledged only after stdout flushes, so a crash can duplicate a
reminder but cannot silently consume one that the host never received.

## Storage and controls

- index: `${XDG_CACHE_HOME:-~/.cache}/skillful/reminder-index-v1/`
- session state: `${XDG_STATE_HOME:-~/.local/state}/skillful/reminders/sessions/`
- deferred failures: `${XDG_CACHE_HOME:-~/.cache}/skillful/reminder-failures/`
- audit log: `${XDG_STATE_HOME:-~/.local/state}/skillful/reminder-decisions.jsonl`

All are private local files. The audit log contains query text and distinguishes a selected or
pending result from one actually shown. Corrupt or unwritable session state is reported explicitly
and is never silently replaced. Delete these files at any time to reset the layer. Tune the layer
with `SKILLFUL_REMINDER_THRESHOLD`, `SKILLFUL_REMINDER_TOP_K`,
`SKILLFUL_REMINDER_MAX_ITEMS`, `SKILLFUL_REMINDER_BUDGET_MS`, and
`SKILLFUL_REMINDER_COOLDOWN_MS`. `SKILLFUL_UPLOAD_PROMPT=false` prevents Jev transmission and
fails open explicitly. Missing keys, auth/rate/network failures and timeouts do not become
"nothing relevant"; they produce a distinct fail-open notice and Claude proceeds.
