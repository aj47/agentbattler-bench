import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  access,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const V1 = 'agentbattler.ledger.v1';
const V2 = 'agentbattler.ledger.v2';
const SNAPSHOT_SCHEMA = 'agentbattler.ledger.snapshot.v1';
const ROOT = realpathSync(process.cwd());
const PRIMARY = path.join(ROOT, 'ledger.json');
const TEMPORARY = path.join(ROOT, 'ledger.json.tmp');
const LOCK = path.join(ROOT, 'ledger.lock');
const CURSOR_SECRET = path.join(ROOT, '.ledger.cursor-secret');
const LOCK_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedJson(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalizedJson(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestState(state) {
  return sha256(canonicalJson(state));
}

function isHexDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateJsonValue(value, label = 'payload', depth = 0) {
  assert(depth <= 100, `${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, label, depth + 1);
    return;
  }
  assert(isPlainObject(value), `${label} is not a JSON value`);
  for (const item of Object.values(value)) validateJsonValue(item, label, depth + 1);
}

function normalizeEvent(value, expectedSequence, { legacy = false } = {}) {
  assert(isPlainObject(value), `event ${expectedSequence} is not an object`);
  assert(typeof value.id === 'string' && value.id.length > 0, `event ${expectedSequence} has an invalid id`);
  assert(typeof value.kind === 'string' && value.kind.length > 0, `event ${expectedSequence} has an invalid kind`);
  assert(Object.hasOwn(value, 'payload'), `event ${expectedSequence} has no payload`);
  validateJsonValue(value.payload, `event ${expectedSequence} payload`);
  if (!legacy) assert(value.sequence === expectedSequence, `event ${value.id} has a non-contiguous sequence`);
  return { id: value.id, kind: value.kind, payload: value.payload, sequence: expectedSequence };
}

function assertUniqueIds(events) {
  const ids = new Set();
  for (const event of events) {
    assert(!ids.has(event.id), `duplicate event id: ${event.id}`);
    ids.add(event.id);
  }
}

function normalizeBatches(value) {
  assert(isPlainObject(value), 'batch receipts are invalid');
  const result = Object.create(null);
  for (const [key, receipt] of Object.entries(value)) {
    assert(key.length > 0 && isPlainObject(receipt), 'batch receipt is invalid');
    assert(isHexDigest(receipt.digest), `batch ${key} digest is invalid`);
    assert(Number.isSafeInteger(receipt.count) && receipt.count >= 0, `batch ${key} count is invalid`);
    assert(Array.isArray(receipt.eventIds) && receipt.eventIds.every((id) => typeof id === 'string' && id.length > 0), `batch ${key} ids are invalid`);
    assert(receipt.eventIds.length === receipt.count && new Set(receipt.eventIds).size === receipt.eventIds.length, `batch ${key} receipt is inconsistent`);
    result[key] = { digest: receipt.digest, count: receipt.count, eventIds: [...receipt.eventIds] };
  }
  return result;
}

function migrateLegacy(value) {
  assert(isPlainObject(value) && value.schemaVersion === V1, 'legacy ledger schema is invalid');
  assert(Array.isArray(value.events), 'legacy events must be an array');
  const events = value.events.map((event, index) => normalizeEvent(event, index + 1, { legacy: true }));
  assertUniqueIds(events);
  return {
    schemaVersion: V2,
    generation: 0,
    lineageRootSha256: sha256(canonicalJson(events)),
    parentStateSha256: null,
    snapshotFile: null,
    snapshotSha256: null,
    snapshotThroughSequence: null,
    events,
    batches: {},
    nextSequence: events.length + 1,
  };
}

function normalizeV2(value, { standalone = false } = {}) {
  assert(isPlainObject(value) && value.schemaVersion === V2, `unsupported schema: ${value?.schemaVersion ?? '<missing>'}`);
  assert(Number.isSafeInteger(value.generation) && value.generation >= 0, 'generation is invalid');
  assert(isHexDigest(value.lineageRootSha256), 'lineage root is invalid');
  assert(value.parentStateSha256 === null || isHexDigest(value.parentStateSha256), 'parent state hash is invalid');
  if (value.generation === 0) assert(value.parentStateSha256 === null, 'generation zero cannot have a parent');

  const snapshotFile = value.snapshotFile ?? null;
  const snapshotSha256 = value.snapshotSha256 ?? null;
  const snapshotThroughSequence = value.snapshotThroughSequence ?? null;
  if (snapshotFile === null) {
    assert(snapshotSha256 === null && snapshotThroughSequence === null, 'snapshot metadata is inconsistent');
  } else {
    assert(!standalone, 'an imported export must be self-contained');
    assert(typeof snapshotFile === 'string' && snapshotFile.length > 0, 'snapshot file is invalid');
    assert(isHexDigest(snapshotSha256), 'snapshot checksum is invalid');
    assert(Number.isSafeInteger(snapshotThroughSequence) && snapshotThroughSequence > 0, 'snapshot boundary is invalid');
  }
  assert(Array.isArray(value.events), 'events must be an array');
  const firstSequence = (snapshotThroughSequence ?? 0) + 1;
  const events = value.events.map((event, index) => normalizeEvent(event, firstSequence + index));
  assertUniqueIds(events);
  assert(Number.isSafeInteger(value.nextSequence) && value.nextSequence === firstSequence + events.length, 'nextSequence is inconsistent');
  return {
    schemaVersion: V2,
    generation: value.generation,
    lineageRootSha256: value.lineageRootSha256,
    parentStateSha256: value.parentStateSha256,
    snapshotFile,
    snapshotSha256,
    snapshotThroughSequence,
    events,
    batches: normalizeBatches(value.batches),
    nextSequence: value.nextSequence,
  };
}

function insideRoot(candidate) {
  const lexical = path.resolve(ROOT, candidate);
  let existing = lexical;
  const suffix = [];
  let resolved;
  while (true) {
    try {
      resolved = path.join(realpathSync(existing), ...suffix);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      assert(parent !== existing, 'cannot resolve workspace path');
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
  assert(resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`), 'path escapes workspace');
  return resolved;
}

function safeRuntimePath(relative) {
  assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'runtime path must be relative');
  const resolved = insideRoot(relative);
  assert(resolved !== ROOT, 'runtime path names the workspace root');
  return resolved;
}

