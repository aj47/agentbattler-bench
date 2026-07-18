# Terminal challenge lane

The chess lane remains the original head-to-head game benchmark. The long-running
terminal lane is a separate, versioned experiment so a coding-task score cannot be
mistaken for a chess win or silently change existing ratings.

The active baseline challenge is [`benchmark/challenges/mini-ledger-v2.md`](../benchmark/challenges/mini-ledger-v2.md).
Its sealed manifest binds the prompt, public verifier, holdout verifier, protocol, stage
weights, resource limits, and exhaustive combo matrix. A run is valid only when the same
session and workspace survive all eight turns, all verifier events have terminal status,
and no human intervention occurs.

## Combo coverage

The unit of comparison is a challenge combo:

```text
(challenge, harness, harness version, model, reasoning effort, generation settings)
```

Generation number identifies an independent artifact within a combo. The schedule
generator refuses missing harness/model combinations or unbalanced generation counts.
The published schedule therefore shows both the expected matrix and every concrete run
key before execution.

## Rating

Terminal runs produce a 0–100 score from eight visible stages and five holdout cases.
The provisional rating uses pairwise score-derived Elo with a one-point draw threshold.
It is explicitly not a direct agent-vs-agent execution: the raw score, all pairwise
comparisons, rating parameters, challenge hash, and run hashes are published so anyone
can recompute the standings.

Infrastructure-invalid runs are excluded from ratings and remain visible as invalid
evidence. Agent failures remain valid low scores. This distinction prevents a broken
runner, missing credentials, or a model implementation failure from being conflated.

## Execution protocol

`npm run terminal:matrix` seals `challenge.json` and the exhaustive `schedule.json`.
`npm run terminal:run -- --adapter PATH` executes that schedule with bounded
concurrency; the default concurrency is `1`. `--concurrency N` runs up to `N`
independent jobs at once. Turns within each job always remain serialized in the same
session and workspace. An adapter
exports `runTerminalJob({ challenge, job, challengeRoot, runDirectory })` and returns
one `agentbattler.terminal-run.v1` result with the exact scheduled identity. The runner
writes each result atomically to `results/terminal-mini-ledger-v2/runs/<runKey>.json`.

The runner is restart-safe: completed results are skipped, infrastructure-invalid
results are visible and skipped by default, and `--retry-invalid` explicitly retries
only those infrastructure failures. A harness adapter is never guessed or silently
substituted. A missing adapter is an infrastructure problem, not an agent score.

Parallel execution is safe because every job has its own workspace, harness home,
session, result file, and scheduled identity. Concurrency is recorded in the adapter
job metadata and should be reported with benchmark runs because provider throttling and
machine contention can affect wall time even though they do not change the verifier.

The corrected v2 manifest uses a 20-minute per-turn maximum. New schedules may opt into
an unbounded turn policy with `AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS=0` while sealing
the resulting policy into the challenge hash. Unbounded means the adapter does not kill
the process; it still records per-turn and whole-run wall time. The active v2 schedule
must not be regenerated during an existing run. The v1 evidence is retained only as
withdrawn diagnostic history because its verifier contradicted its prompt; it is not
eligible for ratings.

## Mini Ledger v3

`terminal-mini-ledger-v3` is the harder follow-on challenge. It keeps the same exhaustive
four-harness × three-model × five-generation matrix, but expands the task to twelve
interacting turns: idempotent batches, migration, crash recovery, multi-process locking,
checksummed compaction, replay, round trips, and a 2,000-event scale audit. It has its own
sealed result root and does not mix with v2 ratings.

Build and inspect its schedule with:

```sh
npm run terminal:matrix:v3
npm run terminal:verify:v3 -- --allow-incomplete
```

Run it through all adapters with `npm run terminal:run:v3`. The v3 verifier uses fixed
correctness bands and seeded hidden cases; it does not rank machines by raw wall-clock speed.
