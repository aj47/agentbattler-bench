import { canonicalJson } from './canonical.mjs';

export const V1_SCHEMA = 'agentbattler.ledger.v1';
export const V2_SCHEMA = 'agentbattler.ledger.v2';

export function normalizeEvent(value, sequence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`event ${sequence} is not an object`);
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error(`event ${sequence} has an invalid id`);
  if (typeof value.kind !== 'string' || value.kind.length === 0) throw new Error(`event ${sequence} has an invalid kind`);
  if (!Object.hasOwn(value, 'payload') || value.payload === undefined) throw new Error(`event ${sequence} has no payload`);
  canonicalJson(value.payload);
  return { id: value.id, kind: value.kind, payload: value.payload, sequence };
}

export function parsePayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('payload must be valid JSON');
  }
  if (payload === undefined) throw new Error('payload must be a JSON value');
  return payload;
}
