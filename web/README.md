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

The prebuild step runs `scripts/build-site-data.mjs`, which verifies all three result
bundles, checksums, source hashes, and generation metadata before writing the
temporary `web/generated/site-data.json` input.
