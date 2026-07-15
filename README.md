# AgentBattler Bench

## Published benchmark data

Raw generation traces and tournament result bodies are not stored in Git history. The current sealed pointer is [`snapshots/latest.json`](snapshots/latest.json): it pins the public [Hugging Face Dataset](https://huggingface.co/datasets/techfren/agentbattler-bench) by immutable commit and mirrors the same evidence tree in a tag-scoped GitHub Release. `npm run replay:snapshot` downloads the Release archive, verifies its size and SHA-256, and replays every published tournament. See [docs/storage.md](docs/storage.md) for the publication and retention contract.

AgentBattler Bench is a public, reproducible experiment for comparing coding-agent harnesses. Phase 1 proves the evidence loop with a narrow task: self-contained JavaScript chess agents must read one FEN from standard input and print exactly one legal UCI move.

The default runner roster remains an intentionally small fixture set: one human reference and two clearly labeled, hand-authored non-reference fixtures. The public generated suites use separate manifests under `agents/model-suite/`, `agents/pi-model-suite/`, and `agents/harness-suite/`. See [PRD.md](PRD.md) for the product boundary and each manifest for exact provenance.

## Run locally

Node.js 20 or newer is the only prerequisite. There are no runtime or development dependencies to download.

```sh
npm install
npm test
npm run validate
npm run benchmark
npm run replay -- results/latest/result.json
```

`npm run benchmark` writes the canonical generated local result under `results/latest/`. Replay reads that recorded result and verifies the grades from its recorded inputs and outputs; it does not silently run a new benchmark.

To inspect an individual agent's contract:

```sh
printf '%s\n' 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' \
  | node agents/reference-baseline.js
```

## Codex model suite

The local model suite generates Terra, Sol, and Luna with one fixed prompt, Codex CLI 0.144.0, and high reasoning. Each generation starts in an empty temporary workspace with a temporary `CODEX_HOME`; only authentication is copied in. User config and rules are ignored; apps, hooks, subagents, MCP servers, web search, shell snapshots, and persistent sessions are disabled. The isolated home starts without a skills directory. The raw JSONL trace is retained so turns, duration, tokens, and tool calls can be audited.

```sh
npm run generate:model-suite
npm run validate:model-suite
npm run benchmark:model-suite
npm run replay:model-suite
```

The balanced round-robin schedules 72 games: three model pairings, six versioned positions, two seeds, and both color allocations. Outputs are split into:

- `agents/model-suite/`: generated sources and the pinned roster manifest;
- `results/model-suite/generations/`: per-model JSONL, stderr, and generation metadata;
- `results/model-suite/generation-suite.json`: aggregate generation metadata and config-isolation hashes;
- `results/model-suite/matches/`: replayable games, standings, copied inputs, and checksums.

These are exploratory local model-comparison results. They are not yet the public, immutable GitHub Actions evidence required by the PRD.

## Pi model suite using the Codex subscription

Pi is the second generation harness. It uses the same Terra, Sol, and Luna model IDs, fixed challenge prompt, high reasoning setting, five-generation sampling, legality probes, and match runner as the Codex CLI suite. Authentication is Pi's `openai-codex` OAuth provider, backed by the same ChatGPT Plus/Pro account used by Codex—not an API key.

Pi 0.80.7 is installed into a digest-pinned Docker image. Every generation runs in a read-only container with all Linux capabilities dropped, no new privileges, bounded CPU/memory/processes, and only two writable mounts: an empty workspace and a disposable Pi home. The disposable home receives only the `openai-codex` credential. Host Pi/Codex settings, sessions, extensions, skills, prompts, themes, context files, and MCP configuration are neither mounted nor copied. Pi's four standard coding tools remain available inside the container; provider network access is the only required external access.

Sign in to Codex with ChatGPT, then generate and battle the Pi suite. The runner converts the current Codex credential into Pi's `openai-codex` schema only inside the disposable suite directory; it does not read or update global Pi auth.

```sh
codex login
npm run generate:pi-suite
npm run validate:pi-suite
npm run benchmark:pi-suite
npm run replay:pi-suite
```

Artifacts are kept separate from the Codex baseline:

- `agents/pi-model-suite/`: Pi-generated sources and roster manifest;
- `results/pi-model-suite/generations/`: sanitized Pi JSON events, native session JSONL, stderr, and comparable run metadata;
- `results/pi-model-suite/generation-suite.json`: aggregate duration, turns, tokens, tool calls, subscription provenance, container identity, and host-state invariants;
- `results/pi-model-suite/matches/`: the Pi-only cross-model tournament.

After both five-generation rosters exist, build the every-to-every harness comparison:

```sh
npm run build:harness-suite
npm run validate:harness-suite
npm run benchmark:harness-suite
npm run replay:harness-suite
```

`cross-harness-all` pairs every Pi artifact with every Codex artifact. With 15 engines per harness, that is 225 artifact pairs and 2,700 color-balanced games over the six v2 positions. The website reports all of them, while its controlled harness score filters to the 900 equal-model games so the model identity is held constant.

## Devin CLI suite

Devin is an additional generation harness that does **not** use ChatGPT/Codex authentication. By default it uses a **Pi-grade Docker isolation** path: digest-built `agentbattler-devin:3000.1.27` image, read-only rootfs, all capabilities dropped, no new privileges, bounded CPU/memory/PIDs, and only three writable mounts (empty workspace, ephemeral Devin home, export dir). The ephemeral home receives a stripped config (no MCP/hooks/foreign imports) and a copy of the host Devin credentials file. Each generation must leave exactly one `agent.js`, then pass the same v2 legality probes as the other suites.

Optional `AGENTBATTLER_DEVIN_RUNTIME=host` falls back to host-process ephemeral XDG homes (with `HOME` remapped into the temp tree) when Docker is unavailable.

**Free models only by default.** The generator refuses any model outside the confirmed free allowlist (`swe-1.7`, `swe-1.6`, `swe-1.5`, `glm-5.2-high`, `kimi-k2.7`) unless `AGENTBATTLER_ALLOW_PAID_MODELS=1`. Bare `glm-5.2` / `glm-5.2-max` are not allowlisted (only the free High promo `glm-5.2-high`).

This lane is exploratory evidence for Devin CLI as a coding-agent harness. It is not part of the sealed Codex-plus-Pi Hugging Face snapshot, and Devin models are not the Codex Terra/Sol/Luna IDs. See [harnesses/devin/README.md](harnesses/devin/README.md) for the isolation contract.

Prerequisites: Node.js 20+, Docker (default), host `devin` for `auth status` preflight, and `devin auth login`.

```sh
# pin/build the Devin CLI image
npm run devin:image

# cheap smoke: one sample of the default FREE model (swe-1.7)
AGENTBATTLER_GENERATIONS_PER_MODEL=1 npm run generate:devin-suite

# host fallback without Docker isolation
AGENTBATTLER_GENERATIONS_PER_MODEL=1 npm run generate:devin-suite:host

# multi-sample on free models only (allowlist is fail-closed)
AGENTBATTLER_DEVIN_MODELS=swe-1.7,glm-5.2-high \
AGENTBATTLER_GENERATIONS_PER_MODEL=2 \
  npm run generate:devin-suite

# non-allowlisted IDs (bare glm-5.2, *fast*, *lightning*, frontier, etc.) need:
# AGENTBATTLER_ALLOW_PAID_MODELS=1

# validate/benchmark require ≥2 agents in agents/devin-suite/manifest.json
# (smoke with GENERATIONS_PER_MODEL=1 is generation-only)
npm run validate:devin-suite
npm run benchmark:devin-suite
npm run replay:devin-suite
```

Artifacts:

- `agents/devin-suite/`: generated sources and roster manifest
- `results/devin-suite/generations/`: export, stderr, metadata
- `results/devin-suite/generation-suite.json`: suite totals, runtime, and host-state hashes
- `results/devin-suite/matches/`: replayable tournament body

## Evidence

Trusted benchmark runs are limited to pushes on `main` and manual `workflow_dispatch` runs. The workflow validates the checked-in roster and suite, runs tests and the benchmark, replays the result, generates SHA-256 checksums, and uploads the sources, manifest, positions, logs, and complete generated result together.

No public workflow run or stable canonical-result URL is claimed by this checkout. GitHub Actions artifacts are convenient evidence copies with retention limits, not a durable publication layer. Until a successful run and durable public result location exist, the repository demonstrates a local proof loop rather than completing the PRD's public-evidence definition of done. Details are in [docs/evidence.md](docs/evidence.md); bundle replay steps are in [docs/replay.md](docs/replay.md).
