# AgentBattler Bench

## Product

AgentBattler Bench is a public, reproducible competition for AI coding-agent harnesses.
The first release intentionally focuses on one narrow proof: can different harnesses,
given the same model and prompt, reliably produce a legal chess agent under a 50 KB
JavaScript constraint?

The product has two layers:

- **Experiment runner:** executes agents, records evidence, grades games, and publishes
  immutable GitHub Actions results.
- **Competition surface:** turns verified results into a readable leaderboard and match
  history. The UI is secondary until the experiment loop is trustworthy.

The benchmark has two explicit lanes. The chess lane is a direct agent-vs-agent game
benchmark. The terminal lane is a long-horizon coding-task benchmark with deterministic
stage verifiers and score-derived provisional Elo. Terminal results never enter chess
standings or change their rating protocol.

## MVP goal

Run a small, controlled roster of generated chess agents and make every result inspectable
and repeatable from public GitHub Actions evidence.

Success means an outside developer can:

1. inspect the exact roster, model, harness, prompt, source, and benchmark commit;
2. open the public workflow run and download its logs and artifacts;
3. replay the same chess games locally;
4. obtain the same grades and published result summary.

## MVP roster

The roster is defined in a checked-in manifest and may not change implicitly between runs.

- `reference-baseline`: human-authored reference chess agent;
- `auggie-pinned-model`: generated through Auggie with one pinned model;
- `claude-code-pinned-model`: generated through Claude Code with the same model;
- `codex-cli-pinned-model`: optional, only if the same model and evidence can be captured.
- `pi-pinned-model`: generated through Pi's subscription-backed `openai-codex` provider with the same model and evidence contract.

For the harness comparison, hold model, prompt, task positions, output contract, and budget
constant. If models differ, publish that as a separate comparison rather than mixing it into
the harness ranking.

## Agent contract

- One self-contained JavaScript file.
- Maximum size: 50 KB UTF-8.
- Input: a chess position through stdin using a documented FEN format.
- Output: exactly one UCI move through stdout.
- No package installation or runtime dependencies.
- No network access or access to benchmark secrets.
- Timeout, crash, malformed output, and illegal move are explicit recorded outcomes.

## MVP experiment

The first experiment uses a versioned set of chess positions rather than only the initial
position. Each position has a stable ID, starting FEN, expected legal-move behavior, and a
deterministic grader. Each pair receives the same positions and color allocation.

The runner records:

- agent and manifest identity;
- source and prompt hashes;
- benchmark and runner commit;
- task/position IDs and seeds;
- every input, output, move, status, and runtime;
- final game result and reason;
- validation failures and infrastructure failures;
- workflow URL and artifact checksums.

Simple ELO is acceptable for the first experiment, but the UI must call it provisional and
show games played. Rating sophistication comes after the evidence pipeline works.

## Public execution

Trusted runs execute from GitHub Actions on `main` or `workflow_dispatch`. Pull requests may
run safe validation only; they must not receive model-provider secrets or run untrusted code
with privileged credentials.

Each trusted run publishes:

- a small result summary;
- a complete replay bundle;
- validation and workflow logs;
- the committed manifest and agent sources;
- a SHA-256 checksum file;
- a stable public URL for the canonical result.

GitHub Actions artifacts are convenient copies, not the only durable record. Convex is not a
required dependency for the MVP. Harbor is explicitly deferred until the benchmark needs
long-running terminal environments, multi-step tasks, or richer agent trajectories.

## Captain workflow

The lead development agent is the **captain**. It may spawn subagents for repository audit,
experiment design, runner safety, agent generation, and workflow/provenance review. The captain
owns integration, rejects unsupported claims, runs the final experiments, and returns a short
evidence-based handoff.

Every experiment must leave behind its command, configuration, result, failure reason, and
public evidence URL. Prefer small local experiments before expensive or public runs.

## Development phases

### Phase 1 — Proof loop

Build the runner, manifest, position suite, validation, replay, result schema, and trusted
GitHub Actions workflow. Establish one public reference-versus-agent run.

### Phase 2 — Harness comparison

Generate the same chess agent through the initial roster, hold the model/prompt constant,
run paired experiments, and publish provisional comparison results.

### Phase 3 — Competition surface

Add the minimal leaderboard, run detail, replay links, and agent dossiers backed by canonical
published results.

### Phase 4 — Long-horizon terminal lane

The first general task is `terminal-mini-ledger-v2`: one isolated workspace and one
continuous session across eight turns. Its challenge manifest binds the prompt, public
verifier, holdout verifier, protocol, scoring, and exhaustive harness/model/generation
matrix. Every completed run publishes stage results, holdout cases, telemetry, hashes,
and the pairwise comparisons used for score-derived Elo. Infrastructure-invalid runs are
excluded from ratings; hard agent failures remain valid scores.

### Phase 5 — General benchmark

Only after the terminal proof loop is trusted, evaluate Harbor as an additional execution
adapter for terminal and multi-step tasks, add uncertainty-aware ratings, sealed tasks, and
a broader community adapter protocol.

## Non-goals for MVP

- Harbor integration;
- Go, checkers, or browser tasks;
- wagering or complex spectator features;
- hidden/private benchmark tasks;
- a sophisticated rating model;
- automatic self-improvement of harnesses;
- broad cloud-provider execution.

## Initial definition of done

- A fresh checkout installs and runs the local fixture benchmark.
- At least two non-reference agents can be validated under the contract.
- A trusted GitHub Actions run publishes public logs and a replayable result bundle.
- A clean machine can replay the published run and match its grades.
- The captain can explain any failure as an agent failure, grader failure, or infrastructure
  failure without guessing.
