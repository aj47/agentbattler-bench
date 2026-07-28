# Terminal challenge lane

The chess lane remains the original head-to-head game benchmark. The long-running
terminal lane is a separate, versioned experiment so a coding-task score cannot be
mistaken for a chess win or silently change existing ratings.

The active baseline challenge is [`benchmark/challenges/mini-ledger-v2.md`](../benchmark/challenges/mini-ledger-v2.md).
Its sealed manifest binds the prompt, public verifier, holdout verifier, protocol, stage
weights, resource limits, and exhaustive combo matrix. A run is valid only when the same
session and workspace survive all eight turns, all verifier events have terminal status,
and no human intervention occurs.

## Combo coverage

The unit of comparison is a challenge combo:

```text
(challenge, harness, harness version, model, reasoning effort, generation settings)
```

Generation number identifies an independent artifact within a combo. The schedule
generator refuses missing harness/model combinations or unbalanced generation counts.
The published schedule therefore shows both the expected matrix and every concrete run
key before execution.

## Rating

Terminal runs produce a 0–100 score from eight visible stages and five holdout cases.
The provisional rating uses pairwise score-derived Elo with a one-point draw threshold.
It is explicitly not a direct agent-vs-agent execution: the raw score, all pairwise
comparisons, rating parameters, challenge hash, and run hashes are published so anyone
can recompute the standings.

Infrastructure-invalid runs are excluded from ratings and remain visible as invalid
evidence. Agent failures remain valid low scores. This distinction prevents a broken
runner, missing credentials, or a model implementation failure from being conflated.

## Execution protocol

`npm run terminal:matrix` seals `challenge.json` and the exhaustive `schedule.json`.
`npm run terminal:run -- --adapter PATH` executes that schedule with bounded
concurrency; the default concurrency is `1`. `--concurrency N` runs up to `N`
independent jobs at once. Turns within each job always remain serialized in the same
session and workspace. An adapter
exports `runTerminalJob({ challenge, job, challengeRoot, runDirectory })` and returns
one `agentbattler.terminal-run.v1` result with the exact scheduled identity. The runner
writes each result atomically to `results/terminal-mini-ledger-v2/runs/<runKey>.json`.

The runner is restart-safe: completed results are skipped, infrastructure-invalid
results are visible and skipped by default, and `--retry-invalid` explicitly retries
only those infrastructure failures. A harness adapter is never guessed or silently
substituted. A missing adapter is an infrastructure problem, not an agent score.

Parallel execution is safe because every job has its own workspace, harness home,
session, result file, and scheduled identity. Concurrency is recorded in the adapter
job metadata and should be reported with benchmark runs because provider throttling and
machine contention can affect wall time even though they do not change the verifier.

The corrected v2 manifest uses a 20-minute per-turn maximum. New schedules may opt into
an unbounded turn policy with `AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS=0` while sealing
the resulting policy into the challenge hash. Unbounded means the adapter does not kill
the process; it still records per-turn and whole-run wall time. The active v2 schedule
must not be regenerated during an existing run. The v1 evidence is retained only as
withdrawn diagnostic history because its verifier contradicted its prompt; it is not
eligible for ratings.

## Mini Ledger v4.1 isolation and v4.2 timing amendment

The first V4 result set is also withdrawn from ratings. Its native adapters isolated the
harness home and candidate workspace but did not isolate the process from the parent Git
checkout, allowing access to hidden verifier source. The evidence remains available so the
failure and its effect can be audited.

V4.1 packages the fifteen-turn task for Harbor 0.20.0. Claude Code, Codex CLI, and Pi run
inside a fresh Docker environment with `/app` as the only persistent candidate artifact and
native session resume between turns. Every stage is evaluated in a separate verifier image;
the agent never receives its `/tests`, and verifier-spawned candidate processes are demoted
to UID/GID 1000 while `/tests` is root-only. DotAgents continues through its locked-down
Docker adapter, which mounts only its candidate workspace and isolated configuration.
The agent environment has public egress for model API access. After Harbor transfers `/app`,
the verifier container drops outbound traffic before verifier or candidate execution; this
split policy is recorded in the sealed challenge instead of being described as globally offline.

V4.2 uses an unbounded per-turn wall-time policy: an agent runs until its harness emits a
terminal result or exits. This amendment followed observation that only Claude Code reached
the former 20-minute cap. Earlier completed runs that did not reach the cap remain published
as comparable reference evidence, while the challenge hash records the amended policy and
new official runs use that hash. Wall-clock duration continues to be measured and reported.