async function readRegular(file) {
  const metadata = await lstat(file);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `runtime artifact is not a regular file: ${path.basename(file)}`);
  assert(metadata.nlink === 1, `runtime artifact has multiple hardlinks: ${path.basename(file)}`);
  return readFile(file);
}

async function validateSnapshot(state) {
  if (!state.snapshotFile) return [];
  const file = safeRuntimePath(state.snapshotFile);
  const bytes = await readRegular(file);
  assert(sha256(bytes) === state.snapshotSha256, 'snapshot checksum mismatch');
  let document;
  try { document = JSON.parse(bytes); } catch { fail('snapshot JSON is malformed'); }
  assert(isPlainObject(document) && document.schemaVersion === SNAPSHOT_SCHEMA, 'snapshot schema is invalid');
  assert(document.throughSequence === state.snapshotThroughSequence, 'snapshot boundary does not match primary');
  assert(Array.isArray(document.events) && document.events.length === document.throughSequence, 'snapshot event count is invalid');
  const events = document.events.map((event, index) => normalizeEvent(event, index + 1));
  assertUniqueIds(events);
  if (Object.hasOwn(document, 'lineageRootSha256')) assert(document.lineageRootSha256 === state.lineageRootSha256, 'snapshot lineage does not match primary');
  if (Object.hasOwn(document, 'headSha256')) assert(document.headSha256 === sha256(canonicalJson(events)), 'snapshot logical head is invalid');
  return events;
}

async function validateLogicalState(state) {
  const events = [...await validateSnapshot(state), ...state.events];
  assertUniqueIds(events);
  for (const [index, event] of events.entries()) assert(event.sequence === index + 1, 'logical event sequences are not contiguous');
  assert(state.nextSequence === events.length + 1, 'logical nextSequence is inconsistent');
  const ids = new Set(events.map(({ id }) => id));
  for (const [key, receipt] of Object.entries(state.batches)) {
    assert(receipt.eventIds.every((id) => ids.has(id)), `batch ${key} refers to an unknown event`);
  }
  return events;
}

async function parseStateBytes(bytes, { allowLegacy = true, standalone = false } = {}) {
  let raw;
  try { raw = JSON.parse(bytes); } catch { fail('ledger JSON is malformed'); }
  const migrated = raw?.schemaVersion === V1;
  assert(!migrated || allowLegacy, 'legacy state is not allowed here');
  const state = migrated ? migrateLegacy(raw) : normalizeV2(raw, { standalone });
  const events = await validateLogicalState(state);
  return {
    raw,
    rawDigest: sha256(canonicalJson(raw)),
    baseDigest: migrated ? digestState(state) : sha256(canonicalJson(raw)),
    state,
    events,
    migrated,
  };
}

