# Phase 3 — Serialize writes through process failure

Harden append, positional import, and `compact --keep N` under multiple native processes without regressing earlier phases.

- Successful operations must be linearizable: primary state is always one complete valid revision, sequences remain unique/contiguous, and compaction never changes logical query results.
- Compaction writes a validated snapshot plus a bounded live tail. Import must atomically install a complete valid export according to one observable serial order with concurrent append/compaction.
- A process killed at any write boundary may leave the prior or next complete revision, never a hybrid. `recover` must remove a stale canonical `ledger.lock`, validate recovery candidates, and preserve the newest valid lineage.
- Successful commits must show stable-storage ordering at the syscall boundary: synchronize complete replacement bytes before atomic publication, then synchronize the containing directory. Verification observes those boundaries and deterministically terminates seeded operations between them.

The current ticket is the complete specification for this phase. Later phase tickets are intentionally unavailable.
