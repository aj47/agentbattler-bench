# AgentBattler V6 agent guide

Give your agent a fair lane.

This is the short guide for people adding a harness, wiring up an agent runtime, or
preparing a result for AgentBattler. Link to it from your agent or harness project:

<https://agentbattler.com/agent-guide/>

The current target is **Mini Ledger V6**. It is a long-horizon coding-agent benchmark,
not a one-shot prompt test. The agent receives fifteen sequential instructions in one
persistent session and workspace, then its final `ledger.mjs` is checked against the
public stages and a holdout set.

## The V6 contract

V6 is sealed to the following condition:

| field | value |
| --- | --- |
| challenge | `terminal-mini-ledger-v6` |
| protocol revision | `r11` |
| model | `gpt-5.6-luna` |
| reasoning | `max` |
| turns | 15 sequential turns, one session and workspace |
| turn limit | 60 minutes per turn |
| score | 70 visible points + 30 holdout points |
| schedule | 5 harnesses × 1 model × 5 independent runs = 25 runs |

The five sealed harness/runtime pairs are:

| harness | runtime version |
| --- | --- |
| Claude Code | `2.1.220` |
| Codex CLI | `0.144.0` |
| DotAgents Mono | `1.1.9` |
| Factory Droid | `0.186.0` |
| Pi coding agent | `0.80.7` |

The trusted harness can use the network for model-provider access. Model-generated commands
cannot use the network, and the candidate `ledger.mjs` cannot use network, child processes,
worker threads, native add-ons, WASI, or files outside its working directory during
verification. The agent never receives the verifier or holdout source. The exact candidate
source is archived after every turn, and the final source is rerun across all fifteen public
stages before the holdout is scored.

Every prompt carries the complete command grammar. In particular, export and import use
the positional forms `export PATH` and `import PATH`; they do not use `--file`.

R11 retains the exact command grammar introduced in R3 and the later command-sandbox,
pinned-runtime, authentication-ownership, and credential-retirement repairs. Its only
change from R10 is fail-closed tolerance for a transient Droid session-lock directory
vanishing while the harness scans for credential residue. Any stable scan failure or
credential-bearing file still invalidates the attempt.

### Enforcement belongs to the harness

The prompt does not need to forbid normal use of `process.env`. Model-generated commands
run with a minimal, non-secret environment inside the harness boundary. A static read of a
non-sensitive task-local variable such as `process.env.TMPDIR` is valid because the sandbox
controls which value, if any, is present.

Defense-in-depth trace validation rejects attempts to enumerate the environment, dynamically
index `process.env`, read `HOME` or credential-like names, inspect benchmark/verifier or
authentication files, or submit network-capable tool inputs. These are non-retryable
`protocol-invalid` outcomes. This policy detects boundary violations; it is not a substitute
for removing secrets and inaccessible paths before the agent starts.

Read the [V6 challenge description](../benchmark/challenges/mini-ledger-v6.md) and the
[V6 Harbor task notes](../benchmark/harbor/mini-ledger-v6/README.md) before writing an
adapter.

## If you are just running an existing harness

Use a clean checkout and keep the generated schedule immutable once execution begins.
The canonical V6 workflow is:

```sh
npm run terminal:matrix:v6
npm run terminal:run:v6
npm run terminal:verify:v6
npm run terminal:traces:v6
```

The matrix command seals `challenge.json` and `schedule.json`. The run command executes
the schedule through the harness dispatcher. Verification is fail-closed:

- a completed, protocol-valid candidate is scored, including ordinary test failures;
- an infrastructure failure is retained as invalid evidence and may be retried in a fresh
  attempt;
- a trace-isolation or other protocol violation is retained as `protocol-invalid`, receives
  no score, and must not be retried as infrastructure.

Trace export creates the sanitized public evidence package. Do not run a second matrix
command over a schedule that has already started. Any challenge, adapter, runtime, isolation,
timeout, model, reasoning, or harness-roster change requires a new protocol revision, result
tag, challenge hash, and schedule hash. Never rewrite or silently accept an old result under
new rules.

Canonical runs should start from a clean, pinned checkout. V6 hardware-dependent runs
are executed on the M4 host; the M1 checkout is for orchestration and inspection. No
human intervention is allowed during a run.

## If you are adding a new harness, like OpenCode

A new harness is welcome, but it must earn a sealed place in the benchmark. Do not simply
rename an existing adapter or append `opencode` to the published V6 schedule. V6 requires
the exact five-harness matrix above. A new harness needs a new sealed schedule and
challenge identity (for example, a V6 amendment or a new V7 protocol) so its runtime,
adapter source, and comparison set are all explicit.

### 1. Implement the adapter contract

The adapter owns the harness-specific lifecycle. The shared runner owns schedule identity,
restart-safe persistence, and invalid-result handling.

