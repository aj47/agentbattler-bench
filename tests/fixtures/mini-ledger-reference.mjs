#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 'agentbattler.ledger.v2';
const SNAPSHOT_SCHEMA = 'agentbattler.ledger.snapshot.v1';
const cwd = process.cwd();
const statePath = path.join(cwd, 'ledger.json');
const lockPath = path.join(cwd, 'ledger.lock');
const temporaryPath = `${statePath}.tmp`;

class LedgerError extends Error {}
const fail = (message) => { throw new LedgerError(message); };
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function event(input, index, { sequenceRequired = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`event ${index} must be an object`);
  if (typeof input.id !== 'string' || !input.id) fail(`event ${index} id is required`);
  if (typeof input.kind !== 'string' || !input.kind) fail(`event ${index} kind is required`);
  if (!Object.prototype.hasOwnProperty.call(input, 'payload')) fail(`event ${index} payload is required`);
  if (sequenceRequired && (!Number.isSafeInteger(input.sequence) || input.sequence < 1)) fail(`event ${index} sequence is invalid`);
  return sequenceRequired
    ? { id: input.id, kind: input.kind, payload: input.payload, sequence: input.sequence }
    : { id: input.id, kind: input.kind, payload: input.payload };
}

function validateLogical(input) {
  if (!input || input.schemaVersion !== SCHEMA || !Array.isArray(input.events)) fail('invalid v2 state');
  const events = input.events.map((entry, index) => event(entry, index));
  const ids = new Set();
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence !== index + 1) fail('event sequences must be contiguous from 1');
    if (ids.has(events[index].id)) fail(`duplicate event id: ${events[index].id}`);
    ids.add(events[index].id);
  }
  if (input.nextSequence !== events.length + 1) fail('nextSequence does not follow the logical ledger');
  const idempotencyKeys = input.idempotencyKeys ?? {};
  if (!idempotencyKeys || typeof idempotencyKeys !== 'object' || Array.isArray(idempotencyKeys)) fail('invalid idempotency metadata');
  for (const [key, record] of Object.entries(idempotencyKeys)) {
    if (!record || typeof record.hash !== 'string' || !Array.isArray(record.ids)) fail(`invalid idempotency record: ${key}`);
    if (!record.ids.every((id) => ids.has(id))) fail(`idempotency record references an unknown id: ${key}`);
  }
  return { schemaVersion: SCHEMA, events, nextSequence: input.nextSequence, idempotencyKeys };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`cannot read ${path.basename(file)}: ${error.message}`);
  }
}

async function load() {
  const raw = await readJson(statePath);
  if (!raw) return { schemaVersion: SCHEMA, events: [], nextSequence: 1, idempotencyKeys: {}, keep: null };
  const tail = Array.isArray(raw.events) ? raw.events.map((entry, index) => event(entry, index)) : fail('state events must be an array');
  let prefix = [];
  if (raw.snapshotFile) {
    const snapshot = await readJson(path.join(cwd, raw.snapshotFile));
    if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA || !Array.isArray(snapshot.events)) fail('invalid snapshot');
    if (snapshot.checksum !== digest(snapshot.events)) fail('snapshot checksum mismatch');
    prefix = snapshot.events.map((entry, index) => event(entry, index));
  }
  const logical = validateLogical({ schemaVersion: SCHEMA, events: [...prefix, ...tail], nextSequence: raw.nextSequence, idempotencyKeys: raw.idempotencyKeys ?? {} });
  return { ...logical, keep: Number.isSafeInteger(raw.keep) && raw.keep > 0 ? raw.keep : null };
}

async function atomicWrite(file, value) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function save(logical, requestedKeep = logical.keep) {
  const normalized = validateLogical(logical);
  const keep = Number.isSafeInteger(requestedKeep) && requestedKeep > 0 ? requestedKeep : null;
  if (!keep || normalized.events.length <= keep) {
    await fs.rm(path.join(cwd, 'ledger.snapshot.json'), { force: true });
    await atomicWrite(statePath, normalized);
    return { ...normalized, keep: null };
  }
  const prefix = normalized.events.slice(0, -keep);
  const tail = normalized.events.slice(-keep);
  const snapshot = { schemaVersion: SNAPSHOT_SCHEMA, events: prefix, checksum: digest(prefix) };
  await atomicWrite(path.join(cwd, 'ledger.snapshot.json'), snapshot);
  await atomicWrite(statePath, { schemaVersion: SCHEMA, events: tail, nextSequence: normalized.nextSequence, idempotencyKeys: normalized.idempotencyKeys, snapshotFile: 'ledger.snapshot.json', keep });
  return { ...normalized, keep };
}

async function acquireLock() {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    try { return await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(5);
    }
  }
  fail('lock timeout');
}

async function mutate(callback) {
  const lock = await acquireLock();
  try {
    const logical = await load();
    const result = await callback(logical);
    if (!result?.noWrite) await save(logical, logical.keep);
    return result?.value ?? result;
  } finally {
    await lock.close().catch(() => {});
    await fs.rm(lockPath, { force: true });
  }
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] === undefined) fail(`invalid argument: ${args[index] ?? ''}`);
    const key = args[index].slice(2);
    if (Object.prototype.hasOwnProperty.call(result, key)) fail(`duplicate option: --${key}`);
    result[key] = args[index + 1];
  }
  return result;
}

