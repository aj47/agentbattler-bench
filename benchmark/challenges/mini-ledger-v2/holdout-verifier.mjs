#!/usr/bin/env node
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicStage } from './public-verifier.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function verifyHoldout({ workspace }) {
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true, diagnostic: null }); } catch (error) { results.push({ name, passed: false, diagnostic: String(error.message).slice(0, 500) }); }
  };
  const ledger = path.join(workspace, 'ledger.mjs');
  const runCandidate = async (args) => {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const stdout = []; const stderr = [];
      const child = spawn(process.execPath, [ledger, ...args], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    });
  };
  await check('missing-record-exit', async () => {
    const result = await runCandidate(['get', '--id', 'does-not-exist']);
    invariant(result.exitCode !== 0 || result.signal, 'missing get must exit non-zero');
  });
  await check('invalid-import-preserves-state', async () => {
    const statePath = path.join(workspace, 'ledger.json');
    const before = await readFile(statePath, 'utf8');
    const invalid = path.join(workspace, 'holdout-invalid.json');
    await writeFile(invalid, '{not-json');
    const result = await runCandidate(['import', invalid]);
    invariant(result.exitCode !== 0 || result.signal, 'invalid import must fail');
    invariant(await readFile(statePath, 'utf8') === before, 'invalid import mutated state');
  });
  await check('deterministic-query-order', async () => {
    const result = await runCandidate(['query', '--kind', 'task', '--limit', '24']);
    invariant(result.exitCode === 0, 'query failed');
    const values = JSON.parse(result.stdout);
    invariant(values.every((item, index) => index === 0 || values[index - 1].sequence <= item.sequence), 'query order is not deterministic');
  });
  await check('recovery-contract', async () => {
    const statePath = path.join(workspace, 'ledger.json');
    const state = await readFile(statePath, 'utf8');
    await writeFile(`${statePath}.tmp`, state); await rm(statePath);
    const result = await runCandidate(['recover']);
    invariant(result.exitCode === 0, 'recover failed'); invariant(await exists(statePath), 'recover did not restore state');
  });
  await check('public-performance-stage', async () => {
    const result = await verifyPublicStage({ workspace, ledgerPath: ledger, stageId: 'performance' });
    invariant(result.passed, result.diagnostic ?? 'performance stage failed');
  });
  return { passed: results.filter((result) => result.passed).length, total: results.length, cases: results };
}

async function cli() {
  const index = process.argv.indexOf('--workspace');
  invariant(index > 0, 'Usage: holdout-verifier.mjs --workspace DIR');
  const result = await verifyHoldout({ workspace: path.resolve(process.argv[index + 1]) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.passed !== result.total) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
