import { readFile } from 'node:fs/promises';

import { sha256 } from '../domain/canonical.mjs';
import { advanceState } from '../domain/fold.mjs';
import { normalizeEvent } from '../domain/event.mjs';
import { loadLogicalEvents, loadState, saveState } from '../storage/journal.mjs';

export async function appendBatch({ file, 'idempotency-key': key }) {
  const bytes = await readFile(file);
  const digest = sha256(bytes);
  const state = await loadState();
  if (state.batches[key]) {
    if (state.batches[key].digest !== digest) throw new Error('idempotency-key collision');
    return { ok: true, idempotent: true, count: state.batches[key].count };
  }
  const input = JSON.parse(bytes);
  if (!Array.isArray(input) || input.length === 0) throw new Error('batch must be a non-empty array');
  const logical = await loadLogicalEvents(state);
  const used = new Set(logical.map(({ id }) => id));
  const additions = input.map((event, index) => {
    const normalized = normalizeEvent(event, state.nextSequence + index);
    if (used.has(normalized.id)) throw new Error(`duplicate id: ${normalized.id}`);
    used.add(normalized.id);
    return normalized;
  });
  const batches = { ...state.batches, [key]: { digest, count: additions.length, eventIds: additions.map(({ id }) => id) } };
  await saveState(advanceState(state, { events: [...state.events, ...additions], batches, nextSequence: state.nextSequence + additions.length }));
  return { ok: true, idempotent: false, count: additions.length };
}
