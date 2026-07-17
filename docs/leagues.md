# Incremental leagues and immutable games

AgentBattler schedules bounded placement and targeted matches instead of rebuilding an exhaustive round robin whenever the roster changes.

## Identity layers

- A **combo** is one task/prompt, harness and version, model, reasoning effort, and generation-settings configuration. Generation index is deliberately excluded, so independent artifacts from the same configuration share a combo ID.
- A **battle protocol** pins the game schema, exact Node runtime, permission model, timeout, output limit, and adjudication contract. Scheduler or website changes do not invalidate games; a gameplay-semantic change requires a new protocol.
- A **season** pins a position-suite hash, battle protocol, and evidence lane. Distinct evidence policies can therefore remain separate without discarding either history.
- A **game key** binds the protocol, both stable agent IDs and source hashes, white/black allocation, position ID and FEN, seed, and maximum plies.

All IDs are derived from canonical JSON with SHA-256.

## Placement and targeted schedules

The initial tier vocabulary is Challenger, Contender, and Elite. A placement schedule records a provisional tier as scheduling context; rating-driven promotion and relegation remain derived leaderboard state rather than immutable game evidence.

For each selected anchor or targeted opponent, rotation zero pairs artifact 1 with artifact 1, artifact 2 with artifact 2, and so on. Later rotations shift the opposing artifact index. This replaces the five-by-five Cartesian product with five balanced pairings per rotation while keeping both colors and every selected position/seed.

A typical new five-artifact combo facing three anchors and two targeted opponents requires:

```text
5 opponents × 5 artifact pairings × 6 positions × 2 colors = 300 games
```

Additional rotations are scheduled only when more evidence is required.

Schedules are sealed before execution. Their hash covers the season, protocol, tier context, exact artifact allocations, positions, seeds, and game keys. Execution refuses a schedule if its manifest, sources, or position suite changed.

## Append-only ledger

The local ledger stores one sealed JSON object at:

```text
results/league/ledger/objects/<first-two-key-characters>/<game-key>.json
```

There is no mutable canonical index. A write uses create-only semantics. A second write for the same key must name the same sealed result or it fails as conflicting evidence.

Before executing a schedule, the runner partitions its jobs into reusable and missing keys. Reused game records remain byte-for-byte unchanged. New non-void results are appended. Void infrastructure or grader results are returned in the run output but are not accepted as completed ledger evidence, so they can be retried.

## Existing-results migration

`npm run league:import:published` reads `snapshots/latest-results.json`, downloads both result bundles from its immutable Hugging Face revision, and verifies each compressed and canonical artifact hash before importing all 9,000 games. The two legacy runs are admitted only by their exact internal result hashes and declared Node 26.3.0 runtime. Import remains fail-closed for any other run that does not name a battle protocol or registered compatibility profile.

The earlier model-suite snapshot can be migrated independently as described below.

### Model-suite release

The published `model-suite-2026-07-15-five-v1` snapshot remains immutable. Its 900 games identify Node 26.3.0 and runner commit `fb912489dcb298bb8666b2a6dce78f3a947a8104`; the corresponding source commit confirms the legacy 1,000 ms timeout and 64 KiB output limit. `npm run league:import:model-suite` downloads and verifies the immutable Release archive when it is not already cached. The importer then:

1. verifies the top-level result hash;
2. verifies and deterministically replays every game;
3. reconstructs the named v1 battle protocol;
4. wraps each untouched game in a sealed ledger entry; and
5. records its original result and optional snapshot IDs.

It never adds fields to an old game, changes a published checksum, or reclassifies its exploratory verification status. Import is idempotent.

## Compatibility rules

- Identical game key: reuse.
- New artifact hash or color allocation: new game.
- New position: only that position produces new keys; unchanged positions remain reusable.
- New suite composition with unchanged positions: a new season can still reference compatible existing game keys.
- New runtime, timeout, permission policy, output limit, or adjudication semantics: new protocol and new games.
- New rating algorithm or tier policy: recompute derived standings without rerunning games.
