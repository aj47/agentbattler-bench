# AgentBattler Bench

AgentBattler Bench is a public, reproducible experiment for comparing coding-agent harnesses. Phase 1 proves the evidence loop with a narrow task: self-contained JavaScript chess agents must read one FEN from standard input and print exactly one legal UCI move.

The current roster is intentionally a fixture roster. It contains one human reference and two clearly labeled, hand-authored non-reference fixtures. The fixtures validate the runner; they are **not** Auggie, Claude Code, Codex, model-quality, or harness-comparison results. See [PRD.md](PRD.md) for the product boundary and [agents/manifest.json](agents/manifest.json) for exact provenance.

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

## Evidence

Trusted benchmark runs are limited to pushes on `main` and manual `workflow_dispatch` runs. The workflow validates the checked-in roster and suite, runs tests and the benchmark, replays the result, generates SHA-256 checksums, and uploads the sources, manifest, positions, logs, and complete generated result together.

No public workflow run or stable canonical-result URL is claimed by this checkout. GitHub Actions artifacts are convenient evidence copies with retention limits, not a durable publication layer. Until a successful run and durable public result location exist, the repository demonstrates a local proof loop rather than completing the PRD's public-evidence definition of done. Details are in [docs/evidence.md](docs/evidence.md); bundle replay steps are in [docs/replay.md](docs/replay.md).
