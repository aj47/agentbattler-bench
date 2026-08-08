import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256 } from './canonical.mjs';
import {
  advanceState,
  assertLogicalState,
  normalizeEvent,
  normalizeState,
  parsePayload,
  standaloneState,
  stateDigest,
} from './model.mjs';
import {
  LOCK,
  PRIMARY,
  ROOT,
  durableAtomicWrite,
  loadLogicalEvents,
  loadState,
  persistState,
  recoverState,
  withLedgerLock,
  writeSnapshot,
} from './storage.mjs';

function positiveInteger(text, name) {
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a canonical positive integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

function nonNegativeInteger(text, name) {
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)$/.test(text)) throw new Error(`${name} must be a canonical non-negative integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

function cursorMac(payload) {
  return sha256(`agentbattler.ledger.cursor.v1\0${canonicalJson(payload)}`);
}

function encodeCursor(payload) {
  return Buffer.from(canonicalJson({ payload, mac: cursorMac(payload) })).toString('base64url');
}

function decodeCursor(token) {
  if (typeof token !== 'string' || token.length < 8 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid cursor');
  let value;
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error('non-canonical cursor');
    value = JSON.parse(bytes);
  } catch {
    throw new Error('invalid cursor');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.payload || value.mac !== cursorMac(value.payload)) {
    throw new Error('cursor authentication failed');
  }
  return value.payload;
}

function cursorPayload({ kind, after, through, lineage, head }) {
  return { v: 1, kind, after, through, lineage, head };
}

function validateCursor(payload, { kind, state, logical }) {
  if (payload.v !== 1 || payload.kind !== kind) throw new Error('cursor does not match query');
  if (!Number.isSafeInteger(payload.after) || payload.after < 0 || !Number.isSafeInteger(payload.through) || payload.through < payload.after) {
    throw new Error('cursor boundary is invalid');
  }
  if (payload.lineage !== state.lineageRootSha256) throw new Error('cursor lineage is stale');
  const boundary = logical.filter(({ sequence }) => sequence <= payload.through);
  if (boundary.length !== payload.through || sha256(canonicalJson(boundary)) !== payload.head) throw new Error('cursor history boundary changed');
  return payload;
}

export async function appendCommand({ id, kind, payload }) {
  const parsedPayload = parsePayload(payload);
  return withLedgerLock(async () => {
    const state = await loadState();
    const logical = await loadLogicalEvents(state);
    if (logical.some((event) => event.id === id)) throw new Error(`duplicate id: ${id}`);
    const event = normalizeEvent({ id, kind, payload: parsedPayload }, state.nextSequence);
    await persistState(advanceState(state, { events: [...state.events, event], nextSequence: state.nextSequence + 1 }));
    return event;
  });
}

export async function getCommand({ id }) {
  return withLedgerLock(async () => {
    const state = await loadState();
    const event = (await loadLogicalEvents(state)).find((candidate) => candidate.id === id);
    if (!event) throw new Error(`unknown id: ${id}`);
    return event;
  });
}

export async function queryCommand(flags) {
  const limit = positiveInteger(flags.limit, 'limit');
  const cursorMode = Object.hasOwn(flags, 'cursor') || !Object.hasOwn(flags, 'after-sequence');
  return withLedgerLock(async () => {
    const state = await loadState();
    const logical = await loadLogicalEvents(state);
    let after = 0;
    let through = logical.length;
    let head = sha256(canonicalJson(logical));
    if (Object.hasOwn(flags, 'cursor')) {
      const decoded = validateCursor(decodeCursor(flags.cursor), { kind: flags.kind, state, logical });
      ({ after, through, head } = decoded);
    } else if (Object.hasOwn(flags, 'after-sequence')) {
      after = nonNegativeInteger(flags['after-sequence'], 'after-sequence');
    }
    const matches = logical.filter((event) => event.kind === flags.kind && event.sequence > after && event.sequence <= through);
    const items = matches.slice(0, limit);
    if (!cursorMode) return items;
    const nextCursor = matches.length > items.length
      ? encodeCursor(cursorPayload({
        kind: flags.kind,
        after: items.at(-1).sequence,
        through,
        lineage: state.lineageRootSha256,
        head,
      }))
      : null;
    return { items, nextCursor };
  });
}

function parseBatch(bytes) {
  let value;
  try { value = JSON.parse(bytes); } catch { throw new Error('batch file must contain valid JSON'); }
  if (!Array.isArray(value) || value.length === 0) throw new Error('batch must be a non-empty array');
  return value;
}

export async function batchCommand({ file, key }) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('idempotency key is required');
  const bytes = await readFile(file);
  const input = parseBatch(bytes);
  const digest = sha256(bytes);
  return withLedgerLock(async () => {
    const state = await loadState();
    const receipt = Object.hasOwn(state.batches, key) ? state.batches[key] : null;
    if (receipt) {
      if (receipt.digest !== digest) throw new Error('idempotency-key collision');
      return { ok: true, idempotent: true, count: receipt.count };
    }
    const logical = await loadLogicalEvents(state);
    const used = new Set(logical.map(({ id }) => id));
    const additions = input.map((candidate, index) => {
      const event = normalizeEvent(candidate, state.nextSequence + index);
      if (used.has(event.id)) throw new Error(`duplicate id: ${event.id}`);
      used.add(event.id);
      return event;
    });
    const batches = {
      ...state.batches,
      [key]: { digest, count: additions.length, eventIds: additions.map(({ id }) => id) },
    };
    await persistState(advanceState(state, {
      events: [...state.events, ...additions],
      batches,
      nextSequence: state.nextSequence + additions.length,
    }));
    return { ok: true, idempotent: false, count: additions.length };
  });
}

function protectedExportPath(file) {
  const resolved = path.resolve(file);
  return resolved === PRIMARY || resolved === LOCK || resolved.startsWith(`${path.resolve(ROOT, '.agentbattler')}${path.sep}`);
}

export async function exportCommand(file) {
  if (protectedExportPath(file)) throw new Error('export destination is reserved');
  return withLedgerLock(async () => {
    const state = await loadState();
    const logical = await loadLogicalEvents(state);
    const exported = standaloneState(state, logical);
    await durableAtomicWrite(path.resolve(file), `${JSON.stringify(exported)}\n`);
    return { ok: true, eventCount: logical.length };
  });
}

export async function importCommand(file) {
  const bytes = await readFile(file);
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { throw new Error('import file must contain valid JSON'); }
  const imported = normalizeState(parsed, { allowLegacy: true });
  if (imported.snapshotFile) throw new Error('import must be a self-contained export');
  assertLogicalState(imported);
  return withLedgerLock(async () => {
    await persistState(imported);
    return { ok: true, eventCount: imported.events.length };
  });
}

export async function compactCommand({ keep }) {
  const count = positiveInteger(keep, 'keep');
  return withLedgerLock(async () => {
    const state = await loadState();
    const logical = await loadLogicalEvents(state);
    const split = Math.max(0, logical.length - count);
    let snapshot = { snapshotFile: null, snapshotSha256: null };
    if (split > 0) snapshot = await writeSnapshot(logical.slice(0, split));
    const next = advanceState(state, {
      ...snapshot,
      ...(split === 0 ? { snapshotThroughSequence: undefined } : {}),
      events: logical.slice(split),
      nextSequence: logical.length + 1,
    });
    if (next.snapshotThroughSequence === undefined) delete next.snapshotThroughSequence;
    await persistState(next);
    return { ok: true, kept: logical.length - split, snapshotted: split };
  });
}

function validateReceipts(state, logical) {
  const ids = new Set(logical.map(({ id }) => id));
  for (const [key, receipt] of Object.entries(state.batches)) {
    if (!/^[0-9a-f]{64}$/.test(receipt.digest)) throw new Error(`batch receipt ${key} digest is corrupt`);
    if (receipt.count !== receipt.eventIds.length || !receipt.eventIds.every((id) => ids.has(id))) {
      throw new Error(`batch receipt ${key} is inconsistent with replay`);
    }
  }
}

export async function replayCommand() {
  return withLedgerLock(async () => {
    const state = await loadState();
    const logical = await loadLogicalEvents(state);
    return {
      ok: true,
      verified: true,
      eventCount: logical.length,
      headSha256: sha256(canonicalJson(logical)),
      generation: state.generation,
      lineageRootSha256: state.lineageRootSha256,
      events: logical,
    };
  });
}

export async function auditCommand() {
  return withLedgerLock(async () => {
    const state = await loadState();
    const logical = await loadLogicalEvents(state);
    validateReceipts(state, logical);
    return {
      ok: true,
      verified: true,
      eventCount: logical.length,
      headSha256: sha256(canonicalJson(logical)),
      stateSha256: stateDigest(state),
      generation: state.generation,
      lineageRootSha256: state.lineageRootSha256,
      snapshotThroughSequence: state.snapshotThroughSequence ?? 0,
      batchReceiptCount: Object.keys(state.batches).length,
    };
  });
}

export async function recoverCommand() {
  return recoverState();
}
