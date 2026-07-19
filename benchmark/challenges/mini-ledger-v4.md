# Mini Ledger v4: adversarial long-horizon terminal task

Implement and harden the local deterministic event ledger in an unfamiliar workspace. Work through all fifteen sequential requirements in one session. The candidate must remain executable as `ledger.mjs`, use only Node.js built-ins, and never use network access, packages, host files, or secrets.

The evaluator checks the visible contract after each turn and then runs eleven private holdout scenarios. Correctness under concurrent writers, interrupted writes, malformed state, compaction, migration, round-tripping, and large workloads matters more than a happy-path implementation.

Every command must emit exactly one JSON result on success and exit non-zero on invalid input. Existing behavior must remain compatible as later requirements are added. The evaluator may use fresh workspaces for isolated checks and a shared workspace for the integrated stress protocol.
