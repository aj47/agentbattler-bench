# Terminal adapter contract

The terminal runner is harness-neutral, but a harness is not considered supported
until its adapter has been audited against this contract. The adapter owns the
harness-specific process or container lifecycle; the runner owns schedule identity,
restart-safe persistence, and invalid-result handling.

## Required behavior

Each adapter exports:

```js
export const harnesses = ['harness-id'];
export async function runTerminalJob({ challenge, job, challengeRoot, runDirectory }) {}
```

For each job it must provide:

- one fresh workspace and isolated harness state;
- the exact prompts from the sealed challenge (fifteen for V4);
- one continuing session across every prompt;
- the scheduled model, harness version, reasoning effort, and generation identity;
- per-turn verifier results and the final holdout result;
- provider-reported token telemetry and wall-clock timing;
- sanitized public artifacts without credentials, host paths, or private traces.

The shared runner rejects an adapter that does not advertise the requested harness.
It never substitutes another harness. A harness may use a CLI, a container, or a
loopback API internally, but the resulting run record must have the same schema and
must prove session continuity.

## Current implementation status

| Harness | Adapter | Status |
| --- | --- | --- |
| `codex-cli` | `scripts/terminal-adapter-harbor.mjs` for V4 | Harbor 0.20 Docker environment with native resume |
| `pi-coding-agent` | `scripts/terminal-adapter-harbor.mjs` for V4 | Harbor 0.20 Docker environment with native resume |
| `claude-code` | `scripts/terminal-adapter-harbor.mjs` for V4 | Harbor 0.20 Docker environment with native resume |
| `dotagents-mono` | `scripts/terminal-adapter-dotagents.mjs` | Existing locked-down Docker adapter |

`scripts/terminal-adapter-all.mjs` dispatches by challenge and harness. V4 sends Claude
Code, Codex CLI, and Pi through Harbor while retaining DotAgents' isolated Docker path.
V3 and earlier remain on the legacy adapters for reproducibility.

The generated Harbor task uses fifteen ordered steps and `--resume-trajectory`. The agent
container receives the prompts and persistent `/app` workspace but not `/tests`. After each
turn, Harbor transfers only `/app` into a separate verifier container. Verifier source is
root-only, and candidate processes run as UID/GID 1000. An M4 smoke exercised all fifteen
steps: stages 2–15 used the resume path, the agent could not see `/tests`, and candidate
attempts to read the holdout verifier failed. Harbor's Docker provider does not start a
`no-network` separate verifier, so each verifier starts with public networking only long
enough to receive its artifact, then drops all outbound traffic with an iptables policy
before verifier or candidate code runs. No credentials are passed to the verifier.

The exhaustive schedule already includes all declared harness/model combinations.
Build the package with `npm run terminal:harbor:build`, then run the V4 schedule with
`npm run terminal:run:v4`.
Use `--harness` to smoke-test one adapter subset before running the complete matrix.

Codex defaults to the host's subscription `~/.codex/auth.json` through Harbor's explicit
`CODEX_AUTH_JSON_PATH` setting. Pi derives an ephemeral `openai-codex` credential from the same
subscription file inside its agent container, outside the transferred candidate artifact. Claude
Code defaults to the configured CLIProxy endpoint;
set both `AGENTBATTLER_CLIPROXY_BASE_URL` and `AGENTBATTLER_CLIPROXY_API_KEY`. Override the
comma-separated proxy roster with `AGENTBATTLER_CLIPROXY_HARNESSES` when needed. DotAgents
continues to consume the same proxy settings in its existing adapter.
