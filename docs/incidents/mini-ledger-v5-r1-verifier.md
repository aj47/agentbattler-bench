# Mini Ledger V5-R1 verifier incident

**Published:** July 27, 2026

**Affected result set:** `results/terminal-mini-ledger-v5`
**Status:** invalidated before official publication; retained as diagnostic evidence
**Replacement protocol:** Mini Ledger V5-R2

V5-R1 fixed the parent-checkout exposure found in V4, but trial runs exposed a second class of validity failures inside the task itself. The candidate and verifier containers were separated correctly; the verifier's own state lifecycle was not.

## What failed

- Public stages reused one candidate workspace. Cleanup removed a fixed list of expected files, so implementations that used other legitimate sidecar names could leak state into later stages.
- Some verifier fixtures were created as root and then passed to the UID/GID 1000 candidate, producing permission failures unrelated to agent quality.
- The same-id concurrency oracle required exactly one zero exit code even though the prompt allowed successful idempotent retries.
- DotAgents was told that `/config-workspace`, rather than the mounted `/workspace`, was its working directory.
- Infrastructure faults in setup or holdout evaluation could be flattened into failed checks, making a broken benchmark look like a low-scoring agent.
- A retry could reuse files left by a previous attempt, so the retry was not a clean statistical trial.

These defects can both raise and lower a score. V5-R1 trial scores therefore do not measure a stable protocol and are not eligible for the leaderboard or Elo.

## V5-R2 correction

V5-R2 is a new sealed protocol rather than an in-place edit:

1. Every public stage and every holdout case starts in a fresh temporary workspace containing only a regular, non-symlink `ledger.mjs` copied from the submission.
2. Candidate-readable and candidate-writable fixtures are explicitly owned by the configured candidate UID/GID.
3. The wire contract is included in every agent turn, including exact stdout shapes and the accepted idempotent-retry behaviors.
4. Infrastructure exceptions invalidate an attempt instead of awarding zero points.
5. Every retry receives a fresh work directory. Prior workspaces and immutable attempt records are archived separately from the accepted run record.
6. The challenge seal binds the task tree, public and holdout verifiers, candidate process policy, prompt source, and execution adapters.
7. A reference implementation must pass all 15 visible stages and all 11 holdout cases before the task is released.

The correction lives under `benchmark/harbor/mini-ledger-v5-r2` and writes to `results/terminal-mini-ledger-v5-r2`. V5-R1 artifacts remain diagnostic evidence and must never be merged into V5-R2 aggregates.

## Model and gateway changes

The 30-minute turn limit is part of V5, but model context windows, gateway error shapes, and native compaction policies are not timeless constants. Any model, Claude Code version, or proxy change must rerun the compaction calibration and protocol smoke tests before that combination enters an official matrix.