function required(value, name) { if (typeof value !== 'string' || !value) fail(`${name} is required`); return value; }
function integer(value, name, minimum = 1) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < minimum) fail(`${name} must be an integer >= ${minimum}`); return parsed; }
function parsePayload(value) { try { return JSON.parse(required(value, '--payload')); } catch (error) { fail(`invalid payload JSON: ${error.message}`); } }

async function append(input) {
  const id = required(input.id, '--id'); const kind = required(input.kind, '--kind'); const payload = parsePayload(input.payload);
  return mutate((logical) => {
    if (logical.events.some((entry) => entry.id === id)) fail(`duplicate event id: ${id}`);
    const created = { id, kind, payload, sequence: logical.nextSequence++ };
    logical.events.push(created);
    return created;
  });
}

async function get(input) {
  const found = (await load()).events.find((entry) => entry.id === required(input.id, '--id'));
  if (!found) fail('event not found');
  return found;
}

async function query(input) {
  const kind = required(input.kind, '--kind'); const after = integer(input['after-sequence'], '--after-sequence', 0); const limit = integer(input.limit, '--limit');
  return (await load()).events.filter((entry) => entry.kind === kind && entry.sequence > after).slice(0, limit);
}

async function appendBatch(input) {
  const file = path.resolve(cwd, required(input.file, '--file')); const key = required(input['idempotency-key'], '--idempotency-key');
  let parsed; try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { fail(`invalid batch: ${error.message}`); }
  const entries = (Array.isArray(parsed) ? parsed : parsed?.events).map((entry, index) => event(entry, index, { sequenceRequired: false }));
  const requestHash = digest(entries); const batchIds = new Set();
  for (const entry of entries) { if (batchIds.has(entry.id)) fail(`duplicate event id: ${entry.id}`); batchIds.add(entry.id); }
  return mutate((logical) => {
    const prior = logical.idempotencyKeys[key];
    if (prior) {
      if (prior.hash !== requestHash) fail('idempotency key conflict');
      return { noWrite: true, value: { idempotent: true, events: logical.events.filter((entry) => prior.ids.includes(entry.id)) } };
    }
    if (entries.some((entry) => logical.events.some((existing) => existing.id === entry.id))) fail('duplicate event id against existing state');
    const created = entries.map((entry) => ({ ...entry, sequence: logical.nextSequence++ }));
    logical.events.push(...created);
    logical.idempotencyKeys[key] = { hash: requestHash, ids: created.map((entry) => entry.id) };
    return { idempotent: false, events: created };
  });
}

async function exportState(destination) {
  const logical = await load();
  const output = path.resolve(cwd, required(destination, 'export path'));
  await atomicWrite(output, validateLogical(logical));
  return { ok: true, events: logical.events.length };
}

function normalizeImport(input) {
  if (input?.schemaVersion === 'agentbattler.ledger.v1' && Array.isArray(input.events)) {
    const entries = input.events.map((entry, index) => event(entry, index, { sequenceRequired: false }));
    return validateLogical({ schemaVersion: SCHEMA, events: entries.map((entry, index) => ({ ...entry, sequence: index + 1 })), nextSequence: entries.length + 1, idempotencyKeys: {} });
  }
  return validateLogical(input);
}

async function importState(source) {
  const file = path.resolve(cwd, required(source, 'import path'));
  let imported; try { imported = normalizeImport(JSON.parse(await fs.readFile(file, 'utf8'))); } catch (error) { fail(`invalid import: ${error.message}`); }
  const lock = await acquireLock();
  try { await save(imported, null); }
  finally { await lock.close().catch(() => {}); await fs.rm(lockPath, { force: true }); }
  return { ok: true, imported: imported.events.length };
}

async function compact(input) {
  const keep = integer(input.keep, '--keep');
  const lock = await acquireLock();
  try { const logical = await load(); await save(logical, keep); return { ok: true, kept: Math.min(keep, logical.events.length), events: logical.events.length }; }
  finally { await lock.close().catch(() => {}); await fs.rm(lockPath, { force: true }); }
}

async function recover() {
  await fs.rm(lockPath, { force: true });
  const temporary = await readJson(temporaryPath);
  if (temporary) {
    const recovered = validateLogical(temporary);
    const primary = await readJson(statePath);
    if (!primary || recovered.nextSequence > (await load()).nextSequence) await fs.rename(temporaryPath, statePath);
    else await fs.rm(temporaryPath, { force: true });
    return { ok: true, recovered: true };
  }
  try { await fs.access(temporaryPath); fail('malformed temporary state'); } catch (error) { if (error instanceof LedgerError) throw error; }
  await load();
  return { ok: true, recovered: false };
}

async function replay() { const logical = await load(); return { ok: true, verified: true, digest: digest(validateLogical(logical)), events: logical.events.length }; }
async function audit() { const logical = await load(); validateLogical(logical); return { ok: true, verified: true, events: logical.events.length, nextSequence: logical.nextSequence }; }

async function main() {
  const [command, ...args] = process.argv.slice(2); let result;
  if (command === 'export' || command === 'import') {
    if (args.length !== 1) fail(`${command} requires one path`);
    result = command === 'export' ? await exportState(args[0]) : await importState(args[0]);
  } else {
    const input = options(args);
    if (command === 'append') result = await append(input);
    else if (command === 'get') result = await get(input);
    else if (command === 'query') result = await query(input);
    else if (command === 'append-batch') result = await appendBatch(input);
    else if (command === 'compact') result = await compact(input);
    else if (command === 'recover') result = await recover();
    else if (command === 'replay') result = await replay();
    else if (command === 'audit') result = await audit();
    else fail(`unknown command: ${command ?? ''}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
