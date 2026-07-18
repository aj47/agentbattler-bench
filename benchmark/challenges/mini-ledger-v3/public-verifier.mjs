#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const LEDGER_FILE = 'ledger.json';
const SCHEMA = 'agentbattler.ledger.v2';

function invariant(condition, message) { if (!condition) throw new Error(message); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }

async function runLedger(workspace, ledgerPath, args, { expectFailure = false, timeoutMs = 30_000 } = {}) {
  const result = await new Promise((resolve, reject) => {
    const stdout = []; const stderr = [];
    const child = spawn(process.execPath, [ledgerPath, ...args], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject); child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  });
  const output = result.stdout.trim(); const error = result.stderr.trim();
  if (expectFailure) { invariant(result.exitCode !== 0 || result.signal, `Expected ${args[0]} to fail`); return { ...result, output, error, json: null }; }
  invariant(result.exitCode === 0 && !result.signal, `${args[0]} failed: ${error || output}`);
  let json; try { json = JSON.parse(output); } catch (cause) { throw new Error(`${args[0]} did not emit one JSON value: ${cause.message}`); }
  return { ...result, output, error, json };
}

async function prepare(workspace, ledgerPath) {
  await mkdir(workspace, { recursive: true }); invariant(await exists(ledgerPath), `Missing candidate ledger: ${ledgerPath}`);
  for (const file of [LEDGER_FILE, `${LEDGER_FILE}.tmp`, 'ledger.snapshot.json', 'ledger.journal.jsonl', 'ledger.lock']) await rm(path.join(workspace, file), { force: true });
}
async function append(workspace, ledgerPath, id, kind = 'task', payload = { id }) { return runLedger(workspace, ledgerPath, ['append', '--id', id, '--kind', kind, '--payload', JSON.stringify(payload)]); }
async function appendBatch(workspace, ledgerPath, file, key, options = {}) { return runLedger(workspace, ledgerPath, ['append-batch', '--file', file, '--idempotency-key', key], options); }
async function query(workspace, ledgerPath, kind, after = 0, limit = 10) { return (await runLedger(workspace, ledgerPath, ['query', '--kind', kind, '--after-sequence', String(after), '--limit', String(limit)])).json; }
async function seedSmall(workspace, ledgerPath) {
  await append(workspace, ledgerPath, 'a1', 'task', { title: 'first' });
  await append(workspace, ledgerPath, 'a2', 'note', { title: 'second' });
  const batch = path.join(workspace, 'batch.json');
  await writeFile(batch, JSON.stringify([{ id: 'b1', kind: 'task', payload: { title: 'third' } }, { id: 'b2', kind: 'note', payload: { title: 'fourth' } }, { id: 'b3', kind: 'task', payload: { title: 'fifth' }}]));
  await appendBatch(workspace, ledgerPath, batch, 'batch-001'); await appendBatch(workspace, ledgerPath, batch, 'batch-001');
}
function rows(value) { invariant(Array.isArray(value), 'query did not return an array'); return value; }

