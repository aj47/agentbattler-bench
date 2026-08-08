# Phase 5 — Reconcile lineage and survive mixed scale

Complete corruption-aware `recover`, `replay`, and `audit`, preserving every prior contract.

- Validate primary, temporary, snapshot, and exported candidates independently. Reconcile only descendants in the same lineage; reject rollback, fork, checksum corruption, and ambiguous equal-generation conflicts without mutating the last valid primary.
- `replay` reconstructs the exact logical event history across snapshot plus live tail and emits one JSON object with `ok: true`, `verified: true`, the exact integer `eventCount`, `headSha256` (SHA-256 of the repository's canonical JSON encoding of that logical event array), and the primary's integer `generation` and `lineageRootSha256`.
- `audit` independently checks schema, hashes, ids, sequences, batch receipts, snapshot boundaries, and logical replay. It emits the same verified-history fields as `replay` plus `stateSha256`, the SHA-256 of the repository's canonical JSON encoding of the complete canonical primary state.
- Under mixed large workloads, append, batch retry, both pagination modes, export/import, compaction, recovery, replay, and audit must remain deterministic and bounded without data loss.
- Invalid input and detected corruption remain non-mutating failures.

This is the complete terminal ticket.
