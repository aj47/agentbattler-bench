# Mini Ledger v1 evidence disposition

The v1 terminal evidence is withdrawn from leaderboard use. Its verifier was internally
inconsistent with the v1 prompt: it re-appended `b1` during the query stage and invoked
`query --limit 24` without the required `--kind` option during the performance stage.

The published v1 files remain available for audit history only. Corrected benchmark
execution uses the separately sealed `terminal-mini-ledger-v2` challenge and result root.
