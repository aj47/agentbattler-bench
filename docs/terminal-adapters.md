# Terminal adapter contract

The terminal runner is harness-neutral, but a harness is not considered supported
until its adapter has been audited against this contract. The adapter owns the
harness-specific process or container lifecycle; the runner owns schedule identity,
restart-safe persistence, and invalid-result handling.

## Required behavior

Each adapter exports:

```js
export const harnesses = ['harness-id'];
export async function runTerminalJob({ challenge, job, challengeRoot, runDirectory }) {}
```

For each job it must provide:

- one fresh workspace and isolated harness state;
- the exact prompts from the sealed challenge (fifteen for V4);
- one continuing session across every prompt;
- the scheduled model, harness version, reasoning effort, and generation identity;
- per-turn verifier results and the final holdout result;
- provider-reported token telemetry and wall-clock timing;
- sanitized public artifacts without credentials, host paths, or private traces.

The shared runner rejects an adapter that does not advertise the requested harness.
It never substitutes another harness. A harness may use a CLI, a container, or a
loopback API internally, but the resulting run record must have the same schema and
must prove session continuity.

## Current implementation status

| Harness | Adapter | Status |
| --- | --- | --- |
| `amp-code` | `scripts/terminal-adapter-harbor.mjs` for V4/V5 | Harbor 0.20 Docker environment with Amp native thread resume |
| `codex-cli` | `scripts/terminal-adapter-harbor.mjs` for V4 | Harbor 0.20 Docker environment with native resume |
| `pi-coding-agent` | `scripts/terminal-adapter-harbor.mjs` for V4 | Harbor 0.20 Docker environment with native resume |
| `claude-code` | `scripts/terminal-adapter-harbor.mjs` for V4 | Harbor 0.20 Docker environment with native resume |
| `dotagents-mono` | `scripts/terminal-adapter-dotagents.mjs` | Existing locked-down Docker adapter |

`scripts/terminal-adapter-all.mjs` dispatches by challenge and harness. V4/V5 sends Amp
Code, Claude Code, Codex CLI, and Pi through Harbor while retaining DotAgents' isolated Docker path.
V3 and earlier remain on the legacy adapters for reproducibility.

## Amp Code sealed adapter

The registered harness ID is `amp-code`. It pins `@ampcode/cli` to
`0.0.1785846794-g0de1fc` and records both that package version and the CLI's `0de1fc`
source revision. The first step is launched non-interactively as
`amp --execute --stream-json`; resumed steps use
`amp threads continue THREAD_ID --execute --stream-json`. The adapter never starts the
Amp TUI or runner mode.

Every Harbor trial starts a new agent container, empty `/app` workspace, and fresh disposable
Amp home. The adapter passes only `AMP_API_KEY` through Harbor's secret-aware
agent environment. It supplies a sealed settings file, blocks all MCP servers, and disables
thread/history, schedule, skill, plugin, web, subagent, and media tools. It also rejects
injected Harbor skills/MCP configuration and removes candidate-created extension settings
before every resumed turn. No host home, global Amp configuration, repository checkout,
holdout verifier, previous thread, plugin, skill, or MCP path is mounted into the agent
container. The separate verifier receives only `/app`, exactly as it does for the other
native Harbor agents.

Each step retains `amp-runtime/amp.jsonl`, `amp-runtime/amp.stderr`,
`amp-runtime/amp-exit-code.txt`, and a compact parsed summary in the private Harbor trial
tree. These files, the parser, settings, PID lease, and pinned executable are root-owned;
only the Amp process and its tools are demoted to UID/GID 1000. The importer validates every
JSONL line, the terminal success event, tool/MCP allowlist, and one native Amp thread ID across all steps;
it records duration, exit code, mode/model metadata, tool calls, and available token usage.
Missing authentication, a version mismatch, malformed output, an unexpected extension
surface, or any other adapter failure throws to the shared runner and is persisted as
`infrastructure-invalid`, never scored as an agent loss. A Harbor `AgentTimeoutError`
remains a timed-out agent turn and retains any valid partial Amp events.

Amp high mode is intentionally represented as the model ID `amp-high`: Amp owns the model
routing for a mode and does not provide a CLI flag for selecting the historical Terra/Sol/Luna
matrix IDs. The one-generation manifest is
`agents/amp-code-terminal/manifest.json`; it adds no source agents or published results to the
existing four-harness comparison.

