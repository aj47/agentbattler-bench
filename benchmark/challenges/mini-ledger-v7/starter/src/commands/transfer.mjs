import { readFile } from 'node:fs/promises';

import { normalizeState, advanceState } from '../domain/fold.mjs';
import { atomicWrite } from '../storage/atomic-write.mjs';
import { exportedState, loadLogicalEvents, loadState, saveState, writeSnapshot } from '../storage/journal.mjs';

export async function exportLedger(file) {
  const state = await loadState();
  const events = await loadLogicalEvents(state);
  await atomicWrite(file, `${JSON.stringify(exportedState(state, events))}\n`);
  return { ok: true, eventCount: events.length };
}

export async function importLedger(file) {
  const input = JSON.parse(await readFile(file, 'utf8'));
  // Known phase-1 defect: legacy input is rejected instead of migrated.
  const state = normalizeState(input, { allowLegacy: false });
  await saveState(state);
  return { ok: true, eventCount: state.events.length };
}

export async function compact({ keep }) {
  if (!/^[1-9]\d*$/.test(keep)) throw new Error('keep must be a positive integer');
  const count = Number(keep);
  if (!Number.isSafeInteger(count)) throw new Error('keep is too large');
  const state = await loadState();
  const logical = await loadLogicalEvents(state);
  const split = Math.max(0, logical.length - count);
  const snapshot = await writeSnapshot(logical.slice(0, split));
  await saveState(advanceState(state, { ...snapshot, events: logical.slice(split), nextSequence: logical.length + 1 }));
  return { ok: true, kept: logical.length - split, snapshotted: split };
}