async function stageFoundation(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); await append(workspace, ledgerPath, 'a1', 'task', { title: 'first' }); await append(workspace, ledgerPath, 'a2', 'note', { title: 'second' });
  const got = (await runLedger(workspace, ledgerPath, ['get', '--id', 'a1'])).json;
  invariant(got.id === 'a1' && got.kind === 'task' && got.payload.title === 'first' && got.sequence === 1, 'append/get contract failed');
  await runLedger(workspace, ledgerPath, ['append', '--id', 'a1', '--kind', 'task', '--payload', '{}'], { expectFailure: true });
}
async function stageBatch(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); await append(workspace, ledgerPath, 'a1');
  const file = path.join(workspace, 'batch.json'); await writeFile(file, JSON.stringify([{ id: 'b1', kind: 'task', payload: { n: 1 } }, { id: 'b2', kind: 'note', payload: { n: 2 } }, { id: 'b3', kind: 'task', payload: { n: 3 }}]));
  await appendBatch(workspace, ledgerPath, file, 'k1'); await appendBatch(workspace, ledgerPath, file, 'k1');
  invariant((await query(workspace, ledgerPath, 'task', 0, 20)).length === 3, 'batch idempotency duplicated events');
  const bad = path.join(workspace, 'bad-batch.json'); await writeFile(bad, JSON.stringify([{ id: 'b4', kind: 'task', payload: {} }, { id: 'b1', kind: 'task', payload: {} }]));
  await appendBatch(workspace, ledgerPath, bad, 'k2', { expectFailure: true });
  invariant((await query(workspace, ledgerPath, 'task', 0, 20)).length === 3, 'failed batch mutated state');
}
async function stagePagination(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); await seedSmall(workspace, ledgerPath);
  const first = rows(await query(workspace, ledgerPath, 'task', 0, 2)); const second = rows(await query(workspace, ledgerPath, 'task', first.at(-1).sequence, 2));
  invariant(first.map((x) => x.id).join(',') === 'a1,b1' && second.map((x) => x.id).join(',') === 'b3', 'pagination boundary or order failed');
}
async function stageMigration(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); const file = path.join(workspace, 'legacy.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 'agentbattler.ledger.v1', events: [{ id: 'old-1', kind: 'task', payload: { old: true }, sequence: 10 }, { id: 'old-2', kind: 'note', payload: { old: true }, sequence: 11 }] }));
  await runLedger(workspace, ledgerPath, ['import', file]); const result = rows(await query(workspace, ledgerPath, 'task', 0, 10));
  invariant(result.length === 1 && result[0].id === 'old-1' && result[0].sequence === 1, 'legacy migration did not normalize sequences');
  await writeFile(file, JSON.stringify({ schemaVersion: 'unknown', events: [] })); await runLedger(workspace, ledgerPath, ['import', file], { expectFailure: true });
}
async function stageAtomic(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); await append(workspace, ledgerPath, 'a1'); await append(workspace, ledgerPath, 'a2');
  invariant(await exists(path.join(workspace, LEDGER_FILE)), 'primary state missing'); invariant(!await exists(path.join(workspace, `${LEDGER_FILE}.tmp`)), 'temporary state left after commit');
  await runLedger(workspace, ledgerPath, ['audit']);
}
async function stageRecovery(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); await append(workspace, ledgerPath, 'a1'); await append(workspace, ledgerPath, 'a2');
  const state = await readFile(path.join(workspace, LEDGER_FILE)); await writeFile(path.join(workspace, `${LEDGER_FILE}.tmp`), state); await rm(path.join(workspace, LEDGER_FILE)); await runLedger(workspace, ledgerPath, ['recover']);
  invariant((await runLedger(workspace, ledgerPath, ['get', '--id', 'a2'])).json.id === 'a2', 'valid temporary state was not recovered');
  const before = await readFile(path.join(workspace, LEDGER_FILE), 'utf8'); await writeFile(path.join(workspace, `${LEDGER_FILE}.tmp`), '{bad'); await runLedger(workspace, ledgerPath, ['recover'], { expectFailure: true }); invariant(await readFile(path.join(workspace, LEDGER_FILE), 'utf8') === before, 'malformed temporary state changed primary');
}
async function stageConcurrency(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); const jobs = Array.from({ length: 16 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ledgerPath, 'append', '--id', `con-${index}`, '--kind', 'task', '--payload', JSON.stringify({ index })], { cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, stdio: 'ignore' });
    child.on('error', reject); child.on('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`concurrent append failed: ${code ?? signal}`)));
  })); await Promise.all(jobs);
  const events = rows(await query(workspace, ledgerPath, 'task', 0, 100)); const ids = new Set(events.map((event) => event.id)); const sequences = new Set(events.map((event) => event.sequence));
  invariant(ids.size === 16 && sequences.size === 16 && events.every((event) => Number.isInteger(event.sequence)), 'concurrent appends lost updates or sequences');
}
async function stageCompaction(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath); const file = path.join(workspace, 'compact.json'); const events = Array.from({ length: 100 }, (_, index) => ({ id: `c-${index + 1}`, kind: index % 2 ? 'note' : 'task', payload: { index } })); await writeFile(file, JSON.stringify(events)); await appendBatch(workspace, ledgerPath, file, 'compact-100');
  await runLedger(workspace, ledgerPath, ['compact', '--keep', '3']); const state = JSON.parse(await readFile(path.join(workspace, LEDGER_FILE), 'utf8')); const snapshotFile = path.join(workspace, state.snapshotFile ?? 'ledger.snapshot.json');
  invariant(Array.isArray(state.events) && state.events.length <= 3 && await exists(snapshotFile), 'compaction did not create a bounded live tail and snapshot'); await runLedger(workspace, ledgerPath, ['replay']); invariant((await query(workspace, ledgerPath, 'task', 0, 100)).length === 50, 'compaction changed logical records');
}
async function stageRoundTrip(workspace, ledgerPath) {
  const exportPath = path.join(workspace, 'roundtrip.json'); await runLedger(workspace, ledgerPath, ['export', exportPath]); const fresh = path.join(workspace, 'fresh'); const freshLedger = path.join(fresh, 'ledger.mjs'); await rm(fresh, { recursive: true, force: true }); await mkdir(fresh, { recursive: true }); await copyFile(ledgerPath, freshLedger); await runLedger(fresh, freshLedger, ['import', exportPath]); invariant((await query(fresh, freshLedger, 'task', 0, 100)).length === (await query(workspace, ledgerPath, 'task', 0, 100)).length, 'round-trip lost logical records');
}
async function stageReplay(workspace, ledgerPath) { const replay = (await runLedger(workspace, ledgerPath, ['replay'])).json; invariant(replay.verified === true || replay.ok === true, 'replay did not verify'); const audit = (await runLedger(workspace, ledgerPath, ['audit'])).json; invariant(audit.ok === true || audit.passed === true || audit.verified === true, 'audit did not pass'); }
async function stageAudit(workspace, ledgerPath) { await stageReplay(workspace, ledgerPath); await runLedger(workspace, ledgerPath, ['append', '--id', 'bad', '--kind', 'task', '--payload', '{bad'], { expectFailure: true }); }
async function stageScale(workspace, ledgerPath) { await prepare(workspace, ledgerPath); const file = path.join(workspace, 'scale.json'); await writeFile(file, JSON.stringify(Array.from({ length: 2_000 }, (_, index) => ({ id: `s-${index + 1}`, kind: index % 2 ? 'note' : 'task', payload: { index } })))); await appendBatch(workspace, ledgerPath, file, 'scale-2000'); invariant((await query(workspace, ledgerPath, 'task', 0, 2_000)).length === 1_000, 'scale append/query lost records'); await runLedger(workspace, ledgerPath, ['compact', '--keep', '100']); await runLedger(workspace, ledgerPath, ['replay']); await runLedger(workspace, ledgerPath, ['audit']); }

