#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadV7Pack } from '../../challenges/mini-ledger-v7/pack.mjs';
import { verifyFinal, verifyPhaseTrajectory } from '../../challenges/mini-ledger-v7/verifier.mjs';
import { candidateNativeSandboxCommand } from '../../challenges/candidate-process.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function zeroCapabilityProbe() {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', "sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status"], {
      uid: 1000,
      gid: 1000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
    }));
  });
  invariant(result.code === 0 && !result.signal, `candidate capability probe failed: ${result.stderr}`);
  invariant(/^0+$/.test(result.stdout), `candidate verifier child capability mask is not zero: ${result.stdout || '<missing>'}`);
  return result.stdout;
}

async function nativeBoundaryProbe() {
  const invocation = candidateNativeSandboxCommand({
    workspace: '/candidate',
    executable: '/bin/sh',
    args: ['-c', 'test ! -e /tests && test ! -e /input && test ! -e /output && test ! -e /evidence && test -r /workspace && printf native-boundary-ok'],
  });
  invariant(invocation.nativeBoundary === true, 'V7 candidate native boundary was not selected');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      ...invocation.options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  invariant(result.code === 0 && !result.signal && result.stdout === 'native-boundary-ok', `candidate native boundary probe failed: ${result.stderr}`);
  return 'bubblewrap-v1';
}

export async function runTerminalV7Verifier() {
  const request = JSON.parse(await readFile('/input/request.json', 'utf8'));
  invariant(request?.schemaVersion === 'agentbattler.terminal-v7-verifier-request.v1', 'Unsupported V7 verifier request');
  invariant(['phase', 'final'].includes(request.mode), 'V7 verifier request mode is invalid');
  invariant(typeof request.instanceId === 'string' && ['clean', 'decoy'].includes(request.variant), 'V7 verifier request instance is invalid');
  const seedKey = await readFile('/input/seed-key', 'utf8').then((value) => value.trim()).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  process.env.AGENTBATTLER_CANDIDATE_UID = '1000';
  process.env.AGENTBATTLER_CANDIDATE_GID = '1000';
  process.env.AGENTBATTLER_CANDIDATE_NATIVE_SANDBOX = 'bubblewrap-v1';
  const pack = loadV7Pack(request.instanceId, { variant: request.variant });
  const capabilityMask = await zeroCapabilityProbe();
  const nativeBoundary = await nativeBoundaryProbe();
  const common = {
    instance: pack,
    pack,
    workspace: '/candidate',
    seedKey,
    verifierSeedIndex: request.verifierSeedIndex ?? 0,
    durabilityTraceDirectory: '/evidence/durability',
  };
  const result = request.mode === 'phase'
    ? await verifyPhaseTrajectory({
        ...common,
        phase: request.phase,
        contract: request.contract ?? null,
        phaseContracts: request.phaseContracts ?? null,
        phaseResults: request.phaseResults ?? [],
      })
    : await verifyFinal({
        ...common,
        phaseResults: request.phaseResults ?? [],
        phaseContracts: request.phaseContracts ?? null,
      });
  const output = {
    schemaVersion: 'agentbattler.terminal-v7-verifier-container-result.v1',
    candidateCapabilityMask: capabilityMask,
    candidateNativeBoundary: nativeBoundary,
    evaluation: result,
  };
  const temporary = `/output/result.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, '/output/result.json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runTerminalV7Verifier();
