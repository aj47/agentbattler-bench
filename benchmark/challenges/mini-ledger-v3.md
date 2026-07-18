# Mini Ledger v3 — LedgerForge

LedgerForge is a long-horizon terminal challenge for building a small, dependency-free,
crash-safe event store. The agent receives one isolated workspace and one continuous
session across twelve serialized turns. Later requirements deliberately exercise the
interactions between earlier features; passing a single happy-path command is not enough.

## Candidate contract

Leave an executable `ledger.mjs` in the workspace. Only Node.js built-ins are allowed:
no packages, network access, host files, or secrets. Commands emit exactly one JSON value
on success and exit non-zero on invalid input or a failed precondition:

```text
node ledger.mjs append --id ID --kind KIND --payload JSON
node ledger.mjs get --id ID
node ledger.mjs query --kind KIND --after-sequence N --limit N
node ledger.mjs append-batch --file EVENTS_JSON --idempotency-key KEY
node ledger.mjs export PATH
node ledger.mjs import PATH
node ledger.mjs recover
node ledger.mjs compact --keep N
node ledger.mjs replay
node ledger.mjs audit
```

The logical v2 state is represented by events with unique IDs, string kinds, JSON payloads,
strictly increasing integer sequences starting at 1, and deterministic ordering. The
implementation may use a journal, lock, snapshot, and temporary files. All mutations must
be atomic and safe to retry. A successful batch idempotency key may never append twice.

`compact --keep N` must preserve the complete logical ledger while moving the old prefix
into a checksummed snapshot. `replay` must reconstruct the same logical state from the
snapshot and journal/tail. `audit` reports corruption instead of silently repairing it.

## Twelve turns

1. Append/get foundation.
2. Atomic batches and idempotency.
3. Deterministic filtering and pagination.
4. Legacy v1 migration.
5. Crash-safe writes and journaling.
6. Recovery from interrupted writes.
7. Multi-process concurrency and stale-lock recovery.
8. Checksummed snapshots and compaction.
9. Full export/import round trips.
10. Replay and integrity audit.
11. Full regression audit and repair.
12. Scale test with 2,000 events, paging, compaction, replay, and audit.

## Scoring

There are twelve visible stages worth 80 points and five hidden holdout cases worth 20
points. Performance is scored in correctness bands, not raw wall-clock rank, so the
leaderboard measures implementation quality rather than host speed. Infrastructure
failures are recorded separately and never converted into agent scores.

The challenge is sealed independently from Mini Ledger v2. Existing v2 results remain
valid historical evidence and are not mixed into v3 ratings.

Challenge ID: `terminal-mini-ledger-v3`
