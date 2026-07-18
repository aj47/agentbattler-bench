# Mini Ledger v2

Mini Ledger v2 is the corrected long-horizon terminal challenge. An agent receives one
isolated workspace and one continuous session. It must build and maintain a small,
dependency-free event ledger over eight serialized turns.

The v1 evidence is retained as diagnostic history but is withdrawn from leaderboard use
because its public verifier duplicated the Turn 2 `b1` append and omitted the required
`--kind` option in the performance query. v2 seals the corrected prompt/verifier pair.

## Candidate contract

The candidate must leave an executable `ledger.mjs` in the workspace. It may create
supporting source files but may not use packages, network access, host files, or secrets.
The persistent state is `ledger.json` with exact shape
`{"schemaVersion":"agentbattler.ledger.v1","events":[...]}`. Each event has `id`,
`kind`, `payload`, and a monotonically increasing `sequence`.

The command-line interface is:

```text
node ledger.mjs append --id ID --kind KIND --payload JSON
node ledger.mjs get --id ID
node ledger.mjs query --kind KIND [--limit N]
node ledger.mjs export PATH
node ledger.mjs import PATH
node ledger.mjs recover
```

## Eight turns

1. Implement append/get and create `a1` and `a2`.
2. Add deterministic kind filtering and limits, create `b1`, and preserve earlier behavior.
3. Export the complete ledger.
4. Import an export into a fresh workspace and preserve ordering.
5. Recover after an interrupted atomic write.
6. Reject malformed input and accept the v1-compatible schema.
7. Audit the complete visible contract and repair regressions.
8. Run the final performance/audit pass against a bounded 24-record workload.

The verifier checks the records created by Turn 2; it does not append `b1` a second time.
The performance stage queries both required kinds with the declared `--kind` option.

Scoring remains 100 points: eight visible stages worth 10 points each and five holdout
cases worth 4 points each. The protocol, exhaustive matrix, session rules, and rating
method are unchanged from v1.

Challenge ID: `terminal-mini-ledger-v2`
