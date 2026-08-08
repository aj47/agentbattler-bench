import { advanceState } from '../domain/fold.mjs';
import { normalizeEvent, parsePayload } from '../domain/event.mjs';
import { loadLogicalEvents, loadState, saveState } from '../storage/journal.mjs';

export async function append(flags) {
  const state = await loadState();
  const logical = await loadLogicalEvents(state);
  if (logical.some(({ id }) => id === flags.id)) throw new Error(`duplicate id: ${flags.id}`);
  const event = normalizeEvent({ id: flags.id, kind: flags.kind, payload: parsePayload(flags.payload) }, state.nextSequence);
  await saveState(advanceState(state, { events: [...state.events, event], nextSequence: state.nextSequence + 1 }));
  return event;
}
