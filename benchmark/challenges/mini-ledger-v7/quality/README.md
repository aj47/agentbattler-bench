# Mini Ledger V7 mutation and flake gate

This evaluator-private gate executes both independently authored gold implementations through the sealed Linux verifier. It does not consult candidate tests or public smoke-test results.

The full run covers 100 deterministic hidden verifier seeds across clean and decoy twins for both gold implementations. It separately repeats one byte-identical gold candidate, pack, variant, and verifier seed 100 times. Each repeated final verification exercises all five capability families, including the syscall-level phase-3 durability probe. Outcome fingerprints exclude wall time and diagnostics but include requirement outcomes, family totals, hidden-seed commitments, verifier-image identity, and hashes of retained durability evidence.

The mutation catalog is committed by `catalogSha256` in the resulting report. Its executable mutants cover:

- critical data-loss errors: event dropping/reordering, idempotency collisions and retries, unlocked writers, omitted file/directory stable-storage barriers, and fork acceptance;
- critical shortcuts: static CLI success, cursor authentication bypass, and hard-coded forensic output;
- critical candidate-test tampering: an always-passing candidate suite paired with broken executable behavior;
- critical decoy following: trusting superseded incident artifacts or changing executable source after a disproved incident;
- noncritical validation, pagination, forensics, and audit regressions.

A mutant is killed only when the sealed verifier reports no infrastructure error and at least one catalog-declared requirement fails. A crash in the verifier or durability tracing is not counted as a kill. The gate requires at least a 95% kill rate and rejects every surviving critical mutant.

Two semantics-preserving argv-dispatch variants alter the executable-source hash of independent gold A and B. Both must still score 100 on clean and decoy twins, guarding against an overfit byte-identity verifier.

Run the complete release gate after building and sealing the verifier image:

```sh
node scripts/run-terminal-v7-quality-gates.mjs \
  --seed-key-file /absolute/private/path/to/v7-seed-key \
  --work-root /absolute/evidence/path/v7-quality-work \
  --output /absolute/evidence/path/v7-quality-gates.json
```

The work root must be empty. The command never emits the seed key. It writes a canonical report whose `evidenceSha256` binds all normalized verifier outcomes, candidate-tree hashes, pack seals, mutation transforms, verifier image/source identity, and retained evidence-tree hashes. Reduced `--seed-count`, `--repetitions-per-family`, or `--pack-ids` runs are diagnostic only and cannot satisfy the full qualification assertion.
