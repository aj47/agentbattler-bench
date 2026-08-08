import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256 } from '../domain/canonical.mjs';
import { assertUniqueIds, normalizeState } from '../domain/fold.mjs';
import { normalizeEvent } from '../domain/event.mjs';
import { atomicWrite } from './atomic-write.mjs';
import { ROOT, SNAPSHOT, STATE } from './paths.mjs';

export async function loadState({ allowLegacy = false, file = STATE } = {}) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  return normalizeState(value, { allowLegacy });
}

export async function saveState(state) {
  await atomicWrite(STATE, `${JSON.stringify(normalizeState(state))}\n`);
}

export async function loadSnapshot(state) {
  if (!state.snapshotFile) return [];
  const file = path.resolve(ROOT, state.snapshotFile);
  if (!file.startsWith(`${ROOT}${path.sep}`)) throw new Error('snapshot path escapes workspace');
  const bytes = await readFile(file, 'utf8');
  if (sha256(bytes) !== state.snapshotSha256) throw new Error('snapshot checksum mismatch');
  const snapshot = JSON.parse(bytes);
  if (snapshot.schemaVersion !== 'agentbattler.ledger.snapshot.v1' || !Array.isArray(snapshot.events)) throw new Error('snapshot schema is invalid');
  const events = snapshot.events.map((event, index) => normalizeEvent(event, index + 1));
  assertUniqueIds(events);
  if (snapshot.throughSequence !== events.length || state.snapshotThroughSequence !== events.length) throw new Error('snapshot boundary is invalid');
  return events;
}

export async function loadLogicalEvents(state) {
  const events = [...await loadSnapshot(state), ...state.events];
  assertUniqueIds(events);
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) throw new Error('logical event sequences are not contiguous');
  }
  if (state.nextSequence !== events.length + 1) throw new Error('logical nextSequence is inconsistent');
  return events;
}

export async function writeSnapshot(events) {
  const document = { schemaVersion: 'agentbattler.ledger.snapshot.v1', throughSequence: events.length, events };
  const bytes = `${JSON.stringify(document)}\n`;
  await atomicWrite(SNAPSHOT, bytes);
  return { snapshotFile: path.basename(SNAPSHOT), snapshotSha256: sha256(bytes), snapshotThroughSequence: events.length };
}

export function exportedState(state, events) {
  return {
    schemaVersion: state.schemaVersion,
    generation: state.generation,
    lineageRootSha256: state.lineageRootSha256,
    parentStateSha256: state.parentStateSha256,
    snapshotFile: null,
    snapshotSha256: null,
    events,
    batches: state.batches,
    nextSequence: events.length + 1,
  };
}

export function logicalHeadSha256(events) {
  return sha256(canonicalJson(events));
}
