#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const LEDGER_FILE = 'ledger.json';
const SCHEMA = 'agentbattler.ledger.v1';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function runLedger(workspace, ledgerPath, args, { expectFailure = false } = {}) {
  const stdout = [];
  const stderr = [];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ledgerPath, ...args], {
      cwd: workspace,
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const output = Buffer.concat(stdout).toString('utf8').trim();
  const error = Buffer.concat(stderr).toString('utf8').trim();
  if (expectFailure) {
    invariant(result.exitCode !== 0 || result.signal, `Expected failure for ${args[0]}`);
    return { ...result, output, error, json: null };
  }
  invariant(result.exitCode === 0 && !result.signal, `${args[0]} failed: ${error || output}`);
  let json;
  try { json = JSON.parse(output); } catch (cause) { throw new Error(`${args[0]} did not emit one JSON object: ${cause.message}`); }
  return { ...result, output, error, json };
}

async function readState(workspace) {
  const file = path.join(workspace, LEDGER_FILE);
  const state = JSON.parse(await readFile(file, 'utf8'));
  invariant(state.schemaVersion === SCHEMA && Array.isArray(state.events), 'Invalid ledger state');
  return state;
}

async function append(workspace, ledgerPath, id, kind, payload) {
  return runLedger(workspace, ledgerPath, ['append', '--id', id, '--kind', kind, '--payload', JSON.stringify(payload)]);
}

async function prepare(workspace, ledgerPath) {
  await mkdir(workspace, { recursive: true });
  invariant(await exists(ledgerPath), `Missing candidate ledger: ${ledgerPath}`);
  await rm(path.join(workspace, LEDGER_FILE), { force: true });
  await rm(path.join(workspace, `${LEDGER_FILE}.tmp`), { force: true });
}

async function stageAppendGet(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath);
  await append(workspace, ledgerPath, 'a1', 'task', { title: 'first' });
  await append(workspace, ledgerPath, 'a2', 'note', { title: 'second' });
  const result = await runLedger(workspace, ledgerPath, ['get', '--id', 'a1']);
  invariant(result.json.id === 'a1' && result.json.kind === 'task' && result.json.payload.title === 'first', 'get returned the wrong record');
}

async function stageQuery(workspace, ledgerPath) {
  await append(workspace, ledgerPath, 'b1', 'task', { title: 'third' });
  const result = await runLedger(workspace, ledgerPath, ['query', '--kind', 'task', '--limit', '10']);
  invariant(Array.isArray(result.json), 'query must return an array');
  invariant(result.json.map((item) => item.id).join(',') === 'a1,b1', 'query order or filtering is not deterministic');
}

async function stageExport(workspace, ledgerPath) {
  const exportPath = path.join(workspace, 'ledger-export.json');
  await rm(exportPath, { force: true });
  const result = await runLedger(workspace, ledgerPath, ['export', exportPath]);
  invariant(result.json.exported === 3, 'export count is incorrect');
  const state = JSON.parse(await readFile(exportPath, 'utf8'));
  invariant(state.schemaVersion === SCHEMA && state.events.length === 3, 'export is not a complete ledger');
}

async function stageImport(workspace, ledgerPath) {
  const exportPath = path.join(workspace, 'ledger-export.json');
  const fresh = path.join(workspace, 'fresh-import');
  const freshLedger = path.join(fresh, 'ledger.mjs');
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh, { recursive: true });
  await copyFile(ledgerPath, freshLedger);
  const result = await runLedger(fresh, freshLedger, ['import', exportPath]);
  invariant(result.json.imported === 3, 'import count is incorrect');
  const imported = await runLedger(fresh, freshLedger, ['query', '--kind', 'task', '--limit', '10']);
  invariant(imported.json.map((item) => item.id).join(',') === 'a1,b1', 'import did not preserve the export');
}

async function stageRecovery(workspace, ledgerPath) {
  const statePath = path.join(workspace, LEDGER_FILE);
  const state = await readFile(statePath);
  await writeFile(`${statePath}.tmp`, state);
  await rm(statePath);
  const result = await runLedger(workspace, ledgerPath, ['recover']);
  invariant(result.json.recovered === 3, 'recover count is incorrect');
  invariant((await stat(statePath)).isFile(), 'recover did not atomically restore ledger.json');
}

async function stageCompatibility(workspace, ledgerPath) {
  const statePath = path.join(workspace, LEDGER_FILE);
  const before = await readFile(statePath, 'utf8');
  await runLedger(workspace, ledgerPath, ['append', '--id', 'broken', '--kind', 'task', '--payload', '{bad'], { expectFailure: true });
  invariant(await readFile(statePath, 'utf8') === before, 'malformed append changed the ledger');
  const compatiblePath = path.join(workspace, 'compatible.json');
  await writeFile(compatiblePath, JSON.stringify({ schemaVersion: SCHEMA, events: [{ id: 'compat', kind: 'note', payload: { ok: true }, sequence: 99 }] }));
  await runLedger(workspace, ledgerPath, ['import', compatiblePath]);
  const compatible = await runLedger(workspace, ledgerPath, ['get', '--id', 'compat']);
  invariant(compatible.json.id === 'compat', 'v1-compatible import failed');
}

async function stageAudit(workspace, ledgerPath) {
  const result = await runLedger(workspace, ledgerPath, ['query', '--kind', 'note', '--limit', '10']);
  invariant(result.json.length === 1 && result.json[0].id === 'compat', 'audit found a regression');
}

async function stagePerformance(workspace, ledgerPath) {
  await prepare(workspace, ledgerPath);
  for (let index = 1; index <= 24; index += 1) await append(workspace, ledgerPath, `perf-${String(index).padStart(2, '0')}`, index % 2 ? 'task' : 'note', { index });
  const result = await runLedger(workspace, ledgerPath, ['query', '--limit', '24']);
  invariant(result.json.length === 24, `performance query returned ${result.json.length} records`);
}

export async function verifyPublicStage({ workspace, ledgerPath = path.join(workspace, 'ledger.mjs'), stageId }) {
  const handlers = { 'append-get': stageAppendGet, query: stageQuery, export: stageExport, import: stageImport, recovery: stageRecovery, compatibility: stageCompatibility, audit: stageAudit, performance: stagePerformance };
  invariant(handlers[stageId], `Unknown public stage: ${stageId}`);
  const started = Date.now();
  try {
    await handlers[stageId](workspace, ledgerPath);
    return { stageId, passed: true, regressions: 0, exitCode: 0, durationMs: Date.now() - started, diagnostic: null };
  } catch (error) {
    return { stageId, passed: false, regressions: 1, exitCode: 1, durationMs: Date.now() - started, diagnostic: String(error.message).slice(0, 500) };
  }
}

async function cli() {
  const workspaceIndex = process.argv.indexOf('--workspace');
  const stageIndex = process.argv.indexOf('--stage');
  invariant(workspaceIndex > 0 && stageIndex > 0, 'Usage: public-verifier.mjs --workspace DIR --stage STAGE');
  const workspace = path.resolve(process.argv[workspaceIndex + 1]);
  const result = await verifyPublicStage({ workspace, stageId: process.argv[stageIndex + 1] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
