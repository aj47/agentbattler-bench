import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from './canonical.mjs';
import {
  SNAPSHOT_SCHEMA,
  advanceState,
  assertLogicalState,
  normalizeSnapshot,
  normalizeState,
  stateDigest,
} from './model.mjs';

export const ROOT = process.cwd();
export const PRIMARY = path.join(ROOT, 'ledger.json');
export const LOCK = path.join(ROOT, 'ledger.lock');

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function regularFileBytes(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`artifact is not an independent regular file: ${path.basename(file)}`);
  if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`artifact is too large: ${path.basename(file)}`);
  return readFile(file);
}

export async function durableAtomicWrite(file, bytes) {
  const directoryName = path.dirname(file);
  await mkdir(directoryName, { recursive: true });
  const temporary = path.join(directoryName, `${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await rename(temporary, file);
  const directory = await open(directoryName, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readLock() {
  try {
    const bytes = await readFile(LOCK, 'utf8');
    return { bytes, value: JSON.parse(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { bytes: null, value: null };
  }
}

async function removeStaleLock(observed) {
  const current = await readLock();
  if (!current) return;
  if (observed.bytes !== current.bytes) return;
  if (current.value && processIsAlive(current.value.pid)) return;
  await rm(LOCK, { force: true });
}

async function acquireLock({ recover = false, timeoutMs = 30_000 } = {}) {
  const token = randomBytes(16).toString('hex');
  const record = `${JSON.stringify({ schema: 'agentbattler.ledger.lock.v1', pid: process.pid, token })}\n`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await open(LOCK, 'wx', 0o600);
      await handle.writeFile(record);
      await handle.sync();
      await handle.close();
      return { token, record };
    } catch (error) {
      await handle?.close();
      if (error.code !== 'EEXIST') throw error;
    }
    const observed = await readLock();
    if (!observed) continue;
    const stale = !observed.value || !processIsAlive(observed.value.pid);
    if (stale && (recover || observed.value)) {
      await removeStaleLock(observed);
      continue;
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for ledger lock');
    await delay(4 + (process.pid % 7));
  }
}

async function releaseLock(lease) {
  const current = await readLock();
  if (current?.value?.token === lease.token && current.value.pid === process.pid) await rm(LOCK, { force: true });
}

export async function withLedgerLock(operation, options) {
  const lease = await acquireLock(options);
  try {
    return await operation();
  } finally {
    await releaseLock(lease);
  }
}

async function parseStateFile(file, { allowLegacy = false } = {}) {
  const bytes = await regularFileBytes(file);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`invalid JSON state: ${path.basename(file)}`);
  }
  return { bytes, state: normalizeState(value, { allowLegacy }) };
}

export async function persistState(state) {
  const normalized = normalizeState(state);
  await durableAtomicWrite(PRIMARY, `${JSON.stringify(normalized)}\n`);
  return normalized;
}

export async function loadState({ migrate = true, persistMigration = true, file = PRIMARY } = {}) {
  const { state } = await parseStateFile(file, { allowLegacy: migrate });
  if (persistMigration && state.schemaVersion === 'agentbattler.ledger.v2') {
    const raw = JSON.parse(await regularFileBytes(file));
    if (raw.schemaVersion === 'agentbattler.ledger.v1') await persistState(state);
  }
  return state;
}

export async function loadSnapshot(state) {
  if (!state.snapshotFile) return [];
  const file = path.join(ROOT, state.snapshotFile);
  const bytes = await regularFileBytes(file);
  if (sha256(bytes) !== state.snapshotSha256) throw new Error('snapshot checksum mismatch');
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { throw new Error('snapshot JSON is invalid'); }
  const snapshot = normalizeSnapshot(parsed);
  if (snapshot.throughSequence !== state.snapshotThroughSequence) throw new Error('snapshot boundary differs from primary state');
  return snapshot.events;
}

export async function loadLogicalEvents(state) {
  return assertLogicalState(state, await loadSnapshot(state));
}

export async function writeSnapshot(events) {
  const document = { schemaVersion: SNAPSHOT_SCHEMA, throughSequence: events.length, events };
  const bytes = `${JSON.stringify(document)}\n`;
  const digest = sha256(bytes);
  const name = `ledger.snapshot.${digest}.json`;
  const target = path.join(ROOT, name);
  try {
    const existing = await regularFileBytes(target);
    if (sha256(existing) !== digest) throw new Error('existing snapshot has a checksum collision');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await durableAtomicWrite(target, bytes);
  }
  return { snapshotFile: name, snapshotSha256: digest, snapshotThroughSequence: events.length };
}

function isTemporaryStateName(name) {
  return name === 'ledger.json.tmp' || (name.startsWith('ledger.json.') && name.endsWith('.tmp'));
}

function isExportCandidateName(name) {
  return /^ledger(?:\.json)?\.export(?:\.[a-z0-9_-]+)?\.json$/i.test(name);
}

async function validateCompleteCandidate(file) {
  const { state } = await parseStateFile(file, { allowLegacy: true });
  await loadLogicalEvents(state);
  return { file, state, digest: stateDigest(state) };
}

function chooseRecoveryCandidate(candidates, primary) {
  if (candidates.length === 0) throw new Error('no valid recovery candidate');
  const byGeneration = new Map();
  for (const candidate of candidates) {
    const peers = byGeneration.get(candidate.state.generation) ?? [];
    peers.push(candidate);
    byGeneration.set(candidate.state.generation, peers);
  }
  for (const peers of byGeneration.values()) {
    if (new Set(peers.map(({ digest }) => digest)).size > 1) throw new Error('ambiguous equal-generation recovery candidates');
  }
  const unique = [...byGeneration.values()].map((peers) => peers[0]);
  if (primary) {
    for (const candidate of unique) {
      if (candidate.digest === primary.digest) continue;
      if (candidate.state.generation <= primary.state.generation) throw new Error('rollback recovery candidate rejected');
      if (candidate.state.lineageRootSha256 !== primary.state.lineageRootSha256) throw new Error('fork recovery candidate rejected');
    }
    const ordered = [...unique].sort((left, right) => left.state.generation - right.state.generation);
    let ancestor = primary;
    for (const candidate of ordered.filter(({ state, digest }) => state.generation > primary.state.generation && digest !== primary.digest)) {
      if (candidate.state.generation !== ancestor.state.generation + 1 || candidate.state.parentStateSha256 !== ancestor.digest) {
        throw new Error('recovery candidate is not a proven descendant');
      }
      ancestor = candidate;
    }
    return ancestor;
  }
  const lineages = new Set(unique.map(({ state }) => state.lineageRootSha256));
  if (lineages.size !== 1) throw new Error('recovery candidates belong to different lineages');
  const ordered = [...unique].sort((left, right) => left.state.generation - right.state.generation);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.state.generation !== previous.state.generation + 1 || current.state.parentStateSha256 !== previous.digest) {
      throw new Error('recovery candidate ancestry is incomplete or inconsistent');
    }
  }
  return ordered.at(-1);
}

export async function recoverState() {
  return withLedgerLock(async () => {
    const names = await readdir(ROOT);
    const files = [path.basename(PRIMARY), ...names.filter((name) => isTemporaryStateName(name) || isExportCandidateName(name))]
      .filter((name, index, values) => values.indexOf(name) === index)
      .map((name) => path.join(ROOT, name));
    const valid = [];
    let primary = null;
    for (const file of files) {
      try {
        const candidate = await validateCompleteCandidate(file);
        valid.push(candidate);
        if (file === PRIMARY) primary = candidate;
      } catch {
        // Partial or corrupt candidates do not become authoritative.
      }
    }
    const selected = chooseRecoveryCandidate(valid, primary);
    if (!primary || selected.digest !== primary.digest) await persistState(selected.state);
    for (const name of names.filter(isTemporaryStateName)) await rm(path.join(ROOT, name), { force: true });
    return {
      ok: true,
      generation: selected.state.generation,
      recoveredFrom: selected.file === PRIMARY ? 'primary' : path.basename(selected.file),
    };
  }, { recover: true });
}

export function nextState(previous, changes) {
  return advanceState(previous, changes);
}