### Exact Linux commands

Prerequisites are Node 20+, `uvx`, Docker with Compose support, and an Amp access token.

```sh
export AMP_API_KEY='replace-with-an-amp-access-token'
docker version
npm run terminal:matrix:v5:amp-code
npm run terminal:run:v5:amp-code:smoke
npm run terminal:verify:v5:amp-code
```

### Exact Windows commands

Amp supports Windows through WSL. Run these PowerShell commands with Docker Desktop's WSL 2
engine enabled; direct environment assignments are used because npm's POSIX convenience
scripts are not portable to PowerShell.

```powershell
$env:AMP_API_KEY = 'replace-with-an-amp-access-token'
$env:AGENTBATTLER_TERMINAL_CHALLENGE_VERSION = 'v5'
$env:AGENTBATTLER_TERMINAL_PROTOCOL_REVISION = 'r4'
$env:AGENTBATTLER_TERMINAL_RESULT_TAG = 'v5-r4-amp-code'
$env:AGENTBATTLER_TERMINAL_MANIFEST = 'agents/amp-code-terminal/manifest.json'
docker version
node scripts/build-harbor-terminal-task.mjs
node scripts/build-terminal-schedule.mjs
node scripts/run-terminal-matrix.mjs --adapter scripts/terminal-adapter-all.mjs --harness amp-code --generation 1 --concurrency 1
node scripts/verify-terminal-results.mjs
```

### Exact direct Docker/Harbor diagnostic

This command exercises the pinned custom agent directly in Harbor's Docker substrate. It is
an adapter diagnostic, not a replacement for the sealed schedule commands above.

```sh
export AMP_API_KEY='replace-with-an-amp-access-token'
export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"
uvx --from harbor==0.20.0 harbor trial start \
  --path benchmark/harbor/mini-ledger-v5-r4 \
  --agent benchmark.harbor.amp_agent:AgentBattlerAmp \
  --agent-kwarg version=0.0.1785846794-g0de1fc \
  --agent-env "AMP_API_KEY=$AMP_API_KEY" \
  --model amp-high \
  --env docker \
  --resume-trajectory \
  --agent-timeout 1800 \
  --trial-name agentbattler-amp-code-diagnostic \
  --trials-dir trials
```

V4 Harbor runs write `harbor-resource-samples.jsonl` and
`harbor-resource-summary.json` beside the trial logs. These diagnostics sample container
memory, cgroup OOM counters, process count, and Docker state without changing scoring.
Claude Code is limited to four concurrent tool uses with
`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=4` so native background-agent fan-out remains inside
the declared 4 CPU / 4 GiB resource envelope. The applied limit is also recorded in the
canonical run adapter metadata.

The generated Harbor task uses fifteen ordered steps and `--resume-trajectory`. The agent
container receives the prompts and persistent `/app` workspace but not `/tests`. After each
turn, Harbor transfers only `/app` into a separate verifier container. Verifier source is
root-only, and candidate processes run as UID/GID 1000. An M4 smoke exercised all fifteen
steps: stages 2–15 used the resume path, the agent could not see `/tests`, and candidate
attempts to read the holdout verifier failed. Harbor's Docker provider does not start a
`no-network` separate verifier, so each verifier starts with public networking only long
enough to receive its artifact, then drops all outbound traffic with an iptables policy
before verifier or candidate code runs. No credentials are passed to the verifier.

The exhaustive schedule already includes all declared harness/model combinations.
Build the package with `npm run terminal:harbor:build`, then run the V4 schedule with
`npm run terminal:run:v4`.
Use `--harness` to smoke-test one adapter subset before running the complete matrix.

Codex defaults to the host's subscription `~/.codex/auth.json` through Harbor's explicit
`CODEX_AUTH_JSON_PATH` setting. Pi derives an ephemeral `openai-codex` credential from the same
subscription file inside its agent container, outside the transferred candidate artifact. Claude
Code defaults to the configured CLIProxy endpoint;
set both `AGENTBATTLER_CLIPROXY_BASE_URL` and `AGENTBATTLER_CLIPROXY_API_KEY`. Override the
comma-separated proxy roster with `AGENTBATTLER_CLIPROXY_HARNESSES` when needed. DotAgents
continues to consume the same proxy settings in its existing adapter.
