# Northstar Mini Ledger

This dependency-free Node.js service maintains a deterministic event ledger, snapshots, idempotency receipts, and replay lineage. Run `node bin/ledger.mjs COMMAND ...` from the repository root.

Operational artifacts are inventoried in `var/artifact-manifest.json`. See `docs/data-authority.md` before using an archive or log during recovery. Implement only the current `TASK.md` and `.agentbattler/current/task-contract.json`; benchmark operators reveal later work separately.

`npm test` runs the selected dependency-free unit suite. `config/test-policy.json`
records why the archived v0 test is excluded; ADR status and the active import
graph likewise distinguish current behavior from retained historical material.
