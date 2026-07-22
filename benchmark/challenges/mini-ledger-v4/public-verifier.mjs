#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { verifyPublicStage as verifyV3Stage } from '../mini-ledger-v3/public-verifier.mjs';

function invariant(condition, message) { if (!condition) throw new Error(message); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function run(workspace, ledger, args, { expectFailure = false, timeoutMs = 180_000 } = {}) {
  const result = await new Promise((resolve, reject) => {
    const out = []; const err = []; const child = spawn(process.execPath, [ledger, ...args], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk)); child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject); child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
  });
  const output = result.stdout.trim();
  if (expectFailure) { invariant(result.code !== 0 || result.signal, `Expected ${args[0]} to fail`); return result; }
  invariant(result.code === 0 && !result.signal, `${args[0]} failed: ${result.stderr.trim() || output}`);
  try { return { ...result, json: JSON.parse(output) }; } catch (error) { throw new Error(`${args[0]} did not emit one JSON value: ${error.message}`); }
}
async function prepare(workspace, ledger) {
  await mkdir(workspace, { recursive: true }); invariant(await exists(ledger), `Missing candidate ledger: ${ledger}`);
  for (const file of ['ledger.json', 'ledger.json.tmp', 'ledger.snapshot.json', 'ledger.journal.jsonl', 'ledger.lock']) await rm(path.join(workspace, file), { force: true });
}
async function appendBatch(workspace, ledger, file, key, options = {}) { return run(workspace, ledger, ['append-batch', '--file', file, '--idempotency-key', key], options); }
async function query(workspace, ledger, kind = 'task', after = 0, limit = 50) { return (await run(workspace, ledger, ['query', '--kind', kind, '--after-sequence', String(after), '--limit', String(limit)])).json; }
async function writeBatch(workspace, name, start, count, prefix = 'task') {
  const events = Array.from({ length: count }, (_, i) => ({ id: `${name}-${start + i}`, kind: prefix, payload: { n: start + i } }));
  const file = path.join(workspace, `${name}.json`); await writeFile(file, JSON.stringify(events)); return file;
}
async function stressConcurrency(workspace, ledger) {
  await prepare(workspace, ledger); const jobs = [];
  for (let worker = 0; worker < 8; worker += 1) {
    const file = await writeBatch(workspace, `stress-${worker}`, worker * 25, 25);
    jobs.push(new Promise((resolve, reject) => { const child = spawn(process.execPath, [ledger, 'append-batch', '--file', file, '--idempotency-key', `stress-${worker}`], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: 'ignore' }); child.on('error', reject); child.on('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`stress batch failed: ${code ?? signal}`))); }));
  }
  await Promise.all(jobs); const events = await query(workspace, ledger, 'task', 0, 300); invariant(events.length === 200 && new Set(events.map((x) => x.sequence)).size === 200, 'concurrent batches lost events or sequence numbers');
  const same = await writeBatch(workspace, 'same', 10_000, 1); const races = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => { const child = spawn(process.execPath, [ledger, 'append-batch', '--file', same, '--idempotency-key', 'same-key'], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: 'ignore' }); child.on('close', (code, signal) => resolve(code === 0 && !signal)); child.on('error', () => resolve(false)); })));
  invariant(races.filter(Boolean).length === 1, 'same idempotency key did not commit exactly once'); const afterRace = await query(workspace, ledger, 'task', 0, 300); invariant(afterRace.filter((event) => event.id === 'same-10000').length === 1, 'same idempotency race committed an unexpected number of events');
}
async function validation(workspace, ledger) {
  await prepare(workspace, ledger); const baseline = path.join(workspace, 'baseline.json'); await writeFile(baseline, JSON.stringify({ schemaVersion: 'agentbattler.ledger.v2', events: [{ id: 'seed', kind: 'task', payload: {}, sequence: 1 }], nextSequence: 2 })); await run(workspace, ledger, ['import', baseline]);
  const before = await readFile(path.join(workspace, 'ledger.json'), 'utf8');
  await run(workspace, ledger, ['query', '--kind', 'task', '--after-sequence', '0', '--limit', '0'], { expectFailure: true });
  await run(workspace, ledger, ['compact', '--keep', '0'], { expectFailure: true });
  const malformed = path.join(workspace, 'malformed.json'); await writeFile(malformed, '{bad'); await run(workspace, ledger, ['import', malformed], { expectFailure: true });
  const unknown = path.join(workspace, 'unknown.json'); await writeFile(unknown, JSON.stringify({ schemaVersion: 'unknown.schema', events: [] })); await run(workspace, ledger, ['import', unknown], { expectFailure: true });
  const bad = path.join(workspace, 'bad.json'); await writeFile(bad, JSON.stringify([{ id: 'x', kind: 'task', payload: {} }, { id: 'x', kind: 'task', payload: {} }])); await appendBatch(workspace, ledger, bad, 'duplicate-in-batch', { expectFailure: true });
  const existing = path.join(workspace, 'existing.json'); await writeFile(existing, JSON.stringify([{ id: 'seed', kind: 'task', payload: {} }])); await appendBatch(workspace, ledger, existing, 'duplicate-existing', { expectFailure: true });
  invariant(await readFile(path.join(workspace, 'ledger.json'), 'utf8') === before, 'invalid input mutated primary state');
  const idem = path.join(workspace, 'idem.json'); await writeFile(idem, JSON.stringify([{ id: 'idem-1', kind: 'task', payload: { version: 1 } }])); await appendBatch(workspace, ledger, idem, 'validation-idem'); const afterIdem = await readFile(path.join(workspace, 'ledger.json'), 'utf8'); await writeFile(idem, JSON.stringify([{ id: 'idem-1', kind: 'task', payload: { version: 2 } }])); await appendBatch(workspace, ledger, idem, 'validation-idem', { expectFailure: true }); invariant(await readFile(path.join(workspace, 'ledger.json'), 'utf8') === afterIdem, 'idempotency collision mutated primary state');
  await writeFile(path.join(workspace, 'ledger.lock'), 'stale'); await run(workspace, ledger, ['recover']); await run(workspace, ledger, ['audit']);
}
async function scaleStress(workspace, ledger) {
  await prepare(workspace, ledger); const jobs = []; for (let worker = 0; worker < 8; worker += 1) { const file = await writeBatch(workspace, `scale-stress-${worker}`, worker * 1_250, 1_250); jobs.push(new Promise((resolve, reject) => { const child = spawn(process.execPath, [ledger, 'append-batch', '--file', file, '--idempotency-key', `scale-stress-${worker}`], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: 'ignore' }); child.on('error', reject); child.on('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`scale batch failed: ${code ?? signal}`))); })); } await Promise.all(jobs);
  let after = 0; let total = 0; for (let page = 0; page < 1_000; page += 1) { const rows = await query(workspace, ledger, 'task', after, 13); if (!rows.length) break; total += rows.length; after = rows.at(-1).sequence; } invariant(total === 10_000, `paged stress query returned ${total} events`);
  const exportPath = path.join(workspace, 'stress-export.json'); await run(workspace, ledger, ['export', exportPath]); const fresh = path.join(workspace, 'scale-fresh'); const freshLedger = path.join(fresh, 'ledger.mjs'); const freshExport = path.join(fresh, 'stress-export.json'); await rm(fresh, { recursive: true, force: true }); await mkdir(fresh, { recursive: true }); await copyFile(ledger, freshLedger); await copyFile(exportPath, freshExport); await run(fresh, freshLedger, ['import', freshExport]); invariant((await query(fresh, freshLedger, 'task', 0, 10_100)).length === 10_000, 'scale import lost logical records'); await run(fresh, freshLedger, ['replay']); await run(fresh, freshLedger, ['audit']); await run(workspace, ledger, ['compact', '--keep', '100']); await run(workspace, ledger, ['replay']); await run(workspace, ledger, ['audit']);
}
export async function verifyPublicStage({ workspace, ledgerPath = path.join(workspace, 'ledger.mjs'), stageId }) {
  if (!['stress-concurrency', 'validation', 'scale-stress'].includes(stageId)) return verifyV3Stage({ workspace, ledgerPath, stageId });
  const started = Date.now(); try { if (stageId === 'stress-concurrency') await stressConcurrency(workspace, ledgerPath); else if (stageId === 'validation') await validation(workspace, ledgerPath); else await scaleStress(workspace, ledgerPath); return { id: stageId, passed: true, regressions: 0, exitCode: 0, durationMs: Date.now() - started, diagnostic: null }; } catch (error) { return { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: Date.now() - started, diagnostic: String(error.message).slice(0, 500) }; }
}