async function readStateFile(file, options) {
  return parseStateBytes(await readRegular(file), options);
}

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(file, bytes, { canonicalTemporary = false, mode = 0o600 } = {}) {
  const target = insideRoot(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = canonicalTemporary
    ? TEMPORARY
    : path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  assert(temporary !== target, 'atomic temporary path collides with target');
  const handle = await open(temporary, 'w', mode);
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete && !canonicalTemporary) await rm(temporary, { force: true });
  }
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function readLock() {
  try {
    const bytes = await readFile(LOCK);
    const value = JSON.parse(bytes);
    return isPlainObject(value) ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function acquireLock() {
  const token = randomBytes(18).toString('hex');
  const record = { schema: 'agentbattler.ledger.lock.v1', pid: process.pid, token };
  const bytes = `${JSON.stringify(record)}\n`;
  const claim = path.join(ROOT, `.ledger.lock.${process.pid}.${token}.claim`);
  const claimHandle = await open(claim, 'wx', 0o600);
  try { await claimHandle.writeFile(bytes); await claimHandle.sync(); } finally { await claimHandle.close(); }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let pause = 2;
  try {
    while (Date.now() < deadline) {
      try {
        // Linking a fully synced private claim publishes complete owner metadata
        // in one atomic namespace operation; contenders can never observe an
        // empty, half-written canonical lock file.
        await link(claim, LOCK);
        await syncDirectory(ROOT);
        await rm(claim, { force: true });
        return record;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = await readLock();
        if (!owner && !await exists(LOCK)) continue;
        if (!owner || !processIsAlive(owner.pid)) {
          const current = await readLock();
          if (!current && !await exists(LOCK)) continue;
          if (current?.pid !== owner?.pid || current?.token !== owner?.token) continue;
          fail('stale ledger lock requires recover');
        }
        await sleep(pause);
        pause = Math.min(50, pause * 2);
      }
    }
    fail('timed out waiting for ledger lock');
  } finally {
    await rm(claim, { force: true });
  }
}

async function releaseLock(record) {
  const owner = await readLock();
  if (owner?.pid === record.pid && owner?.token === record.token) {
    await rm(LOCK, { force: true });
    await syncDirectory(ROOT);
  }
}

async function withLock(operation) {
  const record = await acquireLock();
  try { return await operation(); } finally { await releaseLock(record); }
}

async function removeStaleLockForRecovery() {
  if (!await exists(LOCK)) return;
  const owner = await readLock();
  assert(!owner || !processIsAlive(owner.pid), 'cannot recover while a live writer owns ledger.lock');
  // Ordinary contenders never remove dead locks. Consequently, once recovery
  // observes a dead owner, no successor can replace the canonical lock between
  // this check and unlink; this avoids stale-lock scanner races.
  await rm(LOCK, { force: true });
  await syncDirectory(ROOT);
}

async function loadCurrent() {
  return readStateFile(PRIMARY, { allowLegacy: true });
}

async function commitState(state) {
  const normalized = normalizeV2(state);
  await validateLogicalState(normalized);
  await atomicWrite(PRIMARY, `${JSON.stringify(normalized)}\n`, { canonicalTemporary: true });
  return normalized;
}

async function persistMigration(current) {
  if (current.migrated) await commitState(current.state);
}

function descendant(current, changes) {
  return normalizeV2({
    ...current.state,
    ...changes,
    schemaVersion: V2,
    generation: current.state.generation + 1,
    lineageRootSha256: current.state.lineageRootSha256,
    parentStateSha256: current.baseDigest,
  });
}

function parsePayload(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail('payload must be valid JSON'); }
  validateJsonValue(value);
  return value;
}

function canonicalPositiveInteger(text, label) {
  assert(typeof text === 'string' && /^[1-9][0-9]*$/.test(text), `${label} must be a canonical positive integer`);
  const value = Number(text);
  assert(Number.isSafeInteger(value), `${label} is too large`);
  return value;
}

function canonicalNonNegativeInteger(text, label) {
  assert(typeof text === 'string' && /^(0|[1-9][0-9]*)$/.test(text), `${label} must be a canonical non-negative integer`);
  const value = Number(text);
  assert(Number.isSafeInteger(value), `${label} is too large`);
  return value;
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  assert(typeof command === 'string' && command.length > 0, 'a command is required');
  const flags = Object.create(null);
  const positionals = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      index += 1;
      continue;
    }
    const name = token.slice(2);
    const value = tokens[index + 1];
    assert(name.length > 0 && value !== undefined && !value.startsWith('--'), `invalid argument near ${token}`);
    assert(!Object.hasOwn(flags, name), `duplicate --${name}`);
    flags[name] = value;
    index += 2;
  }
  return { command, flags, positionals };
}

