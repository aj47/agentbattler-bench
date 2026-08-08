# Mini Ledger V6 R1 permission-model durability mismatch

Date: 2026-08-06

V6 R1 challenge `challenge-b4456439096145f4` and schedule
`schedule-ccd37ff3c97a9b8a` were withdrawn before any complete run was recorded.
During the first Codex/Luna/Max run, the first seven trajectory checks exposed that Node's
permission model rejects descriptor-only `fs.fsync()`, `fs.fdatasync()`, `fs.fsyncSync()`,
and `fs.fdatasyncSync()` calls even when the descriptor refers to an allowed workspace file.
The agent had reasonably selected `fs.fsyncSync()` to implement crash-safe writes, so those
failures were caused by an undisclosed runtime capability rather than the ledger contract.

The runner and active Harbor container were stopped. Its full partial evidence was retained on
the M4 execution host under
`results/terminal-mini-ledger-v6-luna-max-invalid-challenge-b4456439096145f4`.

V6 R2 keeps the permission boundary and real durability. Every prompt now states that candidates
must use `fs.promises.open()` with `FileHandle.sync()` or `FileHandle.datasync()`, which work under
the permission model in both the native Node 26 runtime and Harbor's Node 24 verifier image.
Regression coverage proves those barriers succeed while synchronous descriptor APIs, network,
child processes, and out-of-workspace filesystem access remain denied. R2 has new challenge and
schedule hashes, so R1 evidence cannot enter its result set.
