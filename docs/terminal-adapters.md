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
| `pi-coding-agent` | `scripts/terminal-adapter-pi.mjs` | Implemented; live session/network audit still pending |
| `claude-code` | `scripts/terminal-adapter-claude.mjs` | Implemented with explicit CLI session IDs and loopback gateway; live audit pending |
| `dotagents-mono` | `scripts/terminal-adapter-dotagents.mjs` | Implemented with a stateful container conversation; live API audit pending |

`scripts/terminal-adapter-all.mjs` dispatches by scheduled harness so the full matrix
can be run with one explicit adapter. Claude Code and DotAgents remain unpublished
until their first live terminal smoke runs prove the session-continuity and isolation
assertions on the target machine.

The exhaustive schedule already includes all declared harness/model combinations.
Run the complete schedule with `npm run terminal:run -- --adapter scripts/terminal-adapter-all.mjs`.
Use `--harness` to smoke-test one adapter subset before running the complete matrix.
