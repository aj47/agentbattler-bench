#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MINI_LEDGER_V4_TURN_PROMPTS } from '../src/terminal-prompts-v4.mjs';
import { MINI_LEDGER_V5_TURN_PROMPTS } from '../src/terminal-prompts-v5.mjs';
import { MINI_LEDGER_V6_TURN_LIMIT_MINUTES, MINI_LEDGER_V6_TURN_PROMPTS } from '../src/terminal-prompts-v6.mjs';
import { terminalHarnessVersion } from '../src/terminal-harness-versions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeVersion = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v4';
if (!['v4', 'v5', 'v6'].includes(challengeVersion)) throw new Error('Harbor task generation supports only V4, V5, and V6');
const protocolRevision = challengeVersion === 'v5'
  ? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2'
  : challengeVersion === 'v6' ? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r10' : null;
if (protocolRevision && !/^r\d+$/.test(protocolRevision)) throw new Error('AGENTBATTLER_TERMINAL_PROTOCOL_REVISION must look like r2');
const prompts = challengeVersion === 'v6' ? MINI_LEDGER_V6_TURN_PROMPTS : challengeVersion === 'v5' ? MINI_LEDGER_V5_TURN_PROMPTS : MINI_LEDGER_V4_TURN_PROMPTS;
const versionNumber = challengeVersion === 'v6'
  ? protocolRevision === 'r10' ? '6.9.0' : protocolRevision === 'r9' ? '6.8.0' : protocolRevision === 'r8' ? '6.7.0' : protocolRevision === 'r7' ? '6.6.0' : protocolRevision === 'r6' ? '6.5.0' : protocolRevision === 'r5' ? '6.4.0' : protocolRevision === 'r4' ? '6.3.0' : '6.2.0'
  : challengeVersion === 'v5'
  ? protocolRevision === 'r5' ? '5.4.0' : protocolRevision === 'r4' ? '5.3.0' : protocolRevision === 'r3' ? '5.2.0' : '5.1.0'
  : '4.2.0';
const taskTag = challengeVersion === 'v5' ? `${challengeVersion}-${protocolRevision}` : challengeVersion;
const output = path.join(root, 'benchmark', 'harbor', `mini-ledger-${taskTag}`);
const verifierVersion = challengeVersion === 'v6' ? 'v6' : 'v4';
const verifierDependencyVersions = challengeVersion === 'v6' ? ['v3', 'v4', 'v6'] : ['v3', 'v4'];
const agentTurnLimitMinutes = challengeVersion === 'v6' ? MINI_LEDGER_V6_TURN_LIMIT_MINUTES : challengeVersion === 'v5' ? 30 : null;
const agentTimePolicy = agentTurnLimitMinutes === null ? 'self-terminating' : `hard-${agentTurnLimitMinutes}-minutes-per-turn-with-agent-notice`;
const stages = [
  ['foundation', 3], ['batch', 3], ['pagination', 3], ['migration', 3], ['atomicity', 3],
  ['recovery', 3], ['concurrency', 3], ['compaction', 3], ['roundtrip', 3], ['replay', 3],
  ['audit', 5], ['scale', 5], ['stress-concurrency', 10], ['validation', 10], ['scale-stress', 10],
];

if (prompts.length !== stages.length) throw new Error(`${challengeVersion.toUpperCase()} prompt/stage count mismatch`);

