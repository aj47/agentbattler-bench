import { loadLogicalEvents, loadState } from '../storage/journal.mjs';

function positiveInteger(text, name) {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a positive integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

function decodeCursor(token, kind) {
  let value;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid cursor');
  }
  if (value.kind !== kind || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) throw new Error('cursor does not match query');
  return value.afterSequence;
}

export async function get({ id }) {
  const state = await loadState();
  const event = (await loadLogicalEvents(state)).find((candidate) => candidate.id === id);
  if (!event) throw new Error(`unknown id: ${id}`);
  return event;
}

export async function query(flags) {
  const state = await loadState();
  const limit = positiveInteger(flags.limit, 'limit');
  const cursorMode = Object.hasOwn(flags, 'cursor') || !Object.hasOwn(flags, 'after-sequence');
  const afterSequence = Object.hasOwn(flags, 'cursor')
    ? decodeCursor(flags.cursor, flags.kind)
    : Object.hasOwn(flags, 'after-sequence') ? Number(flags['after-sequence']) : 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('after-sequence must be a non-negative integer');
  const matching = (await loadLogicalEvents(state)).filter((event) => event.kind === flags.kind && event.sequence > afterSequence);
  const items = matching.slice(0, limit);
  if (!cursorMode) return items;
  const nextCursor = matching.length > items.length
    ? Buffer.from(JSON.stringify({ kind: flags.kind, afterSequence: items.at(-1).sequence })).toString('base64url')
    : null;
  return { items, nextCursor };
}
