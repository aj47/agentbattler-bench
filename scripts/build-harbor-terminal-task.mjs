#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MINI_LEDGER_V4_TURN_PROMPTS } from '../src/terminal-prompts-v4.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'benchmark', 'harbor', 'mini-ledger-v4');
const stages = [
  ['foundation', 3], ['batch', 3], ['pagination', 3], ['migration', 3], ['atomicity', 3],
  ['recovery', 3], ['concurrency', 3], ['compaction', 3], ['roundtrip', 3], ['replay', 3],
  ['audit', 5], ['scale', 5], ['stress-concurrency', 10], ['validation', 10], ['scale-stress', 10],
];

if (MINI_LEDGER_V4_TURN_PROMPTS.length !== stages.length) throw new Error('V4 prompt/stage count mismatch');

const toml = `schema_version = "1.4"
multi_step_reward_strategy = "final"
artifacts = [{ source = "/app", destination = "candidate" }]

[task]
name = "agentbattler/mini-ledger-v4"
version = "4.1.0"
description = "Fifteen-turn long-horizon deterministic ledger challenge"

[metadata]
benchmark = "AgentBattler"
challenge = "mini-ledger-v4"
harbor_version = "0.20.0"
visible_points = 70
holdout_points = 30

[agent]
timeout_sec = 1800.0
network_mode = "public"

[verifier]
timeout_sec = 600.0
environment_mode = "separate"

[verifier.environment]
# Harbor 0.20's Docker provider rejects no-network for separate verifier
# environments. Filesystem isolation is enforced by the separate container;
# the verifier has no credentials and makes no network requests.
network_mode = "public"
workdir = "/"
cpus = 4
memory_mb = 4096
storage_mb = 4096

[environment]
network_mode = "public"
workdir = "/app"
cpus = 4
memory_mb = 4096
storage_mb = 8192

${stages.map(([name, points], index) => `[[steps]]
name = "${String(index + 1).padStart(2, '0')}-${name}"

[steps.agent]
timeout_sec = 1800.0

[steps.verifier]
timeout_sec = 600.0

[steps.verifier.env]
AGENTBATTLER_STAGE_ID = "${name}"
AGENTBATTLER_STAGE_POINTS = "${points}"
AGENTBATTLER_FINAL_STEP = "${index === stages.length - 1 ? '1' : '0'}"
`).join('\n')}`;

