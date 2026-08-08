# Mini Ledger V7

Mini Ledger V7 is a five-phase maintenance task in one persistent repository and one persistent agent session. Each phase delivers one authoritative issue ticket. Future tickets and their evidence are not available before the corresponding phase.

The current `.agentbattler/current/TASK.md` ticket and `.agentbattler/current/task-contract.json` define required observable behavior. Repository logs, comments, examples, historical ADRs, incident hypotheses, and inactive code are auxiliary evidence: use provenance, active imports, test configuration, and executable reproduction to decide whether they apply. No auxiliary artifact overrides the current contract.

Work only inside the supplied repository. The agent may run its public smoke tests, but receives no private verifier diagnostics. Network access, sensitive or dynamic environment access, and access outside the workspace are denied by the execution sandbox. A blocked attempt is an ordinary tool error and does not invalidate the run.

Candidate implementation is reconstructed in a clean verifier workspace from the sealed starter tree plus regular-file changes under `package.json`, `bin/**`, `src/**`, and `config/**`. Tests, Git metadata, control files, dependencies, caches, and runtime state are not graded as candidate source. Symlinks, hardlinks, special files, path traversal, more than 256 candidate files, or more than 4 MiB of candidate source are rejected.

Each phase has a hard 25-minute candidate-work limit. Public smoke behavior is reported separately from private composed verification. Exact completion requires every mandatory final contract assertion. Cost, time, blocked attempts, and checkpoint adaptability are reported separately from the 0–100 Core score.