function exactArguments(parsed, flagNames, positionalCount) {
  assert(parsed.positionals.length === positionalCount, `expected ${positionalCount} positional argument${positionalCount === 1 ? '' : 's'}`);
  const wanted = new Set(flagNames);
  for (const name of flagNames) assert(Object.hasOwn(parsed.flags, name) && parsed.flags[name] !== '', `missing --${name}`);
  for (const name of Object.keys(parsed.flags)) assert(wanted.has(name), `unexpected --${name}`);
}

function assertSafeUserFile(name, { writable = false } = {}) {
  assert(typeof name === 'string' && name.length > 0, 'file path is empty');
  const file = insideRoot(name);
  const controlRoot = path.join(ROOT, '.agentbattler');
  assert(file !== controlRoot && !file.startsWith(`${controlRoot}${path.sep}`), 'control files are not writable data');
  if (writable) {
    const reserved = new Set([PRIMARY, TEMPORARY, LOCK]);
    assert(!reserved.has(file), 'path is reserved for ledger runtime state');
    const sourceRoot = path.join(ROOT, 'src');
    const binRoot = path.join(ROOT, 'bin');
    assert(file !== sourceRoot && !file.startsWith(`${sourceRoot}${path.sep}`), 'cannot overwrite executable source');
    assert(file !== binRoot && !file.startsWith(`${binRoot}${path.sep}`), 'cannot overwrite executable source');
  }
  return file;
}

async function cursorSecret() {
  if (!await exists(CURSOR_SECRET)) await atomicWrite(CURSOR_SECRET, randomBytes(32));
  const secret = await readRegular(CURSOR_SECRET);
  assert(secret.length === 32, 'cursor signing secret is corrupt');
  return secret;
}

function cursorKey(secret, lineageRootSha256) {
  return createHmac('sha256', secret).update(`agentbattler-v7-cursor-key\0${lineageRootSha256}`).digest();
}

function encodeCursor(payload, secret, lineageRootSha256) {
  const body = Buffer.from(canonicalJson(payload));
  const mac = createHmac('sha256', cursorKey(secret, lineageRootSha256)).update(body).digest();
  return `${body.toString('base64url')}.${mac.toString('base64url')}`;
}

function strictBase64url(value, label) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), `${label} is malformed`);
  const bytes = Buffer.from(value, 'base64url');
  assert(bytes.toString('base64url') === value, `${label} is not canonically encoded`);
  return bytes;
}

function decodeCursor(token, kind, state, events, secret) {
  assert(typeof token === 'string' && token.length <= 4096, 'invalid cursor');
  const parts = token.split('.');
  assert(parts.length === 2, 'invalid cursor');
  const body = strictBase64url(parts[0], 'cursor body');
  const suppliedMac = strictBase64url(parts[1], 'cursor signature');
  const expectedMac = createHmac('sha256', cursorKey(secret, state.lineageRootSha256)).update(body).digest();
  assert(suppliedMac.length === expectedMac.length && timingSafeEqual(suppliedMac, expectedMac), 'cursor signature is invalid');
  let value;
  try { value = JSON.parse(body); } catch { fail('cursor body is invalid'); }
  assert(canonicalJson(value) === body.toString('utf8'), 'cursor body is not canonical');
  assert(isPlainObject(value) && value.version === 1, 'cursor version is invalid');
  assert(value.kind === kind, 'cursor does not match query kind');
  assert(value.lineageRootSha256 === state.lineageRootSha256, 'cursor lineage is stale');
  assert(Number.isSafeInteger(value.afterSequence) && value.afterSequence >= 0, 'cursor position is invalid');
  assert(Number.isSafeInteger(value.boundarySequence) && value.boundarySequence >= value.afterSequence && value.boundarySequence <= events.length, 'cursor boundary is invalid');
  const boundaryEvents = events.slice(0, value.boundarySequence);
  assert(value.boundaryHeadSha256 === sha256(canonicalJson(boundaryEvents)), 'cursor boundary no longer matches ledger');
  return value;
}