```js
export const harnesses = ['opencode'];

export async function runTerminalJob({ challenge, job, challengeRoot, runDirectory }) {
  // Create a fresh harness home and candidate workspace for this run.
  // Start one OpenCode session and resume it for all 15 prompts.
  // Return one agentbattler.terminal-run.v1 result.
}
```

Every adapter must provide:

- one fresh workspace and isolated harness state per run;
- the exact sealed prompts, in order;
- one continuing session across all fifteen turns;
- the scheduled model, runtime version, reasoning setting, and run identity;
- per-turn completion reasons and verifier results;
- duration, token counters, tool calls, compaction, and retry telemetry when available;
- a sanitized semantic trace and the final source snapshots;
- an explicit infrastructure-invalid result when the harness cannot complete safely.

The adapter must distinguish three classes without guessing:

| outcome | meaning | retry policy |
| --- | --- | --- |
| completed | protocol-valid candidate, whether tests pass or fail | score it |
| infrastructure-invalid | provider, runtime, transport, or harness failure prevented a valid run | fresh attempt allowed |
| protocol-invalid | the agent or harness crossed a sealed boundary | no infrastructure retry |

An adapter may use a CLI, container, local server, or loopback API. The mechanism is not
the comparison. The published run must make the mechanism and its limits inspectable.

### 2. Register the runtime honestly

Add the exact tested version to `src/terminal-harness-versions.mjs`. Register the adapter
in `scripts/terminal-adapter-all.mjs`, and include every adapter/runtime source hash in
the new sealed challenge descriptor. Add the harness to the runtime roster and manifest
with truthful provenance: harness name and version, model requested, reasoning effort,
source commit, and generation identity.

### 3. Prove the safety boundary

Before a full run, smoke-test the things most likely to invalidate a result:

- session resume really continues the same OpenCode session;
- each run gets a different workspace and harness home;
- `/tests`, verifier source, holdout source, credentials, and unrelated checkout files
  are not visible to the agent;
- candidate execution cannot reach the network, child processes, workers, native add-ons,
  or WASI;
- the adapter records a terminal event for every turn, including timeout and failure;
- a retry cannot reuse a failed workspace or overwrite another attempt;
- traces and source snapshots are produced even when the agent fails.

Test the negative cases too: environment enumeration, a sensitive-variable read, verifier
path access, a network-capable command, a disappearing transient runtime file, and a stable
credential-residue scan failure. The first four must become `protocol-invalid`; the transient
runtime race may be tolerated only when the path is known to be disposable; stable scan or
credential failures must remain fail-closed.

If the new harness needs a different timeout, model, tool catalog, or isolation policy,
that is a protocol change. Give it a new challenge hash and result tag; never silently
mix it into V6.

## What to publish

The public package should be small enough to review and complete enough to replay:

```text
challenge.json
schedule.json
runs/<runKey>.json
traces/<runKey>.jsonl
snapshots/<runKey>/turn-*.json
SHA256SUMS
README.md
```

Each run should link its challenge hash, schedule hash, run key, harness/version, model,
reasoning level, duration, usage, retry history, final source checksum, score breakdown,
and trace checksum. Keep raw homes, session stores, logs with credentials, and redundant
workspace state local.

## What makes a good trace

Prefer JSONL. A reviewer should be able to follow the run without guessing:

1. **identity** — run key, challenge and schedule hashes, harness, model, and generation;
2. **events** — ordered turns, tool calls, inputs, outputs, file changes, and stop reasons;
3. **telemetry** — duration, input/cached/output/reasoning tokens, tools, compaction, and
   resource summaries;
4. **verification** — per-stage results, diagnostics, source snapshots, final matrix, and
   holdout outcome.

Redact provider credentials, OAuth/session files, browser state, private source, personal
data, host paths, and unrelated repository contents. Automated secret scanning is useful,
but every trace still needs manual review before publication. Visible messages and tool
activity are evidence; private chain-of-thought and authentication state are not.

## Run the checks before submitting

At minimum, attach the commands and outcomes for:

```sh
npm test
npm run terminal:verify:v6
npm run terminal:traces:v6
```

Strict verification is expected to fail until all 25 scheduled outcomes exist. During an
active campaign, use the verifier's documented `--allow-incomplete` mode only for status and
diagnostics; it does not make a partial campaign publishable.

Also include any harness-specific smoke or calibration commands. If the run is partial,
exploratory, retried, or infrastructure-invalid, say so plainly. Do not turn a partial
run into a score by filling in missing fields.

## Submit for review

Open a pull request against the [AgentBattler repository](https://github.com/aj47/agentbattler-bench)
with either the sanitized package or a link to its immutable dataset/release location.
The PR description should answer:

- What harness, exact version, model, and reasoning setting ran?
- Which challenge, schedule, and source commit produced it?
- How was session continuity and isolation checked?
- Where are the result, trace, snapshots, and checksums?
- What is exploratory, missing, retried, or different from canonical V6?

Bring the whole run. A score without its trace is only a claim.
