# Hugging Face results release

The local three-harness result release is published in [`techfren/agentbattler-bench-results`](https://huggingface.co/datasets/techfren/agentbattler-bench-results) at immutable commit [`b4adcc5258d8e9612a1aae440d6307e9e3248451`](https://huggingface.co/datasets/techfren/agentbattler-bench-results/tree/b4adcc5258d8e9612a1aae440d6307e9e3248451/releases/agentbattler-hf-v1-74dfd024196c904c367c), release `agentbattler-hf-v1-74dfd024196c904c367c`.

It has two configs:

- `claude_code_only`: 900 games, canonical `result.json` SHA-256 `d812b72f7d19488afcd1b2c3577e3f847afa55e35d2eb65299cdc64fd15c0368`.
- `three_harness`: 8,100 games, canonical `result.json` SHA-256 `e3857191e4e174d9e612d7f3113f1113206a175cefbd3581b877abfe698470fb`.

The dataset deliberately contains deterministic `result.json.gz` bundles rather than the 132 MB uncompressed three-harness result. Each adjacent gzip manifest records the compressed and byte-for-byte canonical result hashes. The release has queryable one-game-per-row Parquet files; `game_json` preserves complete move and result data.

To reproduce the local package and its checks:

```sh
npm run export:hf-results
npm run verify:hf-results
```

`verify:hf-results` checks the staging checksums, Parquet row counts and unique game IDs, aggregate counts, compressed hashes, and replays both gzip bundles against their original checksum manifests.

The release is exploratory local evidence. All harnesses received the same challenge contract and position suite, but Claude Code used a third-party local Messages translation gateway to the ChatGPT Codex backend. Anthropic does not support this use with non-Claude models; gateway translation, tool semantics, and final-text source extraction may affect comparability. No Anthropic billing or OpenAI API key was used. The dataset excludes credentials, raw traces, failed attempts, checkpoint shards, logs, temporary homes, and machine-local paths. The repository has no license file, so the dataset card uses `license: other` and does not grant additional redistribution rights.

DotAgents placement is published as a separate immutable release with `dotagents_luna`, `dotagents_sol`, and `dotagents_terra` configs of 180 games each. Run `npm run verify:hf-dotagents` against that downloaded release. These are targeted same-model placement games against the three established harnesses, not a complete four-way round robin.