async function appendCommand(flags) {
  const payload = parsePayload(flags.payload);
  return withLock(async () => {
    const current = await loadCurrent();
    assert(!current.events.some(({ id }) => id === flags.id), `duplicate id: ${flags.id}`);
    const event = normalizeEvent({ id: flags.id, kind: flags.kind, payload, sequence: current.state.nextSequence }, current.state.nextSequence);
    const next = descendant(current, { events: [...current.state.events, event], nextSequence: current.state.nextSequence + 1 });
    await commitState(next);
    return event;
  });
}

async function getCommand(flags) {
  return withLock(async () => {
    const current = await loadCurrent();
    const event = current.events.find(({ id }) => id === flags.id);
    assert(event, `unknown id: ${flags.id}`);
    await persistMigration(current);
    return event;
  });
}

async function queryCommand(flags, cursorMode) {
  const limit = canonicalPositiveInteger(flags.limit, 'limit');
  return withLock(async () => {
    const current = await loadCurrent();
    const secret = await cursorSecret();
    let afterSequence = 0;
    let boundarySequence = current.events.length;
    let boundaryHeadSha256 = sha256(canonicalJson(current.events));
    if (Object.hasOwn(flags, 'cursor')) {
      const cursor = decodeCursor(flags.cursor, flags.kind, current.state, current.events, secret);
      ({ afterSequence, boundarySequence, boundaryHeadSha256 } = cursor);
    } else if (Object.hasOwn(flags, 'after-sequence')) {
      afterSequence = canonicalNonNegativeInteger(flags['after-sequence'], 'after-sequence');
    }
    const matches = current.events.filter((event) => event.kind === flags.kind && event.sequence > afterSequence && event.sequence <= boundarySequence);
    const items = matches.slice(0, limit);
    await persistMigration(current);
    if (!cursorMode) return items;
    const nextCursor = matches.length > items.length
      ? encodeCursor({
        afterSequence: items.at(-1).sequence,
        boundaryHeadSha256,
        boundarySequence,
        kind: flags.kind,
        lineageRootSha256: current.state.lineageRootSha256,
        version: 1,
      }, secret, current.state.lineageRootSha256)
      : null;
    return { items, nextCursor };
  });
}

async function batchCommand(flags) {
  const file = assertSafeUserFile(flags.file);
  const bytes = await readRegular(file);
  const digest = sha256(bytes);
  let input;
  try { input = JSON.parse(bytes); } catch { fail('batch JSON is malformed'); }
  assert(Array.isArray(input) && input.length > 0, 'batch must be a non-empty array');
  return withLock(async () => {
    const current = await loadCurrent();
    const prior = current.state.batches[flags['idempotency-key']];
    if (prior) {
      assert(prior.digest === digest, 'idempotency-key collision');
      return { ok: true, idempotent: true, count: prior.count };
    }
    const used = new Set(current.events.map(({ id }) => id));
    const additions = input.map((value, index) => {
      const event = normalizeEvent(value, current.state.nextSequence + index, { legacy: true });
      assert(!used.has(event.id), `duplicate id: ${event.id}`);
      used.add(event.id);
      return event;
    });
    const batches = { ...current.state.batches };
    batches[flags['idempotency-key']] = { digest, count: additions.length, eventIds: additions.map(({ id }) => id) };
    const next = descendant(current, {
      events: [...current.state.events, ...additions],
      batches,
      nextSequence: current.state.nextSequence + additions.length,
    });
    await commitState(next);
    return { ok: true, idempotent: false, count: additions.length };
  });
}

function selfContainedExport(current) {
  return {
    schemaVersion: V2,
    generation: current.state.generation,
    lineageRootSha256: current.state.lineageRootSha256,
    parentStateSha256: current.state.parentStateSha256,
    snapshotFile: null,
    snapshotSha256: null,
    snapshotThroughSequence: null,
    events: current.events,
    batches: current.state.batches,
    nextSequence: current.events.length + 1,
    exportedFromStateSha256: current.rawDigest,
    exportedLogicalHeadSha256: sha256(canonicalJson(current.events)),
  };
}

