import { canonicalJson, sha256 } from './canonical.mjs';
import { V1_SCHEMA, V2_SCHEMA, normalizeEvent } from './event.mjs';

export function stateDigest(state) {
  return sha256(canonicalJson(state));
}

export function normalizeState(value, { allowLegacy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ledger state is not an object');
  if (value.schemaVersion === V1_SCHEMA) {
    if (!allowLegacy) throw new Error('legacy migration is not implemented');
    if (!Array.isArray(value.events)) throw new Error('legacy events must be an array');
    const events = value.events.map((event, index) => normalizeEvent(event, index + 1));
    assertUniqueIds(events);
    const root = sha256(canonicalJson(events));
    return {
      schemaVersion: V2_SCHEMA,
      generation: 0,
      lineageRootSha256: root,
      parentStateSha256: null,
      snapshotFile: null,
      snapshotSha256: null,
      events,
      batches: {},
      nextSequence: events.length + 1,
    };
  }
  if (value.schemaVersion !== V2_SCHEMA) throw new Error(`unsupported schema: ${value.schemaVersion ?? '<missing>'}`);
  if (!Array.isArray(value.events)) throw new Error('events must be an array');
  const start = Number.isInteger(value.snapshotThroughSequence) ? value.snapshotThroughSequence + 1 : 1;
  const events = value.events.map((event, index) => normalizeEvent(event, start + index));
  assertUniqueIds(events);
  if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence !== start + events.length) throw new Error('nextSequence is inconsistent');
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('generation is invalid');
  if (typeof value.lineageRootSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.lineageRootSha256)) throw new Error('lineage root is invalid');
  if (value.parentStateSha256 !== null && (typeof value.parentStateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.parentStateSha256))) throw new Error('parent state hash is invalid');
  if (!value.batches || typeof value.batches !== 'object' || Array.isArray(value.batches)) throw new Error('batch receipts are invalid');
  return { ...value, events, batches: { ...value.batches } };
}

export function assertUniqueIds(events) {
  if (new Set(events.map(({ id }) => id)).size !== events.length) throw new Error('duplicate event id');
}

export function advanceState(previous, changes) {
  return normalizeState({
    ...previous,
    ...changes,
    schemaVersion: V2_SCHEMA,
    generation: previous.generation + 1,
    lineageRootSha256: previous.lineageRootSha256,
    parentStateSha256: stateDigest(previous),
  });
}
