# Mini Ledger v6: final-correctness, source-only terminal task

Implement and harden a deterministic local event ledger over fifteen sequential turns in one native agent session. V6 compares the five sealed agent harnesses using only `gpt-5.6-luna` at `max` reasoning effort, with five independent runs per harness.

Every turn has a hard one-hour (`3,600,000` ms) wall-clock limit. The schedule, harness adapter, and agent-facing prompt all seal and enforce the same per-turn budget.

The candidate starts empty. `ledger.mjs` is the only candidate source entry point and the only source file copied into fresh verifier workspaces. Local state, fixtures, locks, journals, snapshots, batches, and exports are disposable and never cross a verifier boundary. Candidate code must use only Node.js built-ins and must not access packages, network resources, host files, secrets, benchmark source, or files outside its isolated workspace.

Candidate verification uses Node's permission model. Use `fs.promises.open()` followed by `FileHandle.sync()` or `FileHandle.datasync()` for real durability barriers. Node disables the descriptor-only `fs.fsync()`, `fs.fdatasync()`, `fs.fsyncSync()`, and `fs.fdatasyncSync()` APIs whenever that permission model is active, even for workspace files; do not call those disabled variants.

Every successful command emits exactly one JSON value; invalid input exits non-zero without mutating logical or primary state. `--limit` and `--keep` accept strictly positive integers only. `ledger.lock` is the canonical stale-lock recovery interoperability artifact, even when normal concurrency uses another correct locking or compare-and-swap mechanism.

The evaluator records the public stage result after each turn, captures the exact `ledger.mjs` source after every turn, rejects traces that attempt to inspect benchmark/verifier source, and runs all fifteen public stages again against the final source. The final-correctness matrix plus the private holdout is the primary score; the historical trajectory is reported separately.