async function exportCommand(targetName) {
  const target = assertSafeUserFile(targetName, { writable: true });
  return withLock(async () => {
    const current = await loadCurrent();
    const exported = selfContainedExport(current);
    await atomicWrite(target, `${JSON.stringify(exported)}\n`);
    await persistMigration(current);
    return { ok: true, eventCount: current.events.length, stateSha256: sha256(canonicalJson(exported)) };
  });
}

async function normalizeImport(bytes) {
  let input;
  try { input = JSON.parse(bytes); } catch { fail('import JSON is malformed'); }
  if (input?.schemaVersion === V1) return migrateLegacy(input);
  const state = normalizeV2(input, { standalone: true });
  await validateLogicalState(state);
  return state;
}

async function importCommand(sourceName) {
  const source = assertSafeUserFile(sourceName);
  const state = await normalizeImport(await readRegular(source));
  return withLock(async () => {
    // Revalidate before the sole durable replacement. The imported revision is
    // deliberately installed as its own complete lineage revision.
    await validateLogicalState(state);
    await commitState(state);
    return { ok: true, eventCount: state.nextSequence - 1 };
  });
}

async function compactCommand(flags) {
  const keep = canonicalPositiveInteger(flags.keep, 'keep');
  return withLock(async () => {
    const current = await loadCurrent();
    const split = Math.max(0, current.events.length - keep);
    let snapshotFile = null;
    let snapshotSha256 = null;
    let snapshotThroughSequence = null;
    if (split > 0) {
      const prefix = current.events.slice(0, split);
      const document = {
        schemaVersion: SNAPSHOT_SCHEMA,
        lineageRootSha256: current.state.lineageRootSha256,
        throughSequence: split,
        headSha256: sha256(canonicalJson(prefix)),
        events: prefix,
      };
      const bytes = `${JSON.stringify(document)}\n`;
      snapshotSha256 = sha256(bytes);
      snapshotFile = `ledger.snapshot.${snapshotSha256.slice(0, 24)}.json`;
      snapshotThroughSequence = split;
      const target = path.join(ROOT, snapshotFile);
      if (!await exists(target)) await atomicWrite(target, bytes);
      else assert(sha256(await readRegular(target)) === snapshotSha256, 'content-addressed snapshot collision');
    }
    const next = descendant(current, {
      snapshotFile,
      snapshotSha256,
      snapshotThroughSequence,
      events: current.events.slice(split),
      nextSequence: current.events.length + 1,
    });
    await commitState(next);
    return { ok: true, kept: current.events.length - split, snapshotted: split };
  });
}

async function discoverExports() {
  const result = [];
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === path.basename(PRIMARY) || entry.name === path.basename(TEMPORARY)) continue;
    if (!/(?:export|backup).*\.json$/i.test(entry.name)) continue;
    result.push(path.join(ROOT, entry.name));
  }
  result.sort();
  return result.slice(0, 64);
}

async function inspectCandidate(file, source, options = {}) {
  if (!await exists(file)) return { present: false, file, source };
  try {
    const candidate = await readStateFile(file, options);
    return { present: true, valid: true, file, source, ...candidate };
  } catch (error) {
    return { present: true, valid: false, file, source, error: error.message };
  }
}

function chooseRecovery(primary, temporary, exports) {
  if (primary.valid) {
    const candidates = [temporary, ...exports].filter(({ valid }) => valid);
    const primaryDigest = digestState(primary.state);
    const distinct = new Map();
    for (const candidate of candidates) {
      assert(candidate.state.lineageRootSha256 === primary.state.lineageRootSha256, 'recovery candidate is a fork');
      const candidateDigest = digestState(candidate.state);
      if (candidate.state.generation < primary.state.generation) fail('recovery candidate is a rollback');
      if (candidate.state.generation === primary.state.generation) {
        assert(candidateDigest === primaryDigest, 'equal-generation recovery candidates conflict');
        continue;
      }
      distinct.set(candidateDigest, { ...candidate, candidateDigest });
    }

    let chosen = primary;
    let parentDigest = primaryDigest;
    let generation = primary.state.generation + 1;
    while (distinct.size > 0) {
      const next = [...distinct.values()].filter((candidate) => (
        candidate.state.generation === generation
        && candidate.state.parentStateSha256 === parentDigest
      ));
      assert(next.length === 1, next.length === 0
        ? 'recovery candidate is not a proven descendant'
        : 'recovery candidates contain an ambiguous fork');
      chosen = next[0];
      parentDigest = chosen.candidateDigest;
      distinct.delete(chosen.candidateDigest);
      generation += 1;
    }
    return chosen;
  }

  const usable = [temporary, ...exports].filter(({ valid }) => valid);
  assert(usable.length > 0, 'no valid recovery candidate');
  const roots = new Set(usable.map(({ state }) => state.lineageRootSha256));
  assert(roots.size === 1, 'recovery candidates contain competing lineages');
  usable.sort((left, right) => right.state.generation - left.state.generation || left.rawDigest.localeCompare(right.rawDigest));
  const newest = usable.filter(({ state }) => state.generation === usable[0].state.generation);
  assert(new Set(newest.map(({ rawDigest }) => rawDigest)).size === 1, 'equal-generation recovery candidates conflict');
  return usable[0];
}

