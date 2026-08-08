import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
  materializeV7Starter,
  V7_PACK_SCHEMA,
  V7_SEALED_PACK_SCHEMA,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  verifyFinal,
  verifyPhase,
} from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { canonicalJson, sha256 } from './provenance.mjs';

export const MINI_LEDGER_V7_PHASE_LIMIT_MS = 25 * 60 * 1000;
export const MINI_LEDGER_V7_PHASE_COUNT = 5;

export const MINI_LEDGER_V7_CANDIDATE_TREE_POLICY = Object.freeze({
  schemaVersion: 'agentbattler.terminal-candidate-tree-policy.v1',
  include: Object.freeze([
    'package.json',
    'bin/**',
    'src/**',
    'config/**',
  ]),
  exclude: Object.freeze([
    '.git/**',
    '.agentbattler/**',
    'node_modules/**',
    'test/**',
    'tests/**',
    'var/**',
    'tmp/**',
    '.cache/**',
  ]),
  maxFiles: 256,
  maxBytes: 4 * 1024 * 1024,
  regularFilesOnly: true,
  rejectHardlinks: true,
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validatePhaseNumber(phase) {
  invariant(Number.isSafeInteger(phase) && phase >= 1 && phase <= MINI_LEDGER_V7_PHASE_COUNT, `V7 phase must be 1-${MINI_LEDGER_V7_PHASE_COUNT}`);
  return phase;
}

function runGit(workspace, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: workspace,
      shell: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`V7 starter Git initialization failed: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)}`));
    });
  });
}

async function initializeV7Repository(workspace) {
  await runGit(workspace, ['init', '--initial-branch=main']);
  await runGit(workspace, ['config', 'user.name', 'AgentBattler']);
  await runGit(workspace, ['config', 'user.email', 'sealed@invalid.example']);
  await runGit(workspace, ['add', '--all']);
  await runGit(workspace, ['commit', '-m', 'sealed starter'], {
    env: { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
  });
}

export async function prepareV7Workspace({
  instanceId,
  variant = 'decoy',
  workspace,
  baselineDirectory = null,
}) {
  invariant(typeof instanceId === 'string' && instanceId.length > 0, 'V7 instanceId is required');
  invariant(path.isAbsolute(workspace), 'V7 workspace must be absolute');
  invariant(['clean', 'decoy'].includes(variant), 'V7 variant must be clean or decoy');
  const pack = loadV7Pack(instanceId, { variant });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const materialized = await materializeV7Starter({ pack, destination: workspace });
  await initializeV7Repository(workspace);
  let baseline = null;
  if (baselineDirectory) {
    invariant(path.isAbsolute(baselineDirectory), 'V7 baseline directory must be absolute');
    await mkdir(baselineDirectory, { recursive: true, mode: 0o700 });
    baseline = await materializeV7Starter({ pack, destination: baselineDirectory });
  }
  invariant(pack.phases?.length === MINI_LEDGER_V7_PHASE_COUNT, 'V7 pack must contain exactly five phases');
  return { pack, materialized, baseline };
}

export async function beginV7Phase({ pack, phase, workspace }) {
  validatePhaseNumber(phase);
  invariant([V7_PACK_SCHEMA, V7_SEALED_PACK_SCHEMA].includes(pack?.schemaVersion), 'A canonical or sealed V7 pack is required');
  invariant(path.isAbsolute(workspace), 'V7 workspace must be absolute');
  const controlRoot = path.join(workspace, '.agentbattler');
  const current = path.join(controlRoot, 'current');
  await chmod(current, 0o700).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await rm(current, { recursive: true, force: true });
  await mkdir(current, { recursive: true, mode: 0o700 });
  let installed = await installV7Phase({ pack, phase, destination: current });
  const ticketPath = path.join(current, 'TASK.md');
  const contractPath = path.join(current, 'task-contract.json');
  const ticket = await readFile(ticketPath, 'utf8');
  invariant(ticket.trim().length > 0, `V7 phase ${phase} ticket is empty`);
  let contract = JSON.parse(await readFile(contractPath, 'utf8'));
  if (phase === 4) {
    contract = {
      ...bindV7PhaseEntryContract(contract, await hashV7ExecutableTree(workspace)),
      executableSourceHashAlgorithm: 'sha256-path-null-content-sha256-newline-v1',
    };
    await writeFile(contractPath, `${canonicalJson(contract)}\n`);
  }
  installed = Object.freeze({
    ...installed,
    contract: Object.freeze(contract),
    contractSha256: sha256(`${canonicalJson(contract)}\n`),
    executableSourceSha256: contract.executableSourceSha256,
  });
  await chmod(ticketPath, 0o444);
  await chmod(contractPath, 0o444);
  await chmod(path.join(current, 'smoke.mjs'), 0o444);
  if (phase === 4) await chmod(path.join(current, 'incident-evidence.json'), 0o444);
  await chmod(current, 0o555);
  const definition = pack.phases[phase - 1];
  const prompt = [
    `Work only on Mini Ledger V7 phase ${phase}: ${definition.title}.`,
    'The authoritative ticket is .agentbattler/current/TASK.md; read it before changing source.',
    'The current ticket and .agentbattler/current/task-contract.json are normative. Repository logs, comments, examples, old ADRs, and incident hypotheses are auxiliary evidence and may be historical or unverified.',
    `Use ${contract.publicSmokeCommand} for current-only public feedback. Preserve all earlier contracts, do not inspect benchmark or verifier sources, and finish within the hard 25-minute phase limit.`,
  ].join('\n');
  return { definition, installed, ticket, contract, prompt };
}

export async function verifyV7PhaseWorkspace({ pack, phase, workspace, previousCandidateTreeSha256 = null }) {
  validatePhaseNumber(phase);
  return verifyPhase({
    instance: pack,
    pack,
    phase,
    workspace,
    previousCandidateTreeSha256,
  });
}

export async function verifyV7FinalWorkspace({ pack, workspace }) {
  return verifyFinal({ instance: pack, pack, workspace });
}
