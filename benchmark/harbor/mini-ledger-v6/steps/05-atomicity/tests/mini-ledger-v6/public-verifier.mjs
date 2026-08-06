#!/usr/bin/env node
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  verifyPublicStage as verifyV4PublicStage,
  verifyPublicStageInWorkspace as verifyV4PublicStageInWorkspace,
} from '../mini-ledger-v4/public-verifier.mjs';
import { candidateSpawnOptions, withCandidateWorkspace } from '../candidate-process.mjs';

const PRIMARY_FILE = 'ledger.json';
const SCHEMA = 'agentbattler.ledger.v2';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCandidate(workspace, ledgerPath, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const child = spawn(process.execPath, [ledgerPath, ...args], {
      cwd: workspace,
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...candidateSpawnOptions(),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function successful(result) {
  return result.code === 0 && !result.signal && !result.timedOut;
}

function successfulJson(result, command) {
  invariant(successful(result), `${command} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`${command} did not emit one JSON value: ${error.message}`);
  }
}

async function prepare(workspace, ledgerPath) {
  for (const entry of await readdir(workspace)) {
    if (path.join(workspace, entry) !== ledgerPath) {
      await rm(path.join(workspace, entry), { recursive: true, force: true });
    }
  }
}

function exactEvent(actual, expected) {
  invariant(actual && typeof actual === 'object' && !Array.isArray(actual), `get ${expected.id} did not return an event object`);
  invariant(actual.id === expected.id, `get returned ${actual.id ?? 'no id'} instead of ${expected.id}`);
  invariant(actual.kind === expected.kind, `${expected.id} has the wrong kind`);
  invariant(actual.sequence === expected.sequence, `${expected.id} has sequence ${actual.sequence ?? 'missing'} instead of ${expected.sequence}`);
  invariant(JSON.stringify(actual.payload) === JSON.stringify(expected.payload), `${expected.id} has the wrong payload`);
}

async function stageBatch(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath);
  const append = await runCandidate(workspace, ledgerPath, ['append', '--id', 'a1', '--kind', 'task', '--payload', '{"seed":true}']);
  exactEvent(successfulJson(append, 'append'), { id: 'a1', kind: 'task', payload: { seed: true }, sequence: 1 });

  const batchEvents = [
    { id: 'b1', kind: 'task', payload: { n: 1 } },
    { id: 'b2', kind: 'note', payload: { n: 2 } },
    { id: 'b3', kind: 'task', payload: { n: 3 } },
  ];
  const batchPath = path.join(workspace, 'batch.json');
  await writeFile(batchPath, JSON.stringify(batchEvents));
  const batchResponse = successfulJson(await runCandidate(workspace, ledgerPath, ['append-batch', '--file', batchPath, '--idempotency-key', 'k1']), 'append-batch');
  invariant(batchResponse && typeof batchResponse === 'object' && !Array.isArray(batchResponse), 'append-batch did not return an object');

  const primaryPath = path.join(workspace, PRIMARY_FILE);
  const committedBytes = await readFile(primaryPath, 'utf8');
  const committed = JSON.parse(committedBytes);
  invariant(committed.schemaVersion === SCHEMA, 'batch did not preserve the live v2 state schema');
  invariant(Array.isArray(committed.events) && committed.events.length === 4, `batch committed ${committed.events?.length ?? 'an invalid number of'} events instead of four`);
  invariant(committed.nextSequence === 5, `batch left nextSequence at ${committed.nextSequence ?? 'missing'} instead of 5`);
  for (const expected of [
    { id: 'a1', kind: 'task', payload: { seed: true }, sequence: 1 },
    ...batchEvents.map((event, index) => ({ ...event, sequence: index + 2 })),
  ]) {
    exactEvent(committed.events.find((event) => event.id === expected.id), expected);
    exactEvent(successfulJson(await runCandidate(workspace, ledgerPath, ['get', '--id', expected.id]), 'get'), expected);
  }

  const retry = await runCandidate(workspace, ledgerPath, ['append-batch', '--file', batchPath, '--idempotency-key', 'k1']);
  invariant(!retry.timedOut && !retry.signal, 'identical idempotent retry did not terminate cleanly');
  if (successful(retry)) {
    const response = successfulJson(retry, 'append-batch retry');
    invariant(response && typeof response === 'object' && !Array.isArray(response), 'successful idempotent retry did not return an object');
    invariant(response.idempotent === true || response.alreadyApplied === true || response.status === 'idempotent', 'successful idempotent retry was not explicitly identified');
  } else {
    invariant(retry.code !== 0, 'identical idempotent retry had an invalid exit status');
  }
  invariant(await readFile(primaryPath, 'utf8') === committedBytes, 'identical idempotent retry mutated primary state');

  const invalidPath = path.join(workspace, 'bad-batch.json');
  await writeFile(invalidPath, JSON.stringify([
    { id: 'b4', kind: 'task', payload: { n: 4 } },
    { id: 'b1', kind: 'task', payload: { duplicate: true } },
  ]));
  const invalid = await runCandidate(workspace, ledgerPath, ['append-batch', '--file', invalidPath, '--idempotency-key', 'k2']);
  invariant(!invalid.timedOut && !invalid.signal && invalid.code !== 0, 'invalid batch did not fail cleanly');
  invariant(await readFile(primaryPath, 'utf8') === committedBytes, 'failed batch mutated primary state');
  const missing = await runCandidate(workspace, ledgerPath, ['get', '--id', 'b4']);
  invariant(!missing.timedOut && !missing.signal && missing.code !== 0, 'failed batch made b4 visible');
}

function result(stageId, startedAt, error = null) {
  return error
    ? { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: Date.now() - startedAt, diagnostic: String(error.message).slice(0, 500) }
    : { id: stageId, passed: true, regressions: 0, exitCode: 0, durationMs: Date.now() - startedAt, diagnostic: null };
}

export async function verifyPublicStageInWorkspace({ workspace, ledgerPath = path.join(workspace, 'ledger.mjs'), stageId }) {
  if (stageId !== 'batch') return verifyV4PublicStageInWorkspace({ workspace, ledgerPath, stageId });
  const startedAt = Date.now();
  try {
    await stageBatch(workspace, ledgerPath);
    return result(stageId, startedAt);
  } catch (error) {
    return result(stageId, startedAt, error);
  }
}

export async function verifyPublicStage({ workspace, ledgerPath = path.join(workspace, 'ledger.mjs'), stageId }) {
  if (stageId !== 'batch') return verifyV4PublicStage({ workspace, ledgerPath, stageId });
  return withCandidateWorkspace(ledgerPath, `public-${stageId}`, (candidate) => verifyPublicStageInWorkspace({ ...candidate, stageId }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceIndex = process.argv.indexOf('--workspace');
  const stageIndex = process.argv.indexOf('--stage');
  try {
    invariant(workspaceIndex > 0 && stageIndex > 0, 'Usage: public-verifier.mjs --workspace DIR --stage STAGE');
    const stage = await verifyPublicStage({ workspace: path.resolve(process.argv[workspaceIndex + 1]), stageId: process.argv[stageIndex + 1] });
    process.stdout.write(`${JSON.stringify(stage)}\n`);
    if (!stage.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