const toml = `schema_version = "1.4"
multi_step_reward_strategy = "final"
artifacts = [{ source = "/app", destination = "candidate" }]

[task]
name = "agentbattler/mini-ledger-${challengeVersion}"
version = "${versionNumber}"
description = "Fifteen-turn long-horizon deterministic ledger challenge"

[metadata]
benchmark = "AgentBattler"
challenge = "mini-ledger-${challengeVersion}"
protocol_revision = "${protocolRevision ?? 'original'}"
harbor_version = "0.20.0"
visible_points = 70
holdout_points = 30
agent_time_policy = "${agentTimePolicy}"
verifier_workspace_policy = "source-only-per-stage-and-holdout-case"
primary_score_policy = "${challengeVersion === 'v6' ? 'final-public-matrix-plus-holdout' : 'trajectory-stage-results-plus-holdout'}"
candidate_snapshot_policy = "${challengeVersion === 'v6' ? 'every-turn-exact-ledger-source' : 'not-required'}"
candidate_network_policy = "${challengeVersion === 'v6' ? 'node-permission-model-deny-network-and-child-process' : 'legacy'}"
candidate_durability_policy = "${challengeVersion === 'v6' ? 'filehandle-sync-and-datasync' : 'legacy'}"
agent_command_sandbox_policy = "${challengeVersion === 'v6' ? 'workspace-filesystem-minimal-environment-no-network' : 'legacy'}"
agent_command_sandbox_host_compat = "${challengeVersion === 'v6' ? 'trusted-parent-namespace-caps-model-child-cap-drop' : 'legacy'}"

[agent]
network_mode = "public"

[verifier]
timeout_sec = ${challengeVersion === 'v6' ? '1200.0' : '600.0'}
environment_mode = "separate"

[verifier.environment]
# Harbor 0.20's Docker provider rejects no-network for separate verifier
# environments. The trusted verifier has no credentials and makes no network
# requests. V6 candidate child processes additionally use Node's permission
# model without allow-net or child-process permission.
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

[steps.verifier]
timeout_sec = ${challengeVersion === 'v6' && index === stages.length - 1 ? '1200.0' : '600.0'}

[steps.verifier.env]
AGENTBATTLER_STAGE_ID = "${name}"
AGENTBATTLER_STAGE_POINTS = "${points}"
AGENTBATTLER_FINAL_STEP = "${index === stages.length - 1 ? '1' : '0'}"
`).join('\n')}`;

const runner = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicStage } from './mini-ledger-${verifierVersion}/public-verifier.mjs';
import { verifyHoldout } from './mini-ledger-${verifierVersion}/holdout-verifier.mjs';

const workspace = '/app';
const logs = '/logs/verifier';
const stageId = process.env.AGENTBATTLER_STAGE_ID;
const stagePoints = Number(process.env.AGENTBATTLER_STAGE_POINTS);
const finalStep = process.env.AGENTBATTLER_FINAL_STEP === '1';
const candidateSnapshotsRequired = ${challengeVersion === 'v6'};
const finalPublicRequired = ${challengeVersion === 'v6'};
const stageDefinitions = ${JSON.stringify(stages.map(([id, points]) => ({ id, points })))};
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

async function captureCandidateSnapshot() {
  const source = path.join(workspace, 'ledger.mjs');
  try {
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return { schemaVersion: 'agentbattler.terminal-candidate-snapshot.v1', entryPoint: 'ledger.mjs', present: true, kind: sourceStat.isSymbolicLink() ? 'symbolic-link' : sourceStat.isDirectory() ? 'directory' : 'other', archived: false };
    const bytes = await readFile(source);
    const mode = sourceStat.mode & 0o777;
    await writeFile(path.join(logs, 'candidate-ledger.mjs'), bytes, { mode });
    return { schemaVersion: 'agentbattler.terminal-candidate-snapshot.v1', entryPoint: 'ledger.mjs', present: true, kind: 'regular-file', archived: true, bytes: sourceStat.size, sha256: createHash('sha256').update(bytes).digest('hex'), mode: mode.toString(8).padStart(4, '0'), executable: (mode & 0o111) !== 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 'agentbattler.terminal-candidate-snapshot.v1', entryPoint: 'ledger.mjs', present: false, kind: 'missing', archived: false };
    throw error;
  }
}

let stage = { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: 0, diagnostic: 'verifier did not run' };
let holdout = null;
let finalPublic = null;
let candidateSnapshot = null;
let workspaceBytes = null;
let infrastructureError = null;
try {
  workspaceBytes = await directoryBytes(workspace);
  if (candidateSnapshotsRequired) candidateSnapshot = await captureCandidateSnapshot();
  stage = candidateSnapshotsRequired && (!candidateSnapshot.present || candidateSnapshot.kind !== 'regular-file')
    ? { ...stage, diagnostic: candidateSnapshot.present ? 'candidate ledger.mjs is not a regular file' : 'candidate ledger.mjs is missing' }
    : workspaceBytes > 50 * 1024 * 1024
    ? { ...stage, diagnostic: \`workspace exceeds 50 MiB limit: \${workspaceBytes} bytes\` }
    : await verifyPublicStage({ workspace, ledgerPath: path.join(workspace, 'ledger.mjs'), stageId });
} catch (error) {
  infrastructureError = String(error?.stack ?? error).slice(0, 2000);
  stage = { ...stage, diagnostic: 'verifier infrastructure failed before the candidate could be judged' };
}
if (finalStep) {
  if (finalPublicRequired) {
    const finalStages = [];
    if (!candidateSnapshot?.present || candidateSnapshot.kind !== 'regular-file') {
      const diagnostic = candidateSnapshot?.present ? 'candidate ledger.mjs is not a regular file' : 'candidate ledger.mjs is missing';
      for (const definition of stageDefinitions) finalStages.push({ id: definition.id, passed: false, regressions: 1, exitCode: 1, durationMs: 0, diagnostic });
    } else {
      try {
        for (const definition of stageDefinitions) finalStages.push(await verifyPublicStage({ workspace, ledgerPath: path.join(workspace, 'ledger.mjs'), stageId: definition.id }));
      } catch (error) {
        infrastructureError ??= String(error?.stack ?? error).slice(0, 2000);
      }
    }
    if (finalStages.length === stageDefinitions.length) finalPublic = {
      schemaVersion: 'agentbattler.terminal-final-public.v1',
      evaluator: 'all-public-stages-from-final-source-only-candidate',
      stages: finalStages,
      passed: finalStages.filter((entry) => entry.passed === true).length,
      total: stageDefinitions.length,
      visiblePoints: stageDefinitions.reduce((sum, definition) => sum + (finalStages.find((entry) => (entry.id ?? entry.stageId) === definition.id)?.passed === true ? definition.points : 0), 0),
      maxVisiblePoints: stageDefinitions.reduce((sum, definition) => sum + definition.points, 0),
    };
  }
  try { holdout = await verifyHoldout({ workspace }); }
  catch (error) { infrastructureError ??= String(error?.stack ?? error).slice(0, 2000); holdout = { passed: 0, total: 11, cases: [{ name: 'holdout-verifier-infrastructure-error', passed: false, diagnostic: 'holdout verifier infrastructure failed' }] }; }
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
await writeFile(path.join(logs, 'stage-result.json'), JSON.stringify({ stage, holdout, finalPublic, candidateSnapshot, isolationProbe, workspaceBytes, infrastructureError, verifierWorkspace: { policy: 'source-only-per-stage-and-holdout-case', sourceEntryPoint: 'ledger.mjs', candidateUid: 1000, candidateGid: 1000, candidateRuntime: { nodePermissionModel: ${challengeVersion === 'v6'}, filesystem: ${challengeVersion === 'v6' ? "'working-directory-only'" : "'legacy'"}, network: ${challengeVersion === 'v6' ? "'denied'" : "'legacy'"}, childProcess: ${challengeVersion === 'v6' ? "'denied'" : "'legacy'"}, durabilityApis: ${challengeVersion === 'v6' ? "{ supported: ['FileHandle.sync', 'FileHandle.datasync'], unavailable: ['fs.fsync', 'fs.fdatasync', 'fs.fsyncSync', 'fs.fdatasyncSync'] }" : "'legacy'"} } } }, null, 2));
if (infrastructureError) process.exitCode = 2;
`;

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'environment'), { recursive: true });
await writeFile(path.join(output, 'environment', 'Dockerfile'), `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git procps ripgrep socat \\
    && rm -rf /var/lib/apt/lists/* \\
    && mkdir -p /app \\
    && chmod 0777 /app
${challengeVersion === 'v6' ? `RUN npm install -g @openai/codex@${terminalHarnessVersion('codex-cli')} @anthropic-ai/claude-code@${terminalHarnessVersion('claude-code')} @earendil-works/pi-coding-agent@${terminalHarnessVersion('pi-coding-agent')}
` : ''}WORKDIR /app
`);
if (challengeVersion === 'v6') await writeFile(path.join(output, 'environment', 'docker-compose.yaml'), `services:
  main:
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SYS_ADMIN
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
      - seccomp=unconfined
`);
for (const version of verifierDependencyVersions) await mkdir(path.join(output, 'tests', `mini-ledger-${version}`), { recursive: true });
await writeFile(path.join(output, 'task.toml'), toml);
await writeFile(path.join(output, 'tests', 'run-stage.mjs'), runner, { mode: 0o755 });
await cp(path.join(root, 'benchmark', 'challenges', 'candidate-process.mjs'), path.join(output, 'tests', 'candidate-process.mjs'));
for (const version of verifierDependencyVersions) {
  for (const verifier of ['public-verifier.mjs', 'holdout-verifier.mjs']) {
    await cp(
      path.join(root, 'benchmark', 'challenges', `mini-ledger-${version}`, verifier),
      path.join(output, 'tests', `mini-ledger-${version}`, verifier),
    );
  }
}
for (const [[stage], prompt, index] of stages.map((stage, index) => [stage, prompts[index], index])) {
  const step = `${String(index + 1).padStart(2, '0')}-${stage}`;
  const directory = path.join(output, 'steps', step);
  const tests = path.join(directory, 'tests');
  for (const version of verifierDependencyVersions) await mkdir(path.join(tests, `mini-ledger-${version}`), { recursive: true });
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
  await writeFile(path.join(tests, 'test.sh'), '#!/bin/sh\nset -eu\niptables -P OUTPUT DROP\nchown -hR 1000:1000 /app\nchmod -R u+rwX /app\nnode /tests/run-stage.mjs\n', { mode: 0o755 });
  await writeFile(path.join(tests, 'run-stage.mjs'), runner, { mode: 0o700 });
  await cp(path.join(root, 'benchmark', 'challenges', 'candidate-process.mjs'), path.join(tests, 'candidate-process.mjs'));
  for (const version of verifierDependencyVersions) {
    for (const verifier of ['public-verifier.mjs', 'holdout-verifier.mjs']) {
      await cp(
        path.join(root, 'benchmark', 'challenges', `mini-ledger-${version}`, verifier),
        path.join(tests, `mini-ledger-${version}`, verifier),
      );
    }
  }
}
await writeFile(path.join(output, 'README.md'), `# Mini Ledger ${challengeVersion.toUpperCase()} for Harbor

Generated from the canonical AgentBattler prompts and verifiers. Run with Harbor 0.20.0 or newer and pass \`--resume-trajectory\` so all fifteen instructions use one native agent session.

The agent and verifier use separate containers. Only \`/app\` is transferred. Each check copies only the regular \`ledger.mjs\` source entry point into a fresh candidate-owned workspace; runtime state and sidecars never cross check boundaries. Verifier-spawned candidate processes run as UID/GID 1000 while \`/tests\` remains root-only. Harbor 0.20's Docker provider does not support \`no-network\` for separate verifier environments, so the verifier starts in \`public\` mode, receives the candidate artifact, then drops all outbound traffic with iptables before any verifier or candidate code executes. The verifier receives no credentials.${agentTurnLimitMinutes === null ? '\n' : `\n\nEvery agent step has a hard ${agentTurnLimitMinutes}-minute wall-clock limit supplied by the sealed schedule, and every instruction explicitly tells the agent to finish within that limit.\n`}${challengeVersion === 'v6' ? `\nV6 archives the exact ledger.mjs source after every turn and reruns all fifteen public stages against the final source before the holdout. Node permission mode supports real durability through FileHandle.sync() and FileHandle.datasync(); descriptor-only fs.fsync/fs.fdatasync variants are unavailable and are disclosed in every agent instruction. ${protocolRevision === 'r10' ? 'R10 preinstalls the pinned Pi runtime in the sealed image and retires Droid credential settings only after its atomic startup write settles, before any model turn begins.' : protocolRevision === 'r9' ? 'R9 redeclares the existing root default user immediately before every Codex turn, because Harbor rebuilds its per-step environment wrapper after installation. This activates Harbor auth-upload ownership repair on every turn while model commands remain capability-free.' : protocolRevision === 'r8' ? 'R8 explicitly declares the task image existing root default user so Harbor normalizes every per-turn Codex auth upload with the trusted installer CHOWN capability. Model-command children remain capability-free.' : protocolRevision === 'r7' ? 'R7 preserves the R6 command boundary while granting only the trusted installer CHOWN to normalize Docker-copy ownership; model-command children still drop every capability. It also restores the pinned Pi NVM context before extension placement.' : protocolRevision === 'r6' ? 'R6 preserves the R5 runtime and sandbox policy while staging executable wrappers as their owning agent user before privileged placement.' : protocolRevision === 'r5' ? 'R5 preserves the R4 command sandbox while preinstalling pinned provider CLIs outside the runtime capability boundary and extending the pinned DotAgents OpenAI schema to forward Luna max reasoning.' : protocolRevision === 'r4' ? 'R4 gives the trusted harness parent only the capabilities needed to create per-command mount, PID, and network namespaces; every model command starts after all capabilities are dropped, with a minimal non-secret environment and no network. Trace checks remain defense-in-depth.' : 'R3 supplies the complete command grammar on every turn and verifies turn 2 without requiring the turn 3 query command.'}\n` : ''}`);
console.log(output);
