# Mini Ledger V4 for Harbor

Generated from the canonical AgentBattler prompts and verifiers. Run with Harbor 0.20.0 or newer and pass `--resume-trajectory` so all fifteen instructions use one native agent session.

The agent and verifier use separate containers. Only `/app` is transferred. Verifier-spawned candidate processes run as UID/GID 1000 while `/tests` remains root-only. Harbor 0.20's Docker provider does not support `no-network` for separate verifier environments, so the verifier starts in `public` mode, receives the candidate artifact, then drops all outbound traffic with iptables before any verifier or candidate code executes. The verifier receives no credentials.