export async function verifyPublicStage({ workspace, ledgerPath = path.join(workspace, 'ledger.mjs'), stageId }) {
  const handlers = { foundation: stageFoundation, batch: stageBatch, pagination: stagePagination, migration: stageMigration, atomicity: stageAtomic, recovery: stageRecovery, concurrency: stageConcurrency, compaction: stageCompaction, roundtrip: stageRoundTrip, replay: stageReplay, audit: stageAudit, scale: stageScale };
  invariant(handlers[stageId], `Unknown public stage: ${stageId}`); const started = Date.now();
  try { await handlers[stageId](workspace, ledgerPath); return { id: stageId, passed: true, regressions: 0, exitCode: 0, durationMs: Date.now() - started, diagnostic: null }; }
  catch (error) { return { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: Date.now() - started, diagnostic: String(error.message).slice(0, 500) }; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceIndex = process.argv.indexOf('--workspace'); const stageIndex = process.argv.indexOf('--stage');
  try { invariant(workspaceIndex > 0 && stageIndex > 0, 'Usage: public-verifier.mjs --workspace DIR --stage STAGE'); const result = await verifyPublicStage({ workspace: path.resolve(process.argv[workspaceIndex + 1]), stageId: process.argv[stageIndex + 1] }); process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.passed) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
