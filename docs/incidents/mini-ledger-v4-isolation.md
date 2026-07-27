# Mini Ledger V4 isolation incident

**Published:** July 26, 2026

**Affected result set:** `results/terminal-mini-ledger-v4`
**Status:** withdrawn from official ranking; retained as historical evidence

The original Mini Ledger V4 runners isolated each candidate workspace and harness home, but did not isolate the agent process from the parent Git checkout. Every one of the 60 runs therefore executed under a vulnerable boundary.

That does not mean every run used the vulnerability. A review of executable tool-call commands and file-path fields in all 60 published semantic traces found:

- **8 runs** with observed direct access to non-provided verifier source;
- **52 runs** with no such access observed in the captured trace;
- **6 of the 8** accessed holdout verifier source;
- **1 run** accessed the current V4 verifier, while the other 7 accessed only the closely related V3 predecessor verifier.

The eight affected traces are labeled individually in [`benchmark/incidents/mini-ledger-v4-isolation.json`](../../benchmark/incidents/mini-ledger-v4-isolation.json). “No access observed” is deliberately narrower than “clean”: the common isolation failure means none of the 60 runs qualifies as a sealed benchmark result.

## Why the historical scores remain visible

Deleting the table would hide useful evidence about the failure. The site therefore preserves every score, duration, result, and trace as an explicitly unofficial historical comparison. Runs with observed verifier access receive a visible contamination label. The historical ordering is not carried into the replacement benchmark and is not eligible for official Elo.

## Remediation

The replacement task runs through Harbor with a fresh agent container and a separate verifier container. Only `/app` crosses the boundary. Verifier source is root-only, candidate processes run as UID/GID 1000, and the verifier container drops outbound traffic before evaluation. The challenge hash binds the isolation policy so original V4 results cannot validate against the replacement.

V5 will add an explicitly sealed positive per-turn time limit. Any later model or gateway change also requires recalibrating Claude Code's native compaction window before that model can join the matrix.
