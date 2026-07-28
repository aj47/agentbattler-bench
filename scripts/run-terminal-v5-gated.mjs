#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTerminalJobIdentity } from '../src/terminal-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT_ROOT = path.join(ROOT, 'results', 'terminal-mini-ledger-v5-r2');
const STATE_PATH = path.join(RESULT_ROOT, 'orchestration.json');
const HARNESS_ORDER = Object.freeze(['codex-cli', 'pi-coding-agent', 'dotagents-mono', 'claude-code']);
const LUNA_MODEL = 'gpt-5.6-luna';
const GATE_GENERATION = 1;
const BASE_ENV = Object.freeze({
  AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: 'v5',
  AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: 'r2',
  AGENTBATTLER_TERMINAL_RESULT_TAG: 'v5-r2',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function selectLunaGateJobs(schedule, harnesses = HARNESS_ORDER) {
  return harnesses.map((harness) => {
    const coverage = schedule.coverage.find((entry) => entry.combo.harness.id === harness && entry.combo.model.id === LUNA_MODEL);
    invariant(coverage, `Schedule has no ${harness} × ${LUNA_MODEL} combo`);
    const artifact = coverage.artifacts.find((entry) => entry.generationIndex === GATE_GENERATION);
    invariant(artifact, `Schedule has no generation ${GATE_GENERATION} artifact for ${harness} × ${LUNA_MODEL}`);
    const job = schedule.jobs.find((entry) => entry.comboId === coverage.combo.comboId && entry.artifactId === artifact.id && entry.generationIndex === GATE_GENERATION);
    invariant(job, `Schedule has no job for ${artifact.id}`);
    return { harness, model: LUNA_MODEL, generationIndex: GATE_GENERATION, combo: coverage.combo, job };
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeState(state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
  return next;
}

let activeChild = null;
let stopping = false;

function stopActiveChild(signal) {
  if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;
  try { process.kill(-activeChild.pid, signal); } catch { activeChild.kill(signal); }
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopping = true;
      stopActiveChild(signal);
      setTimeout(() => stopActiveChild('SIGKILL'), 15_000).unref();
    });
  }
}

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...BASE_ENV },
      detached: true,
      stdio: 'inherit',
    });
    activeChild = child;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      activeChild = null;
      if (stopping) reject(new Error(`V5 gate interrupted by ${signal ?? 'signal'}`));
      else if (code === 0 && !signal) resolve();
      else reject(new Error(`${script} exited ${code ?? signal}`));
    });
  });
}

async function acceptedRun(gate) {
  const file = path.join(RESULT_ROOT, 'runs', `${gate.job.runKey}.json`);
  let run;
  try { run = await readJson(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  validateTerminalJobIdentity(gate.job, run);
  invariant(run.status !== 'infrastructure-invalid', `${gate.harness} Luna gate is infrastructure-invalid: ${run.error?.message ?? 'unknown infrastructure error'}`);
  invariant(run.status === 'completed' && run.validity === 'valid', `${gate.harness} Luna gate did not produce an accepted result`);
  return run;
}

export async function runV5Gate() {
  installSignalHandlers();
  const [challenge, schedule] = await Promise.all([
    readJson(path.join(RESULT_ROOT, 'challenge.json')),
    readJson(path.join(RESULT_ROOT, 'schedule.json')),
  ]);
  invariant(challenge.execution?.protocolRevision === 'r2', 'V5 gate requires protocol revision r2');
  invariant(challenge.protocol?.maxWallTimeMs === 1_800_000, 'V5 gate requires the sealed 30-minute turn limit');
  invariant(schedule.challenge?.id === challenge.challengeId && schedule.challenge?.sha256 === challenge.challengeSha256, 'Schedule does not match the sealed challenge');
  const gates = selectLunaGateJobs(schedule);
  let state = await writeState({
    schemaVersion: 'agentbattler.v5-orchestration.v1',
    challengeId: challenge.challengeId,
    challengeSha256: challenge.challengeSha256,
    releaseCommit: process.env.AGENTBATTLER_RELEASE_COMMIT ?? null,
    startedAt: new Date().toISOString(),
    phase: 'luna-gates',
    gates: [],
  });

  for (const gate of gates) {
    let run = await acceptedRun(gate);
    if (!run) {
      state = await writeState({ ...state, phase: 'luna-gates', activeGate: gate.harness });
      await runNode('scripts/run-terminal-matrix.mjs', [
        '--adapter', 'scripts/terminal-adapter-all.mjs',
        '--harness', gate.harness,
        '--model', gate.model,
        '--generation', String(gate.generationIndex),
        '--concurrency', '1',
      ]);
      run = await acceptedRun(gate);
      invariant(run, `${gate.harness} Luna gate produced no result record`);
    }
    const gateRecord = {
      harness: gate.harness,
      artifactId: gate.job.artifactId,
      runKey: gate.job.runKey,
      resultSha256: run.resultSha256,
      score: run.score ?? null,
      durationMs: run.durationMs,
      acceptedAt: new Date().toISOString(),
    };
    state = await writeState({
      ...state,
      activeGate: null,
      gates: [...state.gates.filter((entry) => entry.harness !== gate.harness), gateRecord],
    });
  }

  state = await writeState({ ...state, phase: 'matrix-running', activeGate: null, matrixStartedAt: new Date().toISOString() });
  await runNode('scripts/run-terminal-matrix-all.mjs');
  state = await writeState({ ...state, phase: 'complete', completedAt: new Date().toISOString() });
  return state;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  try {
    const state = await runV5Gate();
    console.log(`V5 gated matrix complete: ${state.challengeId}`);
  } catch (error) {
    try {
      const existing = await readJson(STATE_PATH);
      await writeState({ ...existing, phase: stopping ? 'interrupted' : 'failed', error: String(error?.stack ?? error).slice(0, 4000) });
    } catch { /* Preserve the original failure when state persistence also fails. */ }
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
