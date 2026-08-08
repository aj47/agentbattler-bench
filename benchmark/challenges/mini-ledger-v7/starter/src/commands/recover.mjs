import { access, readFile, rm } from 'node:fs/promises';

import { normalizeState, stateDigest } from '../domain/fold.mjs';
import { saveState } from '../storage/journal.mjs';
import { LOCK, STATE, TEMPORARY_STATE } from '../storage/paths.mjs';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function recover() {
  const candidates = [];
  for (const file of [STATE, TEMPORARY_STATE]) {
    if (!await exists(file)) continue;
    try {
      const state = normalizeState(JSON.parse(await readFile(file, 'utf8')));
      candidates.push({ file, state });
    } catch {
      // A candidate is useful only after complete validation.
    }
  }
  if (candidates.length === 0) throw new Error('no valid recovery candidate');
  candidates.sort((left, right) => right.state.generation - left.state.generation || stateDigest(right.state).localeCompare(stateDigest(left.state)));
  await saveState(candidates[0].state);
  await rm(TEMPORARY_STATE, { force: true });
  await rm(LOCK, { force: true });
  return { ok: true, generation: candidates[0].state.generation, recoveredFrom: candidates[0].file === STATE ? 'primary' : 'temporary' };
}
