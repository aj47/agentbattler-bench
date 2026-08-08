import { stateDigest } from '../domain/fold.mjs';
import { loadLogicalEvents, loadState, logicalHeadSha256 } from '../storage/journal.mjs';

export async function replay() {
  const state = await loadState();
  const events = await loadLogicalEvents(state);
  return {
    ok: true,
    verified: true,
    eventCount: events.length,
    headSha256: logicalHeadSha256(events),
    generation: state.generation,
  };
}

export async function audit() {
  const state = await loadState();
  const replayed = await replay();
  for (const receipt of Object.values(state.batches)) {
    if (!receipt || typeof receipt.digest !== 'string' || !Array.isArray(receipt.eventIds)) throw new Error('invalid batch receipt');
  }
  return {
    ok: true,
    verified: true,
    eventCount: replayed.eventCount,
    headSha256: replayed.headSha256,
    stateSha256: stateDigest(state),
    generation: state.generation,
  };
}
