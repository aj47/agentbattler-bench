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
- the exact eight prompts from the sealed challenge;
- one continuing session across all eight prompts;
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
| `codex-cli` | `scripts/terminal-adapter-codex.mjs` | Implemented and exercised on M4 |
| `pi-coding-agent` | — | Requires a terminal-session adapter and audit |
| `claude-code` | — | Requires a terminal-session adapter and audited gateway/session setup |
| `dotagents-mono` | — | Requires a stateful conversation adapter; the existing generation harness is single-generation |

The exhaustive schedule already includes all declared harness/model combinations.
Running it with only the Codex adapter therefore fails closed unless a supported
subset is selected explicitly with `--harness codex-cli`.
