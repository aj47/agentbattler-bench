import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  hashGoldAExecutableTree,
  materializeFreshGoldImplementationA,
  respondToGoldAPhase4,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import { verifyPhase } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';

const PACK = loadV7Pack('dev-01', { variant: 'decoy' });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function missing(file) {
  try { await access(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return false;
}

async function fixture(t, { variant = 'decoy' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-gold-a-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = loadV7Pack('dev-01', { variant });
  const manifest = await materializeFreshGoldImplementationA({ pack, destination: root });
  return { root, manifest, pack };
}

async function run(root, args, { expectFailure = false, timeoutMs = 30_000 } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ledger.mjs'), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  if (expectFailure) assert.notEqual(result.code, 0, `command unexpectedly succeeded: ${args.join(' ')}`);
  else assert.equal(result.code, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'command must emit exactly one JSON value');
  return { ...result, json: JSON.parse(lines[0]) };
}

test('gold A materializer installs a deterministic source-only overlay', async (t) => {
  const { root, manifest } = await fixture(t);
  assert.equal(manifest.implementationId, 'implementation-a');
  assert.deepEqual(manifest.files.map(({ path: relative }) => relative), ['bin/ledger.mjs', 'src/reference-ledger.mjs']);
  assert.equal(manifest.executableSourceSha256, await hashGoldAExecutableTree(root));
  assert.equal(manifest.executableSourceSha256, await hashV7ExecutableTree(root));
});

test('gold A migrates v1 transactionally and preserves import/export clients', async (t) => {
  const { root } = await fixture(t);
  const legacy = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8'));
  const last = legacy.events.at(-1);
  const got = await run(root, ['get', '--id', last.id]);
  assert.equal(got.json.sequence, legacy.events.length);
  const migrated = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8'));
  assert.equal(migrated.schemaVersion, 'agentbattler.ledger.v2');
  assert.equal(migrated.nextSequence, legacy.events.length + 1);

  const appended = await run(root, ['append', '--id', 'gold-a-extra', '--kind', 'task', '--payload', '{"nested":{"ok":true}}']);
  assert.equal(appended.json.sequence, legacy.events.length + 1);
  const exported = path.join(root, 'gold-a-export.json');
  await run(root, ['export', exported]);
  await run(root, ['import', exported]);
  assert.equal((await run(root, ['get', '--id', 'gold-a-extra'])).json.payload.nested.ok, true);

  const before = await readFile(path.join(root, 'ledger.json'));
  const bad = path.join(root, 'gold-a-bad.json');
  await writeFile(bad, `${JSON.stringify({ schemaVersion: 'agentbattler.ledger.v1', events: [legacy.events[0], legacy.events[0]] })}\n`);
  await run(root, ['import', bad], { expectFailure: true });
  assert.deepEqual(await readFile(path.join(root, 'ledger.json')), before);
  await run(root, ['query', '--kind', 'task', '--after-sequence', '00', '--limit', '2'], { expectFailure: true });
  assert.deepEqual(await readFile(path.join(root, 'ledger.json')), before);
});

test('gold A batches are byte-idempotent and cursors bind kind, lineage, and a stable boundary', async (t) => {
  const { root } = await fixture(t);
  await run(root, ['get', '--id', JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8')).events[0].id]);
  const batch = Array.from({ length: 10 }, (_, index) => ({ id: `gold-a-batch-${index}`, kind: index % 3 === 0 ? 'note' : 'task', payload: { index } }));
  const batchFile = path.join(root, 'gold-a-batch.json');
  await writeFile(batchFile, `${JSON.stringify(batch)}\n`);
  const firstApply = await run(root, ['append-batch', '--file', batchFile, '--idempotency-key', 'gold-a-key']);
  assert.equal(firstApply.json.idempotent, false);
  const committed = await readFile(path.join(root, 'ledger.json'));
  const retry = await run(root, ['append-batch', '--file', batchFile, '--idempotency-key', 'gold-a-key']);
  assert.equal(retry.json.idempotent, true);
  assert.deepEqual(await readFile(path.join(root, 'ledger.json')), committed);

  const first = await run(root, ['query', '--kind', 'task', '--limit', '2']);
  assert.equal(first.json.items.length, 2);
  assert.match(first.json.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const lastCharacter = first.json.nextCursor.at(-1);
  const tampered = `${first.json.nextCursor.slice(0, -1)}${lastCharacter === 'A' ? 'B' : 'A'}`;
  await run(root, ['query', '--kind', 'task', '--cursor', tampered, '--limit', '2'], { expectFailure: true });
  await run(root, ['query', '--kind', 'note', '--cursor', first.json.nextCursor, '--limit', '2'], { expectFailure: true });

  await run(root, ['append', '--id', 'gold-a-after-boundary', '--kind', 'task', '--payload', '{}']);
  const paged = [...first.json.items];
  let cursor = first.json.nextCursor;
  while (cursor) {
    const page = await run(root, ['query', '--kind', 'task', '--cursor', cursor, '--limit', '2']);
    paged.push(...page.json.items);
    cursor = page.json.nextCursor;
  }
  assert.equal(new Set(paged.map(({ id }) => id)).size, paged.length);
  assert(!paged.some(({ id }) => id === 'gold-a-after-boundary'), 'a continuation leaked an event beyond its committed boundary');
});

test('gold A serializes native writers and compacts through immutable checksummed snapshots', async (t) => {
  const { root } = await fixture(t);
  const initialCount = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8')).events.length;
  const writers = Array.from({ length: 16 }, (_, index) => run(root, [
    'append', '--id', `gold-a-concurrent-${index}`, '--kind', index % 2 ? 'note' : 'task', '--payload', JSON.stringify({ index }),
  ]));
  await Promise.all(writers);
  const replayBefore = await run(root, ['replay']);
  assert.equal(replayBefore.json.eventCount, initialCount + writers.length);
  await run(root, ['compact', '--keep', '3']);
  const state = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8'));
  assert.match(state.snapshotFile, /^ledger\.snapshot\.[0-9a-f]{24}\.json$/);
  assert.equal(state.events.length, 3);
  const snapshotBytes = await readFile(path.join(root, state.snapshotFile));
  assert.equal(sha256(snapshotBytes), state.snapshotSha256);
  assert.equal((await run(root, ['audit'])).json.eventCount, replayBefore.json.eventCount);
  assert.equal((await run(root, ['replay'])).json.headSha256, replayBefore.json.headSha256);
});

test('gold A process termination recovers exactly the prior or next batch revision', async (t) => {
  const { root } = await fixture(t);
  const seedId = JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8')).events[0].id;
  await run(root, ['get', '--id', seedId]);
  const priorCount = (await run(root, ['replay'])).json.eventCount;
  const batch = Array.from({ length: 12_000 }, (_, index) => ({ id: `gold-a-killed-${index}`, kind: index % 2 ? 'note' : 'task', payload: { index, marker: `m-${index}` } }));
  const batchFile = path.join(root, 'gold-a-killed-batch.json');
  await writeFile(batchFile, `${JSON.stringify(batch)}\n`);

  const child = spawn(process.execPath, [
    path.join(root, 'bin', 'ledger.mjs'),
    'append-batch', '--file', batchFile, '--idempotency-key', 'gold-a-killed-key',
  ], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const observedLock = await waitFor(async () => !await missing(path.join(root, 'ledger.lock')) || child.exitCode !== null);
  assert.equal(observedLock, true, 'writer neither acquired its lock nor exited');
  if (child.exitCode === null) child.kill('SIGKILL');
  await closed;

  await run(root, ['recover']);
  const recoveredCount = (await run(root, ['replay'])).json.eventCount;
  assert([priorCount, priorCount + batch.length].includes(recoveredCount), `recovered hybrid event count: ${recoveredCount}`);
  assert(await missing(path.join(root, 'ledger.lock')));
  assert(await missing(path.join(root, 'ledger.json.tmp')));
  assert.equal((await run(root, ['audit'])).json.eventCount, recoveredCount);
});

test('gold A recovery promotes a valid descendant, rejects forks, and detects snapshot corruption', async (t) => {
  const { root } = await fixture(t);
  await run(root, ['get', '--id', JSON.parse(await readFile(path.join(root, 'ledger.json'), 'utf8')).events[0].id]);
  const primaryPath = path.join(root, 'ledger.json');
  const temporaryPath = path.join(root, 'ledger.json.tmp');
  const primary = JSON.parse(await readFile(primaryPath, 'utf8'));
  const extra = { id: 'gold-a-recovered', kind: 'task', payload: { recovered: true }, sequence: primary.nextSequence };
  const descendant = {
    ...primary,
    generation: primary.generation + 1,
    parentStateSha256: sha256(canonicalJson(primary)),
    events: [...primary.events, extra],
    nextSequence: primary.nextSequence + 1,
  };
  await writeFile(temporaryPath, `${JSON.stringify(descendant)}\n`);
  await writeFile(primaryPath, '{corrupt');
  assert.equal((await run(root, ['recover'])).json.recoveredFrom, 'temporary');
  assert.equal((await run(root, ['get', '--id', extra.id])).json.payload.recovered, true);
  assert(await missing(temporaryPath));
  assert(await missing(path.join(root, 'ledger.lock')));

  const backupPath = path.join(root, 'gold-a-backup.json');
  await run(root, ['export', backupPath]);
  await writeFile(primaryPath, '{corrupt-again');
  assert.equal((await run(root, ['recover'])).json.recoveredFrom, 'export');
  assert.equal((await run(root, ['get', '--id', extra.id])).json.payload.recovered, true);

  const validPrimaryBytes = await readFile(primaryPath);
  const validPrimary = JSON.parse(validPrimaryBytes);
  const fork = {
    ...validPrimary,
    generation: validPrimary.generation + 1,
    lineageRootSha256: 'f'.repeat(64),
    parentStateSha256: 'e'.repeat(64),
  };
  await writeFile(temporaryPath, `${JSON.stringify(fork)}\n`);
  await run(root, ['recover'], { expectFailure: true });
  assert.deepEqual(await readFile(primaryPath), validPrimaryBytes);
  await rm(temporaryPath, { force: true });

  await run(root, ['compact', '--keep', '1']);
  const compacted = JSON.parse(await readFile(primaryPath, 'utf8'));
  const snapshotPath = path.join(root, compacted.snapshotFile);
  const cleanSnapshot = await readFile(snapshotPath);
  await writeFile(snapshotPath, Buffer.concat([cleanSnapshot, Buffer.from('corrupt')]));
  await run(root, ['audit'], { expectFailure: true });
  assert.deepEqual((await readFile(snapshotPath)).subarray(0, cleanSnapshot.length), cleanSnapshot);
});

test('gold A phase-4 responder changes only the declared response artifact', async (t) => {
  const { root } = await fixture(t);
  const control = path.join(root, '.agentbattler', 'current');
  const installed = await installV7Phase({ pack: PACK, phase: 4, destination: control });
  const before = await hashGoldAExecutableTree(root);
  const bound = bindV7PhaseEntryContract(installed.contract, before);
  await writeFile(path.join(control, 'task-contract.json'), `${JSON.stringify(bound, null, 2)}\n`);
  const result = await respondToGoldAPhase4({ workspace: root });
  assert.equal(result.response.conclusion, 'no-canonical-data-loss');
  assert.equal(result.response.executableSourceSha256, before);
  assert.deepEqual(result.response.evidenceIds, [...result.response.evidenceIds].sort());
  assert.equal(await hashGoldAExecutableTree(root), before);
  assert.equal(await hashV7ExecutableTree(root), before);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'incident-response.json'), 'utf8')), result.response);
  const verification = await verifyPhase({ pack: PACK, phase: 4, workspace: root, candidateTree: root, contract: bound });
  assert.equal(verification.passed, true, JSON.stringify(verification.requirements));
  assert.equal(verification.score, verification.maxScore);

  const clean = await fixture(t, { variant: 'clean' });
  const cleanControl = path.join(clean.root, '.agentbattler', 'current');
  const cleanInstalled = await installV7Phase({ pack: clean.pack, phase: 4, destination: cleanControl });
  const cleanHash = await hashGoldAExecutableTree(clean.root);
  const cleanContract = bindV7PhaseEntryContract(cleanInstalled.contract, cleanHash);
  await writeFile(path.join(cleanControl, 'task-contract.json'), `${JSON.stringify(cleanContract, null, 2)}\n`);
  const cleanResponse = await respondToGoldAPhase4({ workspace: clean.root });
  assert.equal(cleanResponse.response.conclusion, 'no-canonical-data-loss');
  assert.equal(await hashGoldAExecutableTree(clean.root), cleanHash);
});

test('gold A verifier coverage never awards durability without Linux strace', async (t) => {
  const { root } = await fixture(t);
  // Normalize Darwin's /var -> /private/var alias to match the sealed
  // candidate-process boundary during this host-only reference check.
  const priorTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = await realpath(os.tmpdir());
  try {
    const hasStrace = process.platform === 'linux' && spawnSync('strace', ['--version'], { stdio: 'ignore' }).status === 0;
    const traceDirectory = path.join(root, 'verifier-owned-traces');
    await mkdir(traceDirectory);
    for (const phase of [1, 2, 5]) {
      const result = await verifyPhase({ pack: PACK, phase, workspace: root, durabilityTraceDirectory: traceDirectory });
      assert.equal(result.passed, true, `phase ${phase}: ${JSON.stringify(result.checks)}`);
      assert.equal(result.score, result.maxScore);
    }
    const durability = await verifyPhase({ pack: PACK, phase: 3, workspace: root, durabilityTraceDirectory: traceDirectory });
    assert.equal(durability.requirements[0].passed, true, JSON.stringify(durability.requirements));
    assert.equal(durability.requirements[1].passed, true, JSON.stringify(durability.requirements));
    if (hasStrace) {
      assert.equal(durability.requirements[2].passed, true, JSON.stringify(durability.requirements));
      assert.equal(durability.score, durability.maxScore);
      assert.deepEqual(durability.infrastructureErrors, []);
    } else {
      assert.equal(durability.requirements[2].passed, false);
      assert.match(durability.requirements[2].diagnostic, /strace is unavailable/);
      assert(durability.infrastructureErrors.some(({ requirementId }) => requirementId === 'V7-P3-PRIVATE-TERMINATION'));
      assert(durability.score < durability.maxScore, 'durability was credited without syscall evidence');
    }
  } finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
});
