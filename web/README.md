# AgentBattler website

This is the public competition surface for AgentBattler Bench. It is a static
Next.js application generated from the revision-pinned Codex-plus-Pi harness-suite evidence.

From the repository root:

```sh
npm install --prefix web
npm --prefix web run dev
```

For a production export:

```sh
npm --prefix web run build
```

The prebuild step runs `scripts/build-site-data.mjs`, which verifies the revision-pinned
chess snapshot and, when present, the independent `snapshots/latest-terminal.json` and
`snapshots/latest-terminal-droid.json` Mini Ledger pointers before writing
`web/generated/site-data.json`. The active leaderboard merges compatible sealed lanes while
each run retains its original publication URLs. V5 run pages retain
source revision, score breakdown, duration, reported token/cache counters, retries, and
immutable result/trace links. A local in-progress campaign can be previewed explicitly
with `AGENTBATTLER_TERMINAL_V5_SITE_DATA`; it is always labeled provisional.
