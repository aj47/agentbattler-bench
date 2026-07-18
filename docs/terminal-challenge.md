# Terminal challenge lane

The chess lane remains the original head-to-head game benchmark. The long-running
terminal lane is a separate, versioned experiment so a coding-task score cannot be
mistaken for a chess win or silently change existing ratings.

The first challenge is [`benchmark/challenges/mini-ledger-v1.md`](../benchmark/challenges/mini-ledger-v1.md).
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
`npm run terminal:run -- --adapter PATH` executes that schedule serially. An adapter
exports `runTerminalJob({ challenge, job, challengeRoot, runDirectory })` and returns
one `agentbattler.terminal-run.v1` result with the exact scheduled identity. The runner
writes each result atomically to `results/terminal-mini-ledger/runs/<runKey>.json`.

The runner is restart-safe: completed results are skipped, infrastructure-invalid
results are visible and skipped by default, and `--retry-invalid` explicitly retries
only those infrastructure failures. A harness adapter is never guessed or silently
substituted. A missing adapter is an infrastructure problem, not an agent score.
