# Devin CLI generation harness

This directory documents the Devin CLI isolation contract used by
`scripts/generate-devin-suite.mjs`. Unlike the Pi harness (digest-pinned Docker
image), Devin runs as the host `devin` binary with an **ephemeral config home**.

## Isolation contract

Each generation:

1. Creates an empty temporary workspace as the child `cwd`.
2. Creates an ephemeral `XDG_CONFIG_HOME` containing only a stripped
   `devin/config.json` (no MCP servers, no hooks, foreign tool-config imports
   disabled).
3. Creates an ephemeral `XDG_DATA_HOME` and copies **only** the host
   `credentials.toml` into `devin/credentials.toml` so auth works without
   mounting the host config tree.
4. Runs:

   ```sh
   devin -p \
     --permission-mode dangerous \
     --model <pinned> \
     --config <ephemeral>/devin/config.json \
     --prompt-file benchmark/challenges/chess-agent-v1.md \
     --export <generation-dir>/devin-export.json \
     --respect-workspace-trust false
   ```

5. Hard-fails unless the workspace ends with **exactly one** file: `agent.js`.
6. Runs the six `benchmark/positions/v2.json` legality probes and records
   pass/fail in metadata (probe failures do not abort the suite — quality is
   the experimental variable).
7. Scrubs host home/username strings from exported traces before writing under
   `results/devin-suite/`.

## What is intentionally different from Codex / Pi

| Concern | Codex / Pi | Devin lane |
|---|---|---|
| Auth | ChatGPT OAuth (Codex subscription) | Devin account (`devin auth login`) |
| Models | `gpt-5.6-{terra,sol,luna}` | Whatever Devin models you pin (default env) |
| Runtime | Codex home isolation / Docker | Host `devin` binary + ephemeral XDG homes |
| Tokens | Usually available in session JSONL | Best-effort from `--export` (often partial) |
| Official sealed snapshot | Published Codex+Pi cross-harness | **Not** part of the sealed HF snapshot |

Results from this lane are exploratory harness evidence for the Devin CLI. Do not
relabel them as Codex/Pi Terra–Sol–Luna outcomes.

## Prerequisites

- Node.js 20+
- `devin` on `PATH` (tested against CLI 3000.x)
- `devin auth login` completed
- No package install step for the benchmark itself

## Commands

```sh
# one sample (cheap smoke)
AGENTBATTLER_GENERATIONS_PER_MODEL=1 npm run generate:devin-suite

# default five samples of the selected model(s)
npm run generate:devin-suite

# optional knobs
AGENTBATTLER_DEVIN_MODEL=swe-1-6-fast \
AGENTBATTLER_DEVIN_MODELS=swe-1-6-fast,opus \
AGENTBATTLER_GENERATIONS_PER_MODEL=3 \
AGENTBATTLER_RESUME=1 \
  npm run generate:devin-suite

npm run validate:devin-suite
npm run benchmark:devin-suite
npm run replay:devin-suite
```

Artifacts:

- `agents/devin-suite/` — generated sources + roster manifest
- `results/devin-suite/generations/<id>/` — export, stderr, metadata
- `results/devin-suite/generation-suite.json` — suite totals and isolation notes
- `results/devin-suite/matches/` — tournament body from `benchmark:devin-suite`