const runner = `#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicStage } from './mini-ledger-v4/public-verifier.mjs';
import { verifyHoldout } from './mini-ledger-v4/holdout-verifier.mjs';

const workspace = '/app';
const logs = '/logs/verifier';
const stageId = process.env.AGENTBATTLER_STAGE_ID;
const stagePoints = Number(process.env.AGENTBATTLER_STAGE_POINTS);
const finalStep = process.env.AGENTBATTLER_FINAL_STEP === '1';
await mkdir(logs, { recursive: true });
await chmod('/tests', 0o700);
await chmod(workspace, 0o777);
process.env.AGENTBATTLER_CANDIDATE_UID = '1000';
process.env.AGENTBATTLER_CANDIDATE_GID = '1000';

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else total += (await lstat(file)).size;
  }
  return total;
}

let stage = { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: 0, diagnostic: 'verifier did not run' };
let holdout = null;
let workspaceBytes = null;
try {
  workspaceBytes = await directoryBytes(workspace);
  stage = workspaceBytes > 50 * 1024 * 1024
    ? { ...stage, diagnostic: \`workspace exceeds 50 MiB limit: \${workspaceBytes} bytes\` }
    : await verifyPublicStage({ workspace, ledgerPath: path.join(workspace, 'ledger.mjs'), stageId });
} catch (error) {
  stage = { ...stage, diagnostic: String(error?.stack ?? error).slice(0, 2000) };
}
if (finalStep) {
  try { holdout = await verifyHoldout({ workspace }); }
  catch (error) { holdout = { passed: 0, total: 11, cases: [{ name: 'holdout-verifier-error', passed: false, diagnostic: String(error?.message ?? error).slice(0, 500) }] }; }
}
const reward = {
  reward: stage.passed ? 1 : 0,
  visible_points: stage.passed ? stagePoints : 0,
  regressions: Number(stage.regressions ?? (stage.passed ? 0 : 1)),
  stage_duration_ms: Number(stage.durationMs ?? 0),
  holdout_passed: Number(holdout?.passed ?? 0),
  holdout_total: Number(holdout?.total ?? 0),
};
let isolationProbe = null;
try { isolationProbe = JSON.parse(await readFile(path.join(workspace, 'isolation-probe.json'), 'utf8')); } catch { /* Normal candidates do not emit a probe. */ }
await writeFile(path.join(logs, 'reward.json'), JSON.stringify(reward));
await writeFile(path.join(logs, 'stage-result.json'), JSON.stringify({ stage, holdout, isolationProbe, workspaceBytes }, null, 2));
`;

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'environment'), { recursive: true });
await writeFile(path.join(output, 'environment', 'Dockerfile'), `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git procps ripgrep \\
    && rm -rf /var/lib/apt/lists/* \\
    && mkdir -p /app \\
    && chmod 0777 /app
WORKDIR /app
`);
await mkdir(path.join(output, 'tests', 'mini-ledger-v3'), { recursive: true });
await mkdir(path.join(output, 'tests', 'mini-ledger-v4'), { recursive: true });
await writeFile(path.join(output, 'task.toml'), toml);
await writeFile(path.join(output, 'tests', 'run-stage.mjs'), runner, { mode: 0o755 });
await cp(path.join(root, 'benchmark', 'challenges', 'candidate-process.mjs'), path.join(output, 'tests', 'candidate-process.mjs'));
for (const version of ['v3', 'v4']) {
  for (const verifier of ['public-verifier.mjs', 'holdout-verifier.mjs']) {
    await cp(
      path.join(root, 'benchmark', 'challenges', `mini-ledger-${version}`, verifier),
      path.join(output, 'tests', `mini-ledger-${version}`, verifier),
    );
  }
}
for (const [[stage], prompt, index] of stages.map((stage, index) => [stage, MINI_LEDGER_V4_TURN_PROMPTS[index], index])) {
  const step = `${String(index + 1).padStart(2, '0')}-${stage}`;
  const directory = path.join(output, 'steps', step);
  const tests = path.join(directory, 'tests');
  await mkdir(path.join(tests, 'mini-ledger-v3'), { recursive: true });
  await mkdir(path.join(tests, 'mini-ledger-v4'), { recursive: true });
  await writeFile(path.join(directory, 'instruction.md'), `${prompt}\n`);
  await writeFile(path.join(tests, 'Dockerfile'), `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables \\
    && rm -rf /var/lib/apt/lists/*
COPY . /tests
RUN chmod 0700 /tests && chmod 0755 /tests/test.sh
WORKDIR /
`);
  await writeFile(path.join(tests, 'docker-compose.yaml'), `services:
  main:
    cap_add:
      - NET_ADMIN
`);
  // Harbor re-materializes declared artifacts at their original source path,
  // so the candidate arrives at /app in the separate verifier container.
  await writeFile(path.join(tests, 'test.sh'), '#!/bin/sh\nset -eu\niptables -P OUTPUT DROP\nnode /tests/run-stage.mjs\n', { mode: 0o755 });
  await writeFile(path.join(tests, 'run-stage.mjs'), runner, { mode: 0o700 });
  await cp(path.join(root, 'benchmark', 'challenges', 'candidate-process.mjs'), path.join(tests, 'candidate-process.mjs'));
  for (const version of ['v3', 'v4']) {
    for (const verifier of ['public-verifier.mjs', 'holdout-verifier.mjs']) {
      await cp(
        path.join(root, 'benchmark', 'challenges', `mini-ledger-${version}`, verifier),
        path.join(tests, `mini-ledger-${version}`, verifier),
      );
    }
  }
}
await writeFile(path.join(output, 'README.md'), `# Mini Ledger V4 for Harbor

Generated from the canonical AgentBattler prompts and verifiers. Run with Harbor 0.20.0 or newer and pass \`--resume-trajectory\` so all fifteen instructions use one native agent session.

The agent and verifier use separate containers. Only \`/app\` is transferred. Verifier-spawned candidate processes run as UID/GID 1000 while \`/tests\` remains root-only. Harbor 0.20's Docker provider does not support \`no-network\` for separate verifier environments, so the verifier starts in \`public\` mode, receives the candidate artifact, then drops all outbound traffic with iptables before any verifier or candidate code executes. The verifier receives no credentials.
`);
console.log(output);
