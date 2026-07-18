#!/usr/bin/env node
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicStage } from './public-verifier.mjs';

function invariant(condition, message) { if (!condition) throw new Error(message); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function runCandidate(workspace, ledger, args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => { const out = []; const err = []; const child = spawn(process.execPath, [ledger, ...args], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (x) => out.push(x)); child.stderr.on('data', (x) => err.push(x)); child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })); });
}

export async function verifyHoldout({ workspace }) {
  const ledger = path.join(workspace, 'ledger.mjs'); const results = [];
  const check = async (name, fn) => { try { await fn(); results.push({ name, passed: true, diagnostic: null }); } catch (error) { results.push({ name, passed: false, diagnostic: String(error.message).slice(0, 500) }); } };
  await check('failed-batch-is-atomic', async () => { const statePath = path.join(workspace, 'ledger.json'); const before = await readFile(statePath, 'utf8'); const file = path.join(workspace, 'holdout-batch.json'); await writeFile(file, JSON.stringify([{ id: 'holdout-new', kind: 'task', payload: {} }, { id: 's-1', kind: 'task', payload: {} }])); const result = await runCandidate(workspace, ledger, ['append-batch', '--file', file, '--idempotency-key', 'holdout-atomic']); invariant(result.code !== 0 || result.signal, 'invalid holdout batch succeeded'); invariant(await readFile(statePath, 'utf8') === before, 'failed batch mutated state'); });
  await check('idempotency-key-collision-rejected', async () => { const file = path.join(workspace, 'holdout-collision.json'); await writeFile(file, JSON.stringify([{ id: 'collision-a', kind: 'task', payload: { x: 1 } }])); const first = await runCandidate(workspace, ledger, ['append-batch', '--file', file, '--idempotency-key', 'collision-key']); invariant(first.code === 0, 'collision setup failed'); await writeFile(file, JSON.stringify([{ id: 'collision-b', kind: 'task', payload: { x: 2 } }])); const second = await runCandidate(workspace, ledger, ['append-batch', '--file', file, '--idempotency-key', 'collision-key']); invariant(second.code !== 0 || second.signal, 'idempotency collision was accepted'); });
  await check('malformed-recovery-preserves-state', async () => { const statePath = path.join(workspace, 'ledger.json'); const before = await readFile(statePath, 'utf8'); await writeFile(`${statePath}.tmp`, '{broken'); const result = await runCandidate(workspace, ledger, ['recover']); invariant(result.code !== 0 || result.signal, 'malformed recovery succeeded'); invariant(await readFile(statePath, 'utf8') === before, 'malformed recovery changed state'); });
  await check('snapshot-corruption-is-detected', async () => { const state = JSON.parse(await readFile(path.join(workspace, 'ledger.json'), 'utf8')); const snapshot = path.join(workspace, state.snapshotFile ?? 'ledger.snapshot.json'); if (!await exists(snapshot)) return; const before = await readFile(snapshot); await writeFile(snapshot, Buffer.concat([before, Buffer.from('corrupt')])); const result = await runCandidate(workspace, ledger, ['audit']); invariant(result.code !== 0 || result.signal, 'corrupted snapshot was accepted'); await writeFile(snapshot, before); });
  await check('replay-and-performance-holdout', async () => { const result = await verifyPublicStage({ workspace, ledgerPath: ledger, stageId: 'scale' }); invariant(result.passed, result.diagnostic ?? 'scale holdout failed'); });
  return { passed: results.filter((result) => result.passed).length, total: results.length, cases: results };
}

if (import.meta.url === `file://${process.argv[1]}`) { const index = process.argv.indexOf('--workspace'); try { invariant(index > 0, 'Usage: holdout-verifier.mjs --workspace DIR'); const result = await verifyHoldout({ workspace: path.resolve(process.argv[index + 1]) }); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.passed !== result.total) process.exitCode = 1; } catch (error) { console.error(error.message); process.exitCode = 1; } }