Claude Code is launched with a model-calibrated context policy. For the current Terra, Sol,
and Luna gateway routes, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` are both 200,000, while
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` triggers proactive compaction around 160,000 tokens.
Unknown models fail closed: whenever the model roster or gateway mapping changes, run an
intentionally long session and validate its native transcript with
`npm run terminal:calibrate:claude -- --trace SESSION.jsonl --model MODEL`. Calibration
must observe at least one native `compact_boundary` before the model can be added to the
policy table. Results record the policy, compact count, and available token counts before
and after each boundary. A sealed compatibility proxy also normalizes only explicit gateway
context-overflow failures to Anthropic's HTTP 400 `invalid_request_error` prompt-too-long
envelope. HTTP 413 `request_too_large` remains reserved for the separate raw request-body
size limit, and generic timeouts are never reclassified as context overflow.

Because the verifier and candidate process policy are part of the canonical challenge, the
V4.1 challenge hash differs from the withdrawn run. The normal schedule validator therefore
rejects old results rather than silently mixing them into the replacement leaderboard.
The challenge descriptor also binds Harbor 0.20.0 and a deterministic hash of the complete
generated Harbor task tree, including per-step verifier images, firewall policy, and scripts.

## V5 transition

V5 reuses the sealed V4 ledger requirements, fifteen-stage verifier, Harbor isolation,
scoring, and exhaustive combo roster while introducing a fixed 30-minute per-turn policy. It
always writes to `results/terminal-mini-ledger-v5/`, so V4 evidence cannot be overwritten
or silently mixed into the new leaderboard. Build and run it with:

```sh
npm run terminal:matrix:v5
npm run terminal:run:v5
npm run terminal:verify:v5 -- --allow-incomplete
```

The schedule seals `1,800,000` milliseconds into every job, and each adapter enforces that
limit independently for every agent turn. Every one of the fifteen V5 prompts also tells
the agent that the benchmark will stop the turn after 30 minutes and instructs it to finish
the requested stage, prioritize validation, and leave the workspace runnable before the
deadline. V4 prompts remain unchanged for historical reproducibility.

V5 rejects zero, unbounded, or alternate timeout values. A different limit is a benchmark
protocol change: introduce a new benchmark version, update the agent-facing notice, rebuild
the generated Harbor task, and calibrate the adapters for any changed model roster instead
of modifying V5 in place.

### Clean M4 execution

Run V5 from a dedicated clean checkout pinned to one published Git commit. Do not reuse the
historical `AgentBattlerv2` or `AgentBattlerv2-v4-unbounded` directories, and do not copy an
uncommitted working tree with rsync. Before launching, confirm that `git status --porcelain`
is empty and record `git rev-parse HEAD` alongside the challenge and schedule IDs.

Initialize and start the pinned CLIProxyAPI runtime, then source its generated environment
in the same login shell that launches the benchmark. CLIProxyAPI is used by Claude Code and
DotAgents; Codex and Pi use the local Codex ChatGPT subscription credentials directly.

```sh
node scripts/manage-cliproxy.mjs init ~/AgentBattlerRuntime/cliproxy-v5
node scripts/manage-cliproxy.mjs login ~/AgentBattlerRuntime/cliproxy-v5 # only when auth is absent/expired
node scripts/manage-cliproxy.mjs start ~/AgentBattlerRuntime/cliproxy-v5
source /private/tmp/agentbattler-cliproxy-v5/benchmark.env
export AGENTBATTLER_CLIPROXY_HARNESSES=claude-code
npm run terminal:matrix:v5
npm run terminal:verify:v5 -- --allow-incomplete
nohup caffeinate -dimsu npm run terminal:run:v5 > terminal-v5.log 2>&1 &
echo $! > terminal-v5.pid
```

The runner is resumable and breadth-first. It gives every harness/model combo generation 1
before starting generation 2, then repeats that generation-major order through generation 5.
Completed sealed run keys are skipped. Infrastructure-invalid attempts are deferred until the
first-coverage pass is complete, then retried by bounded retry passes in the same order. This
keeps early results representative of the whole matrix instead of oversampling whichever combo
happens to appear first. Do not regenerate the schedule after execution starts. Once all 60 runs
pass strict verification, run `npm run terminal:traces:v5`. Published
traces retain normalized run and per-turn durations, input/cached-input/output/reasoning token
counts, tool calls, compaction boundaries, Harbor resource summaries, native semantic events,
and verifier diagnostics. Raw workspaces remain local and ignored because they can contain
ephemeral credentials and redundant session snapshots.

## Mini Ledger v3

`terminal-mini-ledger-v3` is the harder follow-on challenge. It keeps the same exhaustive
four-harness × three-model × five-generation matrix, but expands the task to twelve
interacting turns: idempotent batches, migration, crash recovery, multi-process locking,
checksummed compaction, replay, round trips, and a 2,000-event scale audit. It has its own
sealed result root and does not mix with v2 ratings.

Build and inspect its schedule with:

```sh
npm run terminal:matrix:v3
npm run terminal:verify:v3 -- --allow-incomplete
```

Run it through all adapters with `npm run terminal:run:v3`. The v3 verifier uses fixed
correctness bands and seeded hidden cases; it does not rank machines by raw wall-clock speed.
