# Mini Ledger V5

V5 uses the complete Mini Ledger V4 task and verifier contract without changing its
functional requirements, stages, scoring, or holdout cases.

V5 revision 2 adds two protocol amendments. Every one of the fifteen agent turns has a hard
30-minute wall-clock limit enforced by the benchmark. Every turn prompt explicitly
tells the agent about that limit and instructs it to complete the requested work,
prioritize the most important validation, and leave the workspace runnable before
the turn ends.

The CLI wire format is explicit in every turn: `ledger.mjs` is the sole candidate
source entry point, `ledger.json` is the primary live state, `get` emits a direct
event object, `query` emits a direct event array, and replay/audit report success
directly. Verifier stages and holdout cases execute from independent source-only
candidate workspaces owned by the candidate UID. Runtime state, sidecars, locks,
and snapshots can never leak between checks or infrastructure retries.

The canonical functional specification is
[`mini-ledger-v4.md`](./mini-ledger-v4.md). The exact agent-facing prompts and timeout
policy are additionally sealed by the generated Harbor task hash and V5 challenge
descriptor.
