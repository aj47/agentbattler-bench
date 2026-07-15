# Evidence and publication model

## Current published snapshot

[`snapshots/latest.json`](../snapshots/latest.json) is the compact source-of-truth pointer for the published Codex-plus-Pi harness-suite evidence. It pins a Hugging Face Dataset commit containing normalized tables, raw traces, generated artifacts, all three tournament bodies, and website data, plus an immutable GitHub Release archive of the same staging tree. Consumers verify exact byte sizes and SHA-256 values before use; mutable branches and expiring Actions artifacts are not canonical evidence. The storage lifecycle is documented in [storage.md](storage.md).

## What a trusted run records

The checked-in roster and position suite are immutable inputs at a particular commit. The trusted workflow packages:

- `agents/manifest.json` and every roster source file;
- the versioned position suite;
- the complete generated `results/latest/` directory;
- validation, test, benchmark, and replay logs that were reached during the run;
- a small whitelist of GitHub run metadata in `workflow.json`;
- `SHA256SUMS` covering every other file in the bundle.

The workflow has read-only repository permissions, has no model-provider secrets, declares no package-install step, and does not commit generated results back to the repository. The runner's `results/latest/` is the canonical generated location inside the run. The uploaded bundle preserves that path.

## Provenance boundary

`agents/manifest.json` is authoritative for roster identity. `reference-baseline` is human-authored. `fixture-first-legal` and `fixture-seeded-legal` are hand-authored test fixtures with null harness, model, and prompt fields. Their outcomes only demonstrate runner and replay behavior.

A future harness-generated entry needs a new stable agent ID and truthful, reviewable provenance: source hash, exact harness and version, model, prompt artifact and hash, generation budget/configuration, and generation evidence. Renaming a fixture to a harness is not acceptable provenance.

The Pi generation lane follows that boundary under `agents/pi-model-suite/` and `results/pi-model-suite/`. Its evidence records the pinned Pi and container identities, subscription-backed `openai-codex` provider, model and reasoning setting, prompt/source hashes, JSON event stream, native Pi session, duration/tokens/turns/tool calls, contract probes, and explicit host-state invariants. OAuth secrets and host configuration contents are never published.

## Current limitations

- This checkout does not prove that a GitHub Actions run has succeeded.
- It does not supply a workflow URL or stable canonical-result URL.
- GitHub Actions artifacts expire and therefore cannot be the only durable publication mechanism promised by the PRD.
- The public position suite is suitable for Phase 1 plumbing and legality coverage, not for a broad or secret benchmark.
- Fixture-vs-reference ratings must be labeled provisional and must not be interpreted as harness comparisons.
- Draws are currently deterministic stalemate or `maxPlies` adjudications; threefold repetition, insufficient material, and the fifty-move rule are deferred grader work.

These are deliberate, visible gaps. A later publication step must preserve a result immutably at a stable public URL and link it to the exact workflow run without weakening the trusted-run boundary.
