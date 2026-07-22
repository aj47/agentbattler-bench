# Mini Ledger v4 — withdrawn diagnostic study

> **Withdrawn from ranking (2026-07-21).** An isolation audit found that the
> native agent processes could read the parent Git checkout, including hidden
> verifier source. The 60 runs, traces, and checksums remain published so the
> failure can be investigated, but the scores below are not valid benchmark
> results. V4.1 uses Harbor 0.20 separate verifier containers and a new challenge
> hash; it will be rerun from zero.

Mini Ledger v4 is a 15-turn, long-horizon terminal benchmark designed to exercise sustained
software-engineering work in one session and workspace. The task grows a dependency-free Node.js
event ledger through atomic batches, migration, crash recovery, process concurrency, checksummed
compaction, replay, auditing, fault injection, and integrated scale stress.

The diagnostic matrix contains 60 completed runs: four harnesses × three model families × five
independent generations. All jobs were sealed in `schedule.json` before execution. No run received
human intervention, and infrastructure failures were retried rather than converted into model scores.

## Withdrawn score table (not a leaderboard)

| Rank | Harness × model | Mean | Five-run range | Mean duration |
|---:|---|---:|---:|---:|
| 1 | Claude Code × Sol | 73.44 | 55.36–81.82 | 32m 46s |
| 2 | Claude Code × Luna | 49.58 | 28.91–62.36 | 22m 45s |
| 3 | Codex CLI × Luna | 40.75 | 22.91–66.36 | 43m 27s |
| 4 | Codex CLI × Sol | 36.22 | 6.00–58.36 | 45m 18s |
| 5 | Codex CLI × Terra | 33.76 | 3.00–66.36 | 30m 58s |
| 6 | Claude Code × Terra | 30.05 | 0.00–63.36 | 25m 07s |
| 7 | Pi × Sol | 27.00 | 3.00–58.36 | 41m 25s |
| 8 | Pi × Luna | 27.00 | 19.91–40.36 | 38m 05s |
| 9 | Pi × Terra | 19.69 | 12.00–25.64 | 27m 52s |
| 10 | DotAgents × Sol | 18.65 | 0.00–58.36 | 1h 29m 03s |
| 11 | DotAgents × Terra | 15.33 | 0.00–40.64 | 55m 09s |
| 12 | DotAgents × Luna | 14.46 | 5.73–37.36 | 1h 03m 23s |

Scores use 70 points from 15 visible stages and 30 points from 11 holdout checks. The verifier
calculates each run independently; combo values above are arithmetic means of five runs. Runtime is
wall-clock duration and is evidence, not part of the score.

## Superseded observations

- The benchmark has useful headroom: the best run scored 81.82 and no run reached 100.
- Harness and model interact. Sol led in Claude Code but did not lead consistently in the other harnesses.
- Generation variance is material. Codex CLI × Terra spans 3.00–66.36 under the same declared condition.
- Longer runtime did not imply a higher score. DotAgents was generally the slowest harness in this run and
  ranked below faster conditions; this is descriptive, not a causal claim.
- Token telemetry is retained in every run record but not used to rank combinations because cache, context,
  and usage accounting differ across harnesses.

## Evidence map

- `challenge.json` — immutable protocol, scoring weights, prompt hash, and verifier hashes.
- `schedule.json` — all 60 jobs and their run keys, declared before execution.
- `summary.json` — independently scored run records and pairwise score-derived Elo calculations.
- `runs/*.json` — 60 canonical results with stage diagnostics, holdout outcomes, timing, usage, versions,
  same-session proof, and result hashes.
- `traces/*.jsonl.gz` — one downloadable semantic trace per run, containing all 15 turns.
- `trace-manifest.json` — source and publication hashes, byte counts, redaction totals, and transformation policy.
- `SHA256SUMS` — SHA-256 for the complete public release tree.

The trace source contained 26.8 GB of cumulative streams. Pi and early DotAgents repeatedly serialized the
entire growing conversation during token streaming. The public 51 MB semantic export removes only those
cumulative snapshots after retaining final messages, tool calls, results, usage events, session metadata,
and non-empty stderr. It records 586,799 omitted streaming updates and 225 redacted secret-shaped fields or
values; host paths are normalized separately. Raw workspaces are not published because they contain transient credentials and repeat the same
trace state; candidate behavior is represented by the interaction traces and verifier results.

The transformation is implemented in [`scripts/export-terminal-traces.mjs`](../../scripts/export-terminal-traces.mjs).
Each source turn is hashed in `trace-manifest.json`, making the compact publication auditable against the
retained raw M4 data.

## Reproduce and verify

```sh
npm run terminal:matrix:v4
npm run terminal:harbor:build
npm run terminal:run:v4
npm run terminal:verify:v4
npm run terminal:traces:v4
shasum -a 256 -c results/terminal-mini-ledger-v4/SHA256SUMS
```

Claude Code and DotAgents used the pinned CLIProxyAPI transport recorded in each affected run. Codex CLI and
Pi used their native routes. This transport difference is part of the harness condition and should not be
interpreted as a model-only comparison.
