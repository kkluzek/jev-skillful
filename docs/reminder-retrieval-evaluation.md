# Reminder retrieval evaluation

## Method

The repository includes `packages/cli/scripts/evaluate-reminders.mjs`. It derives observed labels
from local Claude JSONL transcripts: a later assistant citation such as `[rule-id]` labels the
preceding user turn with that known rule, and a later `Read` of an indexed memory labels the turn
with that memory. Tool-result envelopes are not treated as user prompts. Only aggregate counts and
12-character SHA-256 prompt IDs are reported; prompt text is not committed.

This is an observational proxy, not ground truth. Claude can cite or read the wrong source, and
the last-2MB bound can omit a long turn's beginning. It nevertheless tests the actual language and
corpus rather than synthetic paraphrases.

## 2026-09-20 local measurement

The run sampled 20 labeled turns from the 200 most recent LeanHunter transcripts against 295
memory/rule documents. Six turns had memory labels and fourteen had rule labels.

| BM25 variant | Hit@3 | Recall@12 | Memory Hit@3 / @12 | Rule Hit@3 / @12 |
|---|---:|---:|---:|---:|
| without harvested citation contexts | 2/20 | 4/20 | 1/6 / 3/6 | 1/14 / 1/14 |
| with harvested citation contexts | 2/20 | 3/20 | 1/6 / 2/6 | 1/14 / 1/14 |

Observed prompt IDs: `acea6bd576f2`, `9be1de0abe87`, `e3d22f973e2f`, `7bc8eb9e4b91`,
`d4735e3a265e`, `50121e53d925`, `a1f0128de63f`, `b41915f7fff1`, `dcfae05f83fe`,
`2c53462680dd`, `884407610aa0`, `89efac4dab1f`, `0b6e8b9a5700`, `67739473876e`,
`f65d273bdd2f`, `f4f6dfba8720`, `0aa3959de921`, `3d974420d357`, `165a3808a722`,
`de3aa9509f7e`.

The result is poor and citation harvesting reduced Recall@12 by one in this sample. Jev only judges the BM25
shortlist, so it cannot recover the sixteen observed misses. The reminder layer is therefore
shipped as a conservative precision gate with explicit measurement, not as a claim of high recall.
Improving candidate generation is the next quality task; lowering the Jev threshold cannot repair
a missing candidate.

Reproduce after building:

```bash
node packages/cli/scripts/evaluate-reminders.mjs \
  --cwd /path/to/project \
  --transcripts /path/to/claude/project/transcripts \
  --limit 20
```
