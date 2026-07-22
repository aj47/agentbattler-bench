#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { verifyHoldout as verifyV3Holdout } from '../mini-ledger-v3/holdout-verifier.mjs';
import { verifyPublicStage } from './public-verifier.mjs';
import { candidateSpawnOptions } from '../candidate-process.mjs';

function invariant(condition, message) { if (!condition) throw new Error(message); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function run(workspace, ledger, args) { return new Promise((resolve, reject) => { const out = []; const err = []; const child = spawn(process.execPath, [ledger, ...args], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], ...candidateSpawnOptions() }); child.stdout.on('data', (x) => out.push(x)); child.stderr.on('data', (x) => err.push(x)); child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })); }); }
async function check(results, name, fn) { try { await fn(); results.push({ name, passed: true, diagnostic: null }); } catch (error) { results.push({ name, passed: false, diagnostic: String(error.message).slice(0, 500) }); } }
export async function verifyHoldout({ workspace }) {
  const base = await verifyV3Holdout({ workspace }); const results = [...base.cases]; const ledger = path.join(workspace, 'ledger.mjs');
  await check(results, 'concurrent-stress-batches', async () => { const result = await verifyPublicStage({ workspace, ledgerPath: ledger, stageId: 'stress-concurrency' }); invariant(result.passed, result.diagnostic ?? 'stress concurrency failed'); });
  await check(results, 'validation-and-fault-injection', async () => { const result = await verifyPublicStage({ workspace, ledgerPath: ledger, stageId: 'validation' }); invariant(result.passed, result.diagnostic ?? 'validation failed'); });
  await check(results, 'scale-stress-and-replay', async () => { const result = await verifyPublicStage({ workspace, ledgerPath: ledger, stageId: 'scale-stress' }); invariant(result.passed, result.diagnostic ?? 'scale stress failed'); });
  await check(results, 'same-id-race', async () => { const file = path.join(workspace, 'same-id-holdout.json'); await writeFile(file, JSON.stringify([{ id: 'race-holdout', kind: 'task', payload: { race: true } }])); const attempts = await Promise.all(Array.from({ length: 12 }, () => run(workspace, ledger, ['append-batch', '--file', file, '--idempotency-key', 'race-holdout']))); invariant(attempts.filter((x) => x.code === 0 && !x.signal).length === 1, 'same idempotency key did not commit exactly once'); const rows = JSON.parse((await run(workspace, ledger, ['query', '--kind', 'task', '--after-sequence', '0', '--limit', '100000'])).stdout); invariant(rows.filter((row) => row.id === 'race-holdout').length === 1, 'same idempotency race committed an unexpected number of events'); });
  await check(results, 'atomic-import-replacement', async () => { const state = await readFile(path.join(workspace, 'ledger.json'), 'utf8'); const bad = path.join(workspace, 'bad-import-holdout.json'); await writeFile(bad, JSON.stringify({ schemaVersion: 'agentbattler.ledger.v2', events: [{ id: 'x', kind: 'task', payload: {}, sequence: 4 }, { id: 'x', kind: 'task', payload: {}, sequence: 5 }] })); const result = await run(workspace, ledger, ['import', bad]); invariant(result.code !== 0 || result.signal, 'invalid import succeeded'); invariant(await readFile(path.join(workspace, 'ledger.json'), 'utf8') === state, 'invalid import replaced primary state'); });
  await check(results, 'stale-lock-recovery', async () => { await writeFile(path.join(workspace, 'ledger.lock'), 'stale-lock'); const result = await run(workspace, ledger, ['recover']); invariant(result.code === 0 && !result.signal, 'stale lock was not recoverable'); invariant(!await exists(path.join(workspace, 'ledger.lock')), 'stale lock remained after recovery'); });
  return { passed: results.filter((result) => result.passed).length, total: results.length, cases: results };
}
