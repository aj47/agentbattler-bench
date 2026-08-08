import path from 'node:path';

import { canonicalJson, isSha256, sha256 } from './canonical.mjs';

export const V1_SCHEMA = 'agentbattler.ledger.v1';
export const V2_SCHEMA = 'agentbattler.ledger.v2';
export const SNAPSHOT_SCHEMA = 'agentbattler.ledger.snapshot.v1';

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function normalizeEvent(value, sequence) {
  plainObject(value, `event ${sequence}`);
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error(`event ${sequence} has an invalid id`);
  if (typeof value.kind !== 'string' || value.kind.length === 0) throw new Error(`event ${sequence} has an invalid kind`);
  if (!Object.hasOwn(value, 'payload') || value.payload === undefined) throw new Error(`event ${sequence} has no payload`);
  canonicalJson(value.payload);
  return { id: value.id, kind: value.kind, payload: value.payload, sequence };
}

function validateSequencedEvent(value, sequence) {
  const normalized = normalizeEvent(value, sequence);
  if (!Number.isSafeInteger(value.sequence) || value.sequence !== sequence) throw new Error(`event ${sequence} has a non-canonical sequence`);
  return normalized;
}

export function parsePayload(text) {
  try {
    const value = JSON.parse(text);
    if (value === undefined) throw new Error('undefined is not JSON');
    return value;
  } catch {
    throw new Error('payload must be valid JSON');
  }
}

export function assertUniqueIds(events) {
  if (new Set(events.map(({ id }) => id)).size !== events.length) throw new Error('duplicate event id');
}

function normalizeBatches(value) {
  plainObject(value, 'batch receipts');
  const entries = [];
  for (const [key, receipt] of Object.entries(value)) {
    if (key.length === 0) throw new Error('batch receipt has an empty key');
    plainObject(receipt, `batch receipt ${key}`);
    if (!isSha256(receipt.digest)) throw new Error(`batch receipt ${key} has an invalid digest`);
    if (!Number.isSafeInteger(receipt.count) || receipt.count < 1) throw new Error(`batch receipt ${key} has an invalid count`);
    if (!Array.isArray(receipt.eventIds) || receipt.eventIds.length !== receipt.count || receipt.eventIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error(`batch receipt ${key} has invalid event ids`);
    }
    if (new Set(receipt.eventIds).size !== receipt.eventIds.length) throw new Error(`batch receipt ${key} repeats an event id`);
    entries.push([key, { digest: receipt.digest, count: receipt.count, eventIds: [...receipt.eventIds] }]);
  }
  return Object.fromEntries(entries);
}

export function migrateLegacy(value) {
  plainObject(value, 'ledger state');
  if (value.schemaVersion !== V1_SCHEMA) throw new Error(`unsupported schema: ${value.schemaVersion ?? '<missing>'}`);
  if (!Array.isArray(value.events)) throw new Error('legacy events must be an array');
  const events = value.events.map((event, index) => normalizeEvent(event, index + 1));
  assertUniqueIds(events);
  return {
    schemaVersion: V2_SCHEMA,
    generation: 0,
    lineageRootSha256: sha256(canonicalJson(events)),
    parentStateSha256: null,
    snapshotFile: null,
    snapshotSha256: null,
    events,
    batches: {},
    nextSequence: events.length + 1,
  };
}

function validateSnapshotReference(value) {
  if (value.snapshotFile === null || value.snapshotFile === undefined) {
    if (value.snapshotSha256 !== null && value.snapshotSha256 !== undefined) throw new Error('snapshot checksum exists without a snapshot');
    if (value.snapshotThroughSequence !== undefined && value.snapshotThroughSequence !== null && value.snapshotThroughSequence !== 0) {
      throw new Error('snapshot boundary exists without a snapshot');
    }
    return 0;
  }
  if (typeof value.snapshotFile !== 'string' || value.snapshotFile.length === 0 || path.basename(value.snapshotFile) !== value.snapshotFile) {
    throw new Error('snapshot file is invalid');
  }
  if (!/^ledger\.snapshot\.[0-9a-f]{64}\.json$/.test(value.snapshotFile) && value.snapshotFile !== 'ledger.snapshot.json') {
    throw new Error('snapshot file is outside the supported namespace');
  }
  if (!isSha256(value.snapshotSha256)) throw new Error('snapshot checksum is invalid');
  if (!Number.isSafeInteger(value.snapshotThroughSequence) || value.snapshotThroughSequence < 0) throw new Error('snapshot boundary is invalid');
  return value.snapshotThroughSequence;
}

export function normalizeState(value, { allowLegacy = false } = {}) {
  plainObject(value, 'ledger state');
  if (value.schemaVersion === V1_SCHEMA) {
    if (!allowLegacy) throw new Error('legacy state requires migration');
    return migrateLegacy(value);
  }
  if (value.schemaVersion !== V2_SCHEMA) throw new Error(`unsupported schema: ${value.schemaVersion ?? '<missing>'}`);
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('generation is invalid');
  if (!isSha256(value.lineageRootSha256)) throw new Error('lineage root is invalid');
  if (value.parentStateSha256 !== null && !isSha256(value.parentStateSha256)) throw new Error('parent state hash is invalid');
  const snapshotThrough = validateSnapshotReference(value);
  if (!Array.isArray(value.events)) throw new Error('events must be an array');
  const events = value.events.map((event, index) => validateSequencedEvent(event, snapshotThrough + index + 1));
  assertUniqueIds(events);
  if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence !== snapshotThrough + events.length + 1) {
    throw new Error('nextSequence is inconsistent');
  }
  const batches = normalizeBatches(value.batches);
  return { ...value, events, batches };
}

export function normalizeSnapshot(value) {
  plainObject(value, 'snapshot');
  if (value.schemaVersion !== SNAPSHOT_SCHEMA) throw new Error('snapshot schema is invalid');
  if (!Array.isArray(value.events)) throw new Error('snapshot events must be an array');
  const events = value.events.map((event, index) => validateSequencedEvent(event, index + 1));
  assertUniqueIds(events);
  if (!Number.isSafeInteger(value.throughSequence) || value.throughSequence !== events.length) throw new Error('snapshot boundary is invalid');
  return { schemaVersion: SNAPSHOT_SCHEMA, throughSequence: events.length, events };
}

export function assertLogicalState(state, snapshotEvents = []) {
  const events = [...snapshotEvents, ...state.events];
  assertUniqueIds(events);
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) throw new Error('logical event sequences are not contiguous');
  });
  if (state.nextSequence !== events.length + 1) throw new Error('logical nextSequence is inconsistent');
  const ids = new Set(events.map(({ id }) => id));
  for (const [key, receipt] of Object.entries(state.batches)) {
    if (!receipt.eventIds.every((id) => ids.has(id))) throw new Error(`batch receipt ${key} references an unknown event`);
  }
  return events;
}

export function stateDigest(state) {
  return sha256(canonicalJson(state));
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

export function standaloneState(state, events) {
  return normalizeState({
    schemaVersion: V2_SCHEMA,
    generation: state.generation,
    lineageRootSha256: state.lineageRootSha256,
    parentStateSha256: state.parentStateSha256,
    snapshotFile: null,
    snapshotSha256: null,
    events,
    batches: state.batches,
    nextSequence: events.length + 1,
  });
}