async function recoverCommand() {
  await removeStaleLockForRecovery();
  return withLock(async () => {
    const primary = await inspectCandidate(PRIMARY, 'primary', { allowLegacy: true });
    const temporary = await inspectCandidate(TEMPORARY, 'temporary', { allowLegacy: false });
    const exportCandidates = [];
    for (const file of await discoverExports()) exportCandidates.push(await inspectCandidate(file, 'export', { allowLegacy: true, standalone: true }));
    const chosen = chooseRecovery(primary, temporary, exportCandidates);
    if (!primary.valid || chosen.source !== 'primary' || chosen.migrated) await commitState(chosen.state);
    if (await exists(TEMPORARY)) {
      await rm(TEMPORARY, { force: true });
      await syncDirectory(ROOT);
    }
    return {
      ok: true,
      generation: chosen.state.generation,
      recoveredFrom: chosen.source,
      discardedInvalidCandidates: [primary, temporary, ...exportCandidates].filter(({ present, valid }) => present && !valid).length,
    };
  });
}

function replayResult(current) {
  return {
    ok: true,
    verified: true,
    eventCount: current.events.length,
    headSha256: sha256(canonicalJson(current.events)),
    generation: current.state.generation,
    lineageRootSha256: current.state.lineageRootSha256,
    stateSha256: current.rawDigest,
  };
}

async function replayCommand() {
  return withLock(async () => {
    const current = await loadCurrent();
    const result = replayResult(current);
    await persistMigration(current);
    return result;
  });
}

async function auditCommand() {
  return withLock(async () => {
    const current = await loadCurrent();
    const replayed = replayResult(current);
    await persistMigration(current);
    return { ...replayed, ok: true, verified: true, batchCount: Object.keys(current.state.batches).length };
  });
}

async function dispatch(parsed) {
  const { command, flags } = parsed;
  if (command === 'append') {
    exactArguments(parsed, ['id', 'kind', 'payload'], 0);
    return appendCommand(flags);
  }
  if (command === 'get') {
    exactArguments(parsed, ['id'], 0);
    return getCommand(flags);
  }
  if (command === 'query') {
    const cursorMode = Object.hasOwn(flags, 'cursor') || !Object.hasOwn(flags, 'after-sequence');
    exactArguments(parsed, Object.hasOwn(flags, 'cursor') ? ['kind', 'cursor', 'limit'] : Object.hasOwn(flags, 'after-sequence') ? ['kind', 'after-sequence', 'limit'] : ['kind', 'limit'], 0);
    return queryCommand(flags, cursorMode);
  }
  if (command === 'append-batch') {
    exactArguments(parsed, ['file', 'idempotency-key'], 0);
    return batchCommand(flags);
  }
  if (command === 'export') {
    exactArguments(parsed, [], 1);
    return exportCommand(parsed.positionals[0]);
  }
  if (command === 'import') {
    exactArguments(parsed, [], 1);
    return importCommand(parsed.positionals[0]);
  }
  if (command === 'compact') {
    exactArguments(parsed, ['keep'], 0);
    return compactCommand(flags);
  }
  if (command === 'recover') {
    exactArguments(parsed, [], 0);
    return recoverCommand();
  }
  if (command === 'replay') {
    exactArguments(parsed, [], 0);
    return replayCommand();
  }
  if (command === 'audit') {
    exactArguments(parsed, [], 0);
    return auditCommand();
  }
  fail(`unknown command: ${command}`);
}

export async function main(argv) {
  try {
    const result = await dispatch(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 300) })}\n`);
    process.exitCode = 1;
  }
}
