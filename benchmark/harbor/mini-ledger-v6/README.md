# Mini Ledger V6 for Harbor

Generated from the canonical AgentBattler prompts and verifiers. Run with Harbor 0.20.0 or newer and pass `--resume-trajectory` so all fifteen instructions use one native agent session.

The agent and verifier use separate containers. Only `/app` is transferred. Each check copies only the regular `ledger.mjs` source entry point into a fresh candidate-owned workspace; runtime state and sidecars never cross check boundaries. Verifier-spawned candidate processes run as UID/GID 1000 while `/tests` remains root-only. Harbor 0.20's Docker provider does not support `no-network` for separate verifier environments, so the verifier starts in `public` mode, receives the candidate artifact, then drops all outbound traffic with iptables before any verifier or candidate code executes. The verifier receives no credentials.

Every agent step has a hard 60-minute wall-clock limit supplied by the sealed schedule, and every instruction explicitly tells the agent to finish within that limit.

V6 archives the exact ledger.mjs source after every turn and reruns all fifteen public stages against the final source before the holdout. Node permission mode supports real durability through FileHandle.sync() and FileHandle.datasync(); descriptor-only fs.fsync/fs.fdatasync variants are unavailable and are disclosed in every agent instruction. R8 explicitly declares the task image existing root default user so Harbor normalizes every per-turn Codex auth upload with the trusted installer CHOWN capability. Model-command children remain capability-free.
