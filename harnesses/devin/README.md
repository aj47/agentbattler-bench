# Devin CLI generation harness

This directory holds the **Pi-grade Docker image** and isolation contract used by
`scripts/generate-devin-suite.mjs`.

The image is based on the same digest-pinned Node 22 slim base used by the Pi
harness so generators can run `node agent.js` without downloading a toolchain
into `/workspace`. Devin itself is a versioned static binary from
`static.devin.ai` with a SHA-256 checksum. Credentials are never built into the
image.

## Isolation contract (default: Docker)

Each generation:

1. Builds/uses `agentbattler-devin:<DEVIN_VERSION>` (default `3000.1.27`).
2. Creates an empty temporary workspace mounted at `/workspace:rw`.
3. Creates an ephemeral Devin home mounted at `/devin-home:rw` containing only:
   - stripped `xdg-config/devin/config.json` (no MCP, no hooks, foreign imports off)
   - copied host `credentials.toml` under `xdg-data/devin/` (mode `0600`)
4. Mounts the fixed challenge prompt read-only at `/prompt/chess-agent-v1.md`.
5. Mounts a separate export directory at `/export:rw` so the workspace can stay
   "only `agent.js`".
6. Runs the container with:

   - `--read-only` root filesystem
   - `--cap-drop ALL`, `no-new-privileges`
   - bounded `--cpus`, `--memory`, `--pids-limit`
   - `--network bridge` (provider access only)
   - `--tmpfs /tmp`

7. Hard-fails unless `/workspace` ends with **exactly one** file: `agent.js`.
8. Runs the six `benchmark/positions/v2.json` legality probes and records
   pass/fail in metadata (probe failures do not abort the suite).
9. Scrubs host home/username strings from exported traces before writing under
   `results/devin-suite/`.

## Host runtime (optional escape hatch)

For machines without Docker:

```sh
AGENTBATTLER_DEVIN_RUNTIME=host npm run generate:devin-suite
```

Host mode uses ephemeral XDG homes on the host process only. Prefer Docker for
publishable evidence.

## What is intentionally different from Codex / Pi

| Concern | Codex / Pi | Devin lane |
|---|---|---|
| Auth | ChatGPT OAuth (Codex subscription) | Devin account (`devin auth login` on host; credential copy only into ephemeral home) |
| Models | `gpt-5.6-{terra,sol,luna}` | Devin models you pin (default **free** `swe-1.7`; paid models require opt-in) |
| Runtime | Codex home isolation / Docker Pi image | Docker Devin image (default) or host XDG |
| Official sealed snapshot | Published Codex+Pi cross-harness | **Not** part of the sealed HF snapshot |

## Prerequisites

- Node.js 20+
- Docker (default path)
- Host `devin` on `PATH` only for `devin auth status` preflight
- `devin auth login` completed on the host

## Commands

```sh
# build the pinned image
npm run devin:image

# one sample (free model by default: swe-1.7) — Docker by default
AGENTBATTLER_GENERATIONS_PER_MODEL=1 npm run generate:devin-suite

# host fallback
AGENTBATTLER_DEVIN_RUNTIME=host \
AGENTBATTLER_GENERATIONS_PER_MODEL=1 \
  npm run generate:devin-suite

# multi-sample free model only
AGENTBATTLER_DEVIN_MODELS=swe-1.7 \
AGENTBATTLER_GENERATIONS_PER_MODEL=3 \
  npm run generate:devin-suite

# paid models are blocked unless you opt in (quota burn):
# AGENTBATTLER_ALLOW_PAID_MODELS=1 AGENTBATTLER_DEVIN_MODEL=swe-1-6-fast ...

npm run validate:devin-suite
npm run benchmark:devin-suite
npm run replay:devin-suite
```

Artifacts:

- `agents/devin-suite/` — generated sources + roster manifest
- `results/devin-suite/generations/<id>/` — export, stderr, metadata
- `results/devin-suite/generation-suite.json` — suite totals and isolation notes
- `results/devin-suite/matches/` — tournament body from `benchmark:devin-suite`
