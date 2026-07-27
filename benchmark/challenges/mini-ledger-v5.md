# Mini Ledger V5

V5 uses the complete Mini Ledger V4 task and verifier contract without changing its
functional requirements, stages, scoring, or holdout cases.

V5 adds one protocol amendment: every one of the fifteen agent turns has a hard
30-minute wall-clock limit enforced by the benchmark. Every turn prompt explicitly
tells the agent about that limit and instructs it to complete the requested work,
prioritize the most important validation, and leave the workspace runnable before
the turn ends.

The canonical functional specification is
[`mini-ledger-v4.md`](./mini-ledger-v4.md). The exact agent-facing prompts and timeout
policy are additionally sealed by the generated Harbor task hash and V5 challenge
descriptor.
