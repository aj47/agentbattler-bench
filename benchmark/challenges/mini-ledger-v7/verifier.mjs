import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  V7_HIDDEN_CASES,
  V7_SEALED_PACK_SCHEMA,
  assertV7PackSeal,
  buildV7IncidentEvidence,
  deriveV7HiddenSeed,
  hashV7ExecutableTree,
  loadV7Pack,
  sealV7Pack,
} from './pack.mjs';
import { V7_FAMILIES, V7_REQUIREMENTS, canonicalJson, sha256 } from './requirements.mjs';
import {
  candidateNativeSandboxCommand,
  candidateOwnedDirectory,
  candidateOwnedFile,
} from '../candidate-process.mjs';

export const V7_VERIFICATION_SCHEMA = 'agentbattler.mini-ledger-v7.verification.v1';

function freezeAssertionClasses(entries) {
  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([requirementId, classes]) => [
    requirementId,
    Object.freeze(Object.fromEntries(Object.entries(classes).map(([caseClass, [assertionId, caseCount]]) => [
      caseClass,
      Object.freeze({ assertionId, caseCount }),
    ]))),
  ])));
}

export const V7_VERIFIER_ASSERTIONS = freezeAssertionClasses({
  'V7-P1-PUBLIC-MIGRATE': { public: ['p1.public.legacy-order-migration', 1] },
  'V7-P1-PRIVATE-COMPAT': { atomic: ['p1.atomic.post-migration-clients', 3], composed: ['p1.composed.export-import-roundtrip', 1] },
  'V7-P1-PRIVATE-REJECT': { atomic: ['p1.atomic.unknown-schema-no-mutation', 3], composed: ['p1.composed.malformed-legacy-no-mutation', 7] },
  'V7-P2-PUBLIC-BATCH': { public: ['p2.public.valid-batch-atomic-commit', 1] },
  'V7-P2-PUBLIC-CURSOR': { public: ['p2.public.opaque-ordered-page-strict-limit', 10] },
  'V7-P2-PRIVATE-IDEMPOTENCY': { atomic: ['p2.atomic.byte-identical-retry', 1], composed: ['p2.composed.collision-and-malformed-batch-atomicity', 7] },
  'V7-P2-PRIVATE-PAGINATION': { atomic: ['p2.atomic.cursor-filter-tamper-binding', 4], composed: ['p2.composed.cursor-boundary-lineage-evolution', 4] },
  'V7-P3-PUBLIC-SERIALIZE': { public: ['p3.public.concurrent-append-bounded-compaction', 2] },
  'V7-P3-PRIVATE-ATOMICITY': { atomic: ['p3.atomic.lifecycle-linearization', 3], composed: ['p3.composed.multiwriter-reader-serializability', 10] },
  'V7-P3-PRIVATE-TERMINATION': { atomic: ['p3.atomic.stable-storage-ordering', 3], composed: ['p3.composed.seeded-prior-or-next-recovery', 5] },
  'V7-P4-PUBLIC-INCIDENT': { public: ['p4.public.canonical-incident-classification', 1] },
  'V7-P4-PRIVATE-PROVENANCE': { atomic: ['p4.atomic.canonical-lineage-citation', 1], composed: ['p4.composed.complete-deployment-provenance', 1] },
  'V7-P4-PRIVATE-SOURCE': { atomic: ['p4.atomic.executable-tree-identity', 1], composed: ['p4.composed.response-source-commitment', 1] },
  'V7-P5-PUBLIC-RECOVER': { public: ['p5.public.corrupt-primary-valid-lineage-recovery', 6] },
  'V7-P5-PRIVATE-LINEAGE': { atomic: ['p5.atomic.fork-rollback-rejection', 2], composed: ['p5.composed.candidate-conflict-reconciliation', 3] },
  'V7-P5-PRIVATE-REPLAY': { atomic: ['p5.atomic.exact-replay-audit', 2], composed: ['p5.composed.corruption-detection-nonmutation', 8] },
  'V7-P5-PRIVATE-SCALE': { atomic: ['p5.atomic.mixed-interface-scale', 4], composed: ['p5.composed.compact-import-recover-scale', 4] },
});

export const V7_VERIFIER_ASSERTION_CATALOG = Object.freeze(Object.entries(V7_VERIFIER_ASSERTIONS).flatMap(([requirementId, classes]) => (
  Object.entries(classes).map(([caseClass, { assertionId, caseCount }]) => Object.freeze({
    assertionId,
    requirementId,
    caseClass,
    caseCount,
  }))
)));

const PRIMARY = 'ledger.json';
const TEMPORARY = 'ledger.json.tmp';
const LOCK = 'ledger.lock';
const SNAPSHOT = 'ledger.snapshot.json';

class InfrastructureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InfrastructureError';
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

class SeedStream {
  #seed;
  #counter = 0;

  constructor(seed) { this.#seed = seed; }

  bytes(length) {
    const chunks = [];
    let size = 0;
    while (size < length) {
      const chunk = createHash('sha256').update(`${this.#seed}\0${this.#counter}`).digest();
      this.#counter += 1;
      chunks.push(chunk);
      size += chunk.length;
    }
    return Buffer.concat(chunks).subarray(0, length);
  }

  hex(length = 8) { return this.bytes(Math.ceil(length / 2)).toString('hex').slice(0, length); }
  int(minimum, maximum) { return minimum + (this.bytes(4).readUInt32BE(0) % (maximum - minimum + 1)); }
}

const FIXTURE_PAYLOAD_SCHEMA_VERSION = 'mini-ledger-v7/scored-fixture-payload/v1';

function fixturePayloadSchema(seed) {
  const random = new SeedStream(`${FIXTURE_PAYLOAD_SCHEMA_VERSION}\0${seed}`);
  const fields = [];
  while (fields.length < 4) {
    const field = `f_${random.hex(14)}`;
    if (!fields.includes(field)) fields.push(field);
  }
  const layout = ['flat-record', 'nested-record', 'tuple-record', 'branch-record'][random.int(0, 3)];
  return Object.freeze({
    schemaVersion: FIXTURE_PAYLOAD_SCHEMA_VERSION,
    layout,
    fields: Object.freeze(fields),
  });
}

function fixturePayload(schema, random, index) {
  const [first, second, third, fourth] = schema.fields;
  const marker = random.hex(12);
  const rank = random.int(1, 10_000);
  if (schema.layout === 'flat-record') return { [first]: index, [second]: marker, [third]: rank };
  if (schema.layout === 'nested-record') return { [first]: marker, [second]: { [third]: rank, [fourth]: index } };
  if (schema.layout === 'tuple-record') return { [first]: [marker, rank], [second]: index, [third]: index % 2 === 0 };
  return { [first]: { [second]: marker }, [third]: [{ [fourth]: rank }, index] };
}

function inputsForSeed(seed, count = 8) {
  const random = new SeedStream(seed);
  const schema = fixturePayloadSchema(seed);
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-${random.hex(10)}`,
    kind: index % 3 === 1 ? 'note' : 'task',
    payload: fixturePayload(schema, random, index),
  }));
}

function hiddenArtifact(workspace, seed, role, extension = 'json') {
  return path.join(workspace, `.v7-${sha256(`${seed}\0${role}`).slice(0, 14)}.${extension}`);
}

function seededPermutation(values, seed) {
  const random = new SeedStream(seed);
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const selected = random.int(0, index);
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

function hasCompleteConcurrentSerialization({ base, importedEvents, appendedEvents, readers, finalRows }) {
  const operations = [
    ...importedEvents.map((event, index) => ({ id: `import-${index}`, type: 'import', event })),
    ...appendedEvents.map((event, index) => ({ id: `append-${index}`, type: 'append', event })),
    ...readers.map((reader, index) => ({ id: `read-${index}`, type: 'read', ...reader })),
  ];
  const final = canonicalJson(finalRows);
  const memo = new Set();
  const visit = (state, remaining) => {
    if (remaining.length === 0) return canonicalJson(state) === final;
    const key = `${state.map(({ id }) => id).join(',')}\0${remaining.map((index) => operations[index].id).join(',')}`;
    if (memo.has(key)) return false;
    memo.add(key);
    for (const [offset, operationIndex] of remaining.entries()) {
      const operation = operations[operationIndex];
      let next = state;
      if (operation.type === 'import') next = sequenced([...base, operation.event]);
      else if (operation.type === 'append') next = [...state, { ...operation.event, sequence: state.length + 1 }];
      else {
        const projected = state.filter(({ kind }) => kind === operation.queryKind);
        if (canonicalJson(projected) !== canonicalJson(operation.rows)) continue;
      }
      const rest = [...remaining.slice(0, offset), ...remaining.slice(offset + 1)];
      if (visit(next, rest)) return true;
    }
    return false;
  };
  return visit(sequenced(base), operations.map((_, index) => index));
}

function corruptedBytes(bytes, seed) {
  const random = new SeedStream(seed);
  const mode = random.int(0, 2);
  if (mode === 0) return bytes.subarray(0, random.int(1, Math.max(1, bytes.length - 2)));
  if (mode === 1) {
    const offset = random.int(0, bytes.length);
    return Buffer.concat([bytes.subarray(0, offset), Buffer.from([0]), bytes.subarray(offset)]);
  }
  return Buffer.concat([bytes, Buffer.from(`\n#${random.hex(10)}`)]);
}

function sequenced(inputs, start = 1) {
  return inputs.map((event, index) => ({ id: event.id, kind: event.kind, payload: event.payload, sequence: start + index }));
}

function stateForInputs(inputs, overrides = {}) {
  const events = sequenced(inputs);
  return {
    schemaVersion: 'agentbattler.ledger.v2',
    generation: 0,
    lineageRootSha256: sha256(canonicalJson(events)),
    parentStateSha256: null,
    snapshotFile: null,
    snapshotSha256: null,
    events,
    batches: {},
    nextSequence: events.length + 1,
    ...overrides,
  };
}

function legacyForInputs(inputs) {
  return { schemaVersion: 'agentbattler.ledger.v1', events: inputs.map(({ id, kind, payload }) => ({ id, kind, payload })) };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
  await candidateOwnedFile(file);
}

async function resetRuntime(workspace, state) {
  const snapshotArtifacts = (await readdir(workspace))
    .filter((name) => /^\.?ledger\.snapshot(?:\.|$)/.test(name))
    .map((name) => rm(path.join(workspace, name), { force: true }));
  await Promise.all([
    rm(path.join(workspace, TEMPORARY), { force: true }),
    rm(path.join(workspace, LOCK), { force: true }),
    ...snapshotArtifacts,
  ]);
  await writeJson(path.join(workspace, PRIMARY), state);
}

async function runCandidate(workspace, args, { timeoutMs = 30_000 } = {}) {
  const entrypoint = path.join(workspace, 'bin', 'ledger.mjs');
  const invocation = candidateNativeSandboxCommand({
    workspace,
    executable: process.execPath,
    args: [entrypoint, ...args],
  });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...invocation.options,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function readTraceFiles(directory, prefix) {
  const names = (await readdir(directory)).filter((name) => name === prefix || name.startsWith(`${prefix}.`)).sort();
  const traces = [];
  for (const name of names) traces.push({ scope: name, text: await readFile(path.join(directory, name), 'utf8') });
  return traces;
}

export function buildV7StraceInjection({ syscall, occurrence }) {
  invariant([
    'fsync', 'fdatasync', 'syncfs', 'sync',
    'write', 'pwrite64', 'writev', 'pwritev', 'pwritev2',
    'rename', 'renameat', 'renameat2',
  ].includes(syscall), 'unsupported V7 crash-boundary syscall');
  invariant(Number.isSafeInteger(occurrence) && occurrence >= 1, 'V7 crash-boundary occurrence must be a positive integer');
  return `inject=${syscall}:signal=SIGKILL:when=${occurrence}`;
}

async function runTracedCandidate(workspace, args, {
  traceDirectory,
  label,
  injectSyscall = null,
  injectOccurrence = 1,
  timeoutMs = 30_000,
} = {}) {
  if (typeof traceDirectory !== 'string' || traceDirectory.length === 0) {
    throw new InfrastructureError('phase 3 requires a verifier-owned durabilityTraceDirectory');
  }
  const resolvedTraceDirectory = path.resolve(traceDirectory);
  invariant(!resolvedTraceDirectory.startsWith(`${path.resolve(workspace)}${path.sep}`), 'durability trace directory must be outside the candidate workspace');
  await mkdir(resolvedTraceDirectory, { recursive: true });
  const runDirectory = path.join(resolvedTraceDirectory, label.replace(/[^a-z0-9-]/gi, '-').toLowerCase());
  await rm(runDirectory, { recursive: true, force: true });
  await candidateOwnedDirectory(runDirectory);
  const prefix = 'trace';
  const tracePrefix = path.join(runDirectory, prefix);
  const invocation = candidateNativeSandboxCommand({
    workspace,
    executable: process.execPath,
    args: [path.join(workspace, 'bin', 'ledger.mjs'), ...args],
  });
  const straceArgs = [
    '-ff', '-qq', '-ttt', '-s', '256',
    '-e', 'trace=open,openat,openat2,creat,close,dup,dup2,dup3,fcntl,write,pwrite64,writev,pwritev,pwritev2,truncate,ftruncate,fallocate,copy_file_range,sendfile,splice,fsync,fdatasync,syncfs,sync,link,linkat,unlink,unlinkat,rename,renameat,renameat2',
    '-o', tracePrefix,
    ...(injectSyscall ? ['-e', buildV7StraceInjection({ syscall: injectSyscall, occurrence: injectOccurrence })] : []),
    invocation.command,
    ...invocation.args,
  ];
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const child = spawn('strace', straceArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...invocation.options,
      // One libuv worker makes the baseline syscall occurrence ordinal stable
      // across the replay used for deterministic fault injection.
      env: { ...invocation.options.env, UV_THREADPOOL_SIZE: '1' },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new InfrastructureError('strace is unavailable for phase-3 durability verification') : error);
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      try {
        const traces = await readTraceFiles(runDirectory, prefix);
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code !== 0 && traces.every(({ text: trace }) => trace.trim().length === 0)
          && /strace:|ptrace|operation not permitted|invalid (?:inject|system call)/i.test(stderrText)) {
          reject(new InfrastructureError(`strace could not observe the candidate process: ${stderrText.trim().slice(0, 300)}`));
          return;
        }
        resolve({
          code,
          signal,
          timedOut,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: stderrText,
          traces,
          traceWorkspace: invocation.nativeBoundary ? '/workspace' : workspace,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function unquoteSyscallPaths(argumentsText) {
  return [...argumentsText.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1].replaceAll('\\"', '"'));
}

export function analyzeV7DurabilityTrace(input, { workspace = '', scopeGroups = {} } = {}) {
  const traces = typeof input === 'string' ? [{ scope: 'trace', text: input }] : input;
  invariant(Array.isArray(traces) && traces.length > 0, 'durability trace is empty');
  const records = [];
  for (const { scope, text } of traces) {
    for (const [order, raw] of String(text).split('\n').entries()) {
      const match = /^\s*(\d+(?:\.\d+)?)\s+(.*)$/.exec(raw);
      if (match) records.push({ scope, time: Number(match[1]), order, line: match[2] });
      else if (raw.trim()) records.push({ scope, time: Number.MAX_SAFE_INTEGER, order, line: raw.trim() });
    }
  }
  records.sort((left, right) => left.time - right.time || left.scope.localeCompare(right.scope) || left.order - right.order);
  const descriptors = new Map();
  const barriers = [];
  const renames = [];
  const writes = [];
  const mutations = [];
  const barrierAttempts = [];
  const writeAttempts = [];
  const mutationAttempts = [];
  const renameAttempts = [];
  const linkAttempts = [];
  const unlinkAttempts = [];
  const occurrences = new Map();
  const pathArtifacts = new Map();
  let artifactSequence = 0;
  const resolvedPath = (target) => path.resolve(workspace || '.', target);
  const newArtifact = () => `artifact-${artifactSequence += 1}`;
  const artifactForPath = (target, { replace = false } = {}) => {
    const resolved = resolvedPath(target);
    if (replace || !pathArtifacts.has(resolved)) pathArtifacts.set(resolved, newArtifact());
    return pathArtifacts.get(resolved);
  };
  const successfulZero = (result = '') => /^0(?:\s|$)/.test(result);
  const successfulBytes = (result = '') => /^[1-9]\d*(?:\s|$)/.test(result);
  const recordMutation = (attempt, succeeded) => {
    const frozen = { ...attempt, succeeded };
    mutationAttempts.push(frozen);
    if (succeeded) mutations.push(frozen);
    return frozen;
  };
  for (const [index, record] of records.entries()) {
    // libuv may open, sync, rename, and close one descriptor on different
    // worker threads. File descriptors are process-wide, so correlate them
    // across strace -ff TIDs. Callers tracing permitted child processes must
    // supply scopeGroups to keep each process fd table separate; V7 candidate
    // children are denied by the Node permission model.
    const key = (fd) => `${scopeGroups[record.scope] ?? 'candidate'}:${fd}`;
    const syscall = /^(\w+)\(/.exec(record.line)?.[1] ?? null;
    const occurrenceKey = syscall ? `${record.scope}:${syscall}` : null;
    const occurrence = occurrenceKey ? (occurrences.get(occurrenceKey) ?? 0) + 1 : null;
    if (occurrenceKey) occurrences.set(occurrenceKey, occurrence);
    const open = /^(open|openat|openat2)\((.*)\)\s+=\s+(\d+)$/.exec(record.line);
    if (open) {
      const paths = unquoteSyscallPaths(open[2]);
      if (paths.length > 0) {
        const target = paths.at(-1);
        const anonymous = /(?:^|[|{, ])O_TMPFILE(?:[|}, ]|$)/.test(open[2]);
        const createsNew = anonymous || (
          /(?:^|[|{, ])O_CREAT(?:[|}, ]|$)/.test(open[2])
          && /(?:^|[|{, ])O_EXCL(?:[|}, ]|$)/.test(open[2])
        );
        const descriptor = {
          path: anonymous ? `${target}/<anonymous-${open[3]}>` : target,
          artifactId: anonymous ? newArtifact() : artifactForPath(target, { replace: createsNew }),
          synchronousWrites: /(?:^|[|{, ])O_(?:D?SYNC)(?:[|}, ]|$)/.test(open[2]),
        };
        descriptors.set(key(open[3]), descriptor);
        if (/(?:^|[|{, ])O_TRUNC(?:[|}, ]|$)/.test(open[2])) recordMutation({
          index,
          scope: record.scope,
          occurrence,
          syscall: open[1],
          mutation: 'truncate-on-open',
          path: descriptor.path,
          artifactId: descriptor.artifactId,
          synchronous: false,
        }, true);
      }
      continue;
    }
    const creat = /^creat\((.*)\)\s+=\s+(\d+)$/.exec(record.line);
    if (creat) {
      const paths = unquoteSyscallPaths(creat[1]);
      if (paths.length > 0) {
        const target = paths.at(-1);
        const descriptor = {
          path: target,
          artifactId: artifactForPath(target),
          synchronousWrites: false,
        };
        descriptors.set(key(creat[2]), descriptor);
        recordMutation({
          index,
          scope: record.scope,
          occurrence,
          syscall: 'creat',
          mutation: 'truncate-on-open',
          path: descriptor.path,
          artifactId: descriptor.artifactId,
          synchronous: false,
        }, true);
      }
      continue;
    }
    const duplicate = /^(dup|dup2|dup3)\((\d+)(?:,\s*(\d+))?.*\)\s+=\s+(\d+)$/.exec(record.line);
    if (duplicate) {
      const descriptor = descriptors.get(key(duplicate[2]));
      if (descriptor) descriptors.set(key(duplicate[4]), descriptor);
      continue;
    }
    const fcntlDuplicate = /^fcntl\((\d+),\s*F_DUPFD(?:_CLOEXEC)?(?:,.*)?\)\s+=\s+(\d+)$/.exec(record.line);
    if (fcntlDuplicate) {
      const descriptor = descriptors.get(key(fcntlDuplicate[1]));
      if (descriptor) descriptors.set(key(fcntlDuplicate[2]), descriptor);
      continue;
    }
    const close = /^close\((\d+)\)/.exec(record.line);
    if (close) {
      descriptors.delete(key(close[1]));
      continue;
    }
    const barrier = /^(fdatasync|fsync)\((\d+)\)(?:\s+=\s+(.*))?/.exec(record.line);
    if (barrier) {
      const descriptor = descriptors.get(key(barrier[2]));
      const attempt = {
        index,
        scope: record.scope,
        occurrence,
        syscall: barrier[1],
        path: descriptor?.path ?? null,
        artifactId: descriptor?.artifactId ?? null,
        succeeded: successfulZero(barrier[3]),
      };
      barrierAttempts.push(attempt);
      if (attempt.succeeded) barriers.push(attempt);
      continue;
    }
    const mountBarrier = /^syncfs\((\d+)\)(?:\s+=\s+(.*))?/.exec(record.line);
    if (mountBarrier) {
      const descriptor = descriptors.get(key(mountBarrier[1]));
      const attempt = {
        index,
        scope: record.scope,
        occurrence,
        syscall: 'syncfs',
        path: descriptor?.path ?? null,
        artifactId: descriptor?.artifactId ?? null,
        succeeded: successfulZero(mountBarrier[2]),
        mountWide: true,
      };
      barrierAttempts.push(attempt);
      if (attempt.succeeded) barriers.push(attempt);
      continue;
    }
    const globalBarrier = /^sync\(\)(?:\s+=\s+(.*))?/.exec(record.line);
    if (globalBarrier) {
      const attempt = {
        index,
        scope: record.scope,
        occurrence,
        syscall: 'sync',
        path: null,
        artifactId: null,
        succeeded: successfulZero(globalBarrier[1]),
        mountWide: true,
        global: true,
      };
      barrierAttempts.push(attempt);
      if (attempt.succeeded) barriers.push(attempt);
      continue;
    }
    const write = /^(write|pwrite64|writev|pwritev|pwritev2)\((\d+),(.*)\)\s+=\s+(.*)$/.exec(record.line);
    if (write) {
      const descriptor = descriptors.get(key(write[2]));
      const attempt = recordMutation({
        index,
        scope: record.scope,
        occurrence,
        syscall: write[1],
        mutation: 'write',
        path: descriptor?.path ?? null,
        artifactId: descriptor?.artifactId ?? null,
        synchronous: descriptor?.synchronousWrites === true
          || (write[1] === 'pwritev2' && /RWF_(?:D?SYNC)/.test(write[3])),
      }, successfulBytes(write[4]));
      writeAttempts.push(attempt);
      if (attempt.succeeded) writes.push(attempt);
      continue;
    }
    const descriptorMutation = /^(ftruncate|fallocate)\((\d+),(.*)\)\s+=\s+(.*)$/.exec(record.line);
    if (descriptorMutation) {
      const flags = descriptorMutation[1] === 'fallocate' ? descriptorMutation[3].split(',')[0] : '';
      const changesContent = descriptorMutation[1] !== 'fallocate'
        || !/FALLOC_FL_KEEP_SIZE/.test(flags)
        || /FALLOC_FL_(?:PUNCH_HOLE|ZERO_RANGE|COLLAPSE_RANGE|INSERT_RANGE)/.test(flags);
      if (changesContent) {
        const descriptor = descriptors.get(key(descriptorMutation[2]));
        recordMutation({
          index,
          scope: record.scope,
          occurrence,
          syscall: descriptorMutation[1],
          mutation: descriptorMutation[1],
          path: descriptor?.path ?? null,
          artifactId: descriptor?.artifactId ?? null,
          synchronous: false,
        }, successfulZero(descriptorMutation[4]));
      }
      continue;
    }
    const pathTruncate = /^truncate\((.*)\)\s+=\s+(.*)$/.exec(record.line);
    if (pathTruncate) {
      const paths = unquoteSyscallPaths(pathTruncate[1]);
      const target = paths.at(-1) ?? null;
      recordMutation({
        index,
        scope: record.scope,
        occurrence,
        syscall: 'truncate',
        mutation: 'truncate',
        path: target,
        artifactId: target ? artifactForPath(target) : null,
        synchronous: false,
      }, successfulZero(pathTruncate[2]));
      continue;
    }
    const copied = /^copy_file_range\((\d+),\s*(?:NULL|\[[^\]]*\]),\s*(\d+),.*\)\s+=\s+(.*)$/.exec(record.line);
    if (copied) {
      const descriptor = descriptors.get(key(copied[2]));
      recordMutation({
        index,
        scope: record.scope,
        occurrence,
        syscall: 'copy_file_range',
        mutation: 'copy',
        path: descriptor?.path ?? null,
        artifactId: descriptor?.artifactId ?? null,
        synchronous: false,
      }, successfulBytes(copied[3]));
      continue;
    }
    const sent = /^sendfile\((\d+),\s*\d+,.*\)\s+=\s+(.*)$/.exec(record.line);
    if (sent) {
      const descriptor = descriptors.get(key(sent[1]));
      recordMutation({
        index,
        scope: record.scope,
        occurrence,
        syscall: 'sendfile',
        mutation: 'copy',
        path: descriptor?.path ?? null,
        artifactId: descriptor?.artifactId ?? null,
        synchronous: false,
      }, successfulBytes(sent[2]));
      continue;
    }
    const spliced = /^splice\(\d+,\s*(?:NULL|\[[^\]]*\]),\s*(\d+),.*\)\s+=\s+(.*)$/.exec(record.line);
    if (spliced) {
      const descriptor = descriptors.get(key(spliced[1]));
      recordMutation({
        index,
        scope: record.scope,
        occurrence,
        syscall: 'splice',
        mutation: 'copy',
        path: descriptor?.path ?? null,
        artifactId: descriptor?.artifactId ?? null,
        synchronous: false,
      }, successfulBytes(spliced[2]));
      continue;
    }
    const link = /^(link|linkat)\((.*)\)(?:\s+=\s+(.*))?/.exec(record.line);
    if (link) {
      const paths = unquoteSyscallPaths(link[2]);
      if (paths.length >= 2) {
        const emptyPathDescriptor = link[1] === 'linkat' && /AT_EMPTY_PATH/.test(link[2])
          ? descriptors.get(key(/^(\d+),/.exec(link[2])?.[1]))
          : null;
        const from = emptyPathDescriptor?.path ?? paths.at(-2);
        const to = paths.at(-1);
        const attempt = {
          index,
          scope: record.scope,
          occurrence,
          syscall: link[1],
          from,
          to,
          artifactId: emptyPathDescriptor?.artifactId ?? artifactForPath(from),
          succeeded: successfulZero(link[3]),
        };
        linkAttempts.push(attempt);
        if (attempt.succeeded) pathArtifacts.set(resolvedPath(to), attempt.artifactId);
      }
      continue;
    }
    const unlink = /^(unlink|unlinkat)\((.*)\)(?:\s+=\s+(.*))?/.exec(record.line);
    if (unlink) {
      const paths = unquoteSyscallPaths(unlink[2]);
      if (paths.length > 0) {
        const attempt = {
          index,
          scope: record.scope,
          occurrence,
          syscall: unlink[1],
          path: paths.at(-1),
          succeeded: successfulZero(unlink[3]),
        };
        unlinkAttempts.push(attempt);
        if (attempt.succeeded) pathArtifacts.delete(resolvedPath(attempt.path));
      }
      continue;
    }
    const rename = /^(rename|renameat|renameat2)\((.*)\)(?:\s+=\s+(.*))?/.exec(record.line);
    if (rename) {
      const paths = unquoteSyscallPaths(rename[2]);
      if (paths.length >= 2) {
        const from = paths.at(-2);
        const to = paths.at(-1);
        const exchange = rename[1] === 'renameat2' && /RENAME_EXCHANGE/.test(rename[2]);
        const replacedArtifactId = exchange ? artifactForPath(to) : null;
        const attempt = {
          index,
          scope: record.scope,
          occurrence,
          syscall: rename[1],
          from,
          to,
          artifactId: artifactForPath(from),
          exchange,
          succeeded: successfulZero(rename[3]),
        };
        renameAttempts.push(attempt);
        if (attempt.succeeded) {
          renames.push(attempt);
          pathArtifacts.set(resolvedPath(to), attempt.artifactId);
          if (exchange) pathArtifacts.set(resolvedPath(from), replacedArtifactId);
          else pathArtifacts.delete(resolvedPath(from));
        }
      }
    }
  }
  const root = path.resolve(workspace || '.');
  const boundary = (attempt, fields) => attempt ? Object.freeze({
    ...fields,
    syscall: attempt.syscall,
    scope: attempt.scope,
    occurrence: attempt.occurrence,
    index: attempt.index,
  }) : null;
  const publicationProof = (published) => {
    const insideRoot = (target) => {
      if (typeof target !== 'string') return false;
      const resolved = resolvedPath(target);
      return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    };
    const samePublishedArtifact = ({ artifactId }) => (
      published && typeof artifactId === 'string' && artifactId === published.artifactId
    );
    const explicitDataBarriers = published ? barriers.filter((attempt) => (
      attempt.index < published.index
      && (attempt.global === true || (attempt.mountWide === true && insideRoot(attempt.path)) || samePublishedArtifact(attempt))
    )) : [];
    const synchronousDataWrites = published ? mutations.filter((attempt) => (
      attempt.synchronous === true && attempt.index < published.index && samePublishedArtifact(attempt)
    )) : [];
    const before = [...explicitDataBarriers, ...synchronousDataWrites]
      .sort((left, right) => left.index - right.index)
      .at(-1);
    // A barrier is evidence only when the publication inode was actually
    // mutated first. Every later mutation (including truncate/copy aliases and
    // writes through an fd retained across rename) invalidates that proof.
    const mutationBeforeDataBarrier = published && before && mutations.some((attempt) => (
      attempt.index <= before.index && samePublishedArtifact(attempt)
    ));
    const mutationAfterDataBarrier = published && before && mutations.some((attempt) => (
      attempt.index > before.index && attempt.index < published.index && samePublishedArtifact(attempt)
    ));
    const after = published && barriers.find((attempt) => {
      if (attempt.index <= published.index) return false;
      if (attempt.global === true || (attempt.mountWide === true && insideRoot(attempt.path))) return true;
      if (typeof attempt.path !== 'string') return false;
      const resolved = resolvedPath(attempt.path);
      return attempt.path === '.' || resolved === root || resolved === path.dirname(resolvedPath(published.to));
    });
    const mutationAfterPublication = published && mutations.some((attempt) => (
      attempt.index > published.index && samePublishedArtifact(attempt)
    ));
    const removedBeforePublication = published && unlinkAttempts.some(({ index, path: target, succeeded }) => (
      succeeded && index < published.index && resolvedPath(target) === resolvedPath(published.to)
    ));
    const publication = boundary(published, published ? { from: published.from, to: published.to } : {});
    const directoryBarrier = boundary(after, after ? { path: after.path } : {});
    return Object.freeze({
      target: published ? resolvedPath(published.to) : null,
      stable: Boolean(
        published
        && before
        && mutationBeforeDataBarrier
        && after
        && !mutationAfterDataBarrier
        && !mutationAfterPublication
        && !removedBeforePublication
      ),
      dataBarrier: boundary(before, before ? { path: before.path } : {}),
      rename: publication,
      publication,
      directoryBarrier,
      publicationOrder: published?.index ?? null,
      directoryBarrierOrder: after?.index ?? null,
    });
  };
  const primaryTarget = path.join(root, PRIMARY);
  const primaryRename = renames.filter(({ to }) => resolvedPath(to) === primaryTarget).at(-1);
  const primaryProof = publicationProof(primaryRename);
  const snapshotPublications = renames
    .filter(({ to }) => {
      const resolved = resolvedPath(to);
      const basename = path.basename(resolved);
      return path.dirname(resolved) === root && /^ledger\.snapshot(?:\.[^/]+)*\.json$/.test(basename);
    })
    .map(publicationProof);
  return Object.freeze({
    ...primaryProof,
    snapshotPublications: Object.freeze(snapshotPublications),
    barrierAttempts: Object.freeze(barrierAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    writeAttempts: Object.freeze(writeAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    mutationAttempts: Object.freeze(mutationAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    renameAttempts: Object.freeze(renameAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    publicationAttempts: Object.freeze(renameAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    linkAttempts: Object.freeze(linkAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    unlinkAttempts: Object.freeze(unlinkAttempts.map((attempt) => Object.freeze({ ...attempt }))),
    syscallCount: records.length,
  });
}

function successful(result, label) {
  invariant(result.code === 0 && !result.signal && !result.timedOut, `${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  let value;
  try { value = JSON.parse(result.stdout.trim()); } catch (error) { throw new Error(`${label} did not emit one JSON value: ${error.message}`); }
  return value;
}

function failed(result, label) {
  invariant(!result.timedOut && (result.code !== 0 || result.signal), `${label} unexpectedly succeeded`);
}

async function readState(workspace) {
  return JSON.parse(await readFile(path.join(workspace, PRIMARY), 'utf8'));
}

async function logicalEvents(workspace, state) {
  const current = state ?? await readState(workspace);
  if (!current.snapshotFile) return current.events;
  const snapshot = JSON.parse(await readFile(path.join(workspace, current.snapshotFile), 'utf8'));
  return [...snapshot.events, ...current.events];
}

function assertEvents(actual, expected) {
  invariant(actual.length === expected.length, `expected ${expected.length} events, found ${actual.length}`);
  for (const [index, event] of actual.entries()) {
    const wanted = expected[index];
    invariant(event.id === wanted.id && event.kind === wanted.kind, `event ${index + 1} identity differs`);
    invariant(event.sequence === (wanted.sequence ?? index + 1), `event ${event.id} has sequence ${event.sequence}`);
    invariant(canonicalJson(event.payload) === canonicalJson(wanted.payload), `event ${event.id} payload differs`);
  }
}

async function runtimeDigest(workspace) {
  const digest = createHash('sha256');
  for (const relative of [PRIMARY, TEMPORARY, SNAPSHOT, LOCK]) {
    try {
      digest.update(relative);
      digest.update('\0');
      digest.update(await readFile(path.join(workspace, relative)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      digest.update(`${relative}\0<missing>`);
    }
  }
  return digest.digest('hex');
}

async function workspaceStateDigest(workspace, { verifierOwnedArtifacts = [] } = {}) {
  const root = path.resolve(workspace);
  const excluded = new Set(verifierOwnedArtifacts.map((artifact) => {
    const resolved = path.resolve(artifact);
    invariant(resolved.startsWith(`${root}${path.sep}`), 'verifier-owned artifact escapes the workspace');
    return resolved;
  }));
  const digest = createHash('sha256');
  const visit = async (absolute, relative) => {
    if (excluded.has(absolute)) return;
    const metadata = await lstat(absolute);
    const mode = metadata.mode & 0o7777;
    if (metadata.isDirectory()) {
      digest.update(`directory\0${relative}\0${mode.toString(8)}\0`);
      const entries = (await readdir(absolute)).sort();
      for (const entry of entries) await visit(path.join(absolute, entry), relative ? path.posix.join(relative, entry) : entry);
      return;
    }
    if (metadata.isFile()) {
      digest.update(`file\0${relative}\0${mode.toString(8)}\0${metadata.size}\0`);
      digest.update(await readFile(absolute));
      digest.update('\0');
      return;
    }
    if (metadata.isSymbolicLink()) {
      digest.update(`symlink\0${relative}\0${mode.toString(8)}\0${await readlink(absolute)}\0`);
      return;
    }
    const type = metadata.isBlockDevice() ? 'block-device'
      : metadata.isCharacterDevice() ? 'character-device'
        : metadata.isFIFO() ? 'fifo'
          : metadata.isSocket() ? 'socket'
            : 'other';
    digest.update(`${type}\0${relative}\0${mode.toString(8)}\0`);
  };
  for (const entry of (await readdir(root)).sort()) await visit(path.join(root, entry), entry);
  return digest.digest('hex');
}

async function queryAfter(workspace, kind, afterSequence = 0, limit = 100_000) {
  return successful(await runCandidate(workspace, ['query', '--kind', kind, '--after-sequence', String(afterSequence), '--limit', String(limit)]), 'query');
}

async function append(workspace, event) {
  return successful(await runCandidate(workspace, ['append', '--id', event.id, '--kind', event.kind, '--payload', JSON.stringify(event.payload)]), 'append');
}

async function check(requirement, operation) {
  const evaluate = async (candidate) => {
    try {
      await candidate();
      return { passed: true, diagnostic: null, infrastructureError: false };
    } catch (error) {
      return {
        passed: false,
        diagnostic: String(error.message).slice(0, 500),
        infrastructureError: error instanceof InfrastructureError,
      };
    }
  };
  const common = { id: requirement.id, family: requirement.family, group: requirement.group, weight: requirement.weight };
  const assertion = V7_VERIFIER_ASSERTIONS[requirement.id];
  invariant(assertion, `${requirement.id} has no executable verifier assertion catalog entry`);
  if (requirement.group === 'public') {
    invariant(typeof operation === 'function', `${requirement.id} public verification is not executable`);
    const outcome = await evaluate(operation);
    return {
      ...common,
      ...assertion.public,
      points: outcome.passed ? requirement.weight : 0,
      passed: outcome.passed,
      diagnostic: outcome.diagnostic,
      ...(outcome.infrastructureError ? { infrastructureError: true } : {}),
    };
  }
  invariant(operation && typeof operation.atomic === 'function' && typeof operation.composed === 'function', `${requirement.id} must independently execute atomic and composed cases`);
  const atomic = await evaluate(operation.atomic);
  const composed = await evaluate(operation.composed);
  const classes = Object.fromEntries([['atomic', atomic], ['composed', composed]].map(([id, outcome]) => {
    const weight = requirement.privateClassWeights[id];
    return [id, {
      ...assertion[id],
      weight,
      points: outcome.passed ? weight : 0,
      passed: outcome.passed,
      diagnostic: outcome.diagnostic,
    }];
  }));
  const points = classes.atomic.points + classes.composed.points;
  const failedDiagnostics = Object.entries(classes).filter(([, value]) => !value.passed).map(([id, value]) => `${id}: ${value.diagnostic}`);
  return {
    ...common,
    points,
    passed: points === requirement.weight,
    diagnostic: failedDiagnostics.length > 0 ? failedDiagnostics.join('; ').slice(0, 500) : null,
    classes,
    ...(atomic.infrastructureError || composed.infrastructureError ? { infrastructureError: true } : {}),
  };
}

function requirementsForPhase(phase) {
  return V7_REQUIREMENTS.filter((requirement) => requirement.phase === phase);
}

async function verifyMigration(workspace, seed) {
  const requirements = requirementsForPhase(1);
  const migrationValues = new SeedStream(`${seed}:migration-payload-values`);
  const inputs = inputsForSeed(seed, 6).map((event, index) => ({
    ...event,
    payload: [
      event.payload,
      [migrationValues.hex(12), migrationValues.int(1, 10_000)],
      migrationValues.hex(12),
      migrationValues.int(1, 10_000),
      index % 2 === 0,
      null,
    ][index],
  }));
  await resetRuntime(workspace, legacyForInputs(inputs));
  const checks = [];
  checks.push(await check(requirements[0], async () => {
    const got = successful(await runCandidate(workspace, ['get', '--id', inputs.at(-1).id]), 'legacy get');
    invariant(got.sequence === inputs.length && got.kind === inputs.at(-1).kind, 'legacy migration changed ordering');
    const state = await readState(workspace);
    invariant(state.schemaVersion === 'agentbattler.ledger.v2' && state.nextSequence === inputs.length + 1, 'legacy state was not normalized to v2');
    assertEvents(await logicalEvents(workspace, state), inputs);
  }));
  checks.push(await check(requirements[1], {
    atomic: async () => {
      await resetRuntime(workspace, legacyForInputs(inputs));
      const extra = inputsForSeed(`${seed}:compat-atomic`, 1)[0];
      await append(workspace, extra);
      const got = successful(await runCandidate(workspace, ['get', '--id', extra.id]), 'post-migration get');
      invariant(got.id === extra.id, 'post-migration get compatibility failed');
      const taskRows = await queryAfter(workspace, 'task');
      invariant(Array.isArray(taskRows) && taskRows.some(({ id }) => id === extra.id), 'legacy query compatibility failed');
    },
    composed: async () => {
      await resetRuntime(workspace, legacyForInputs(inputs));
      const extra = inputsForSeed(`${seed}:compat-composed`, 1)[0];
      await append(workspace, extra);
      const exportPath = hiddenArtifact(workspace, seed, 'phase1-export');
      successful(await runCandidate(workspace, ['export', exportPath]), 'export');
      const exported = JSON.parse(await readFile(exportPath, 'utf8'));
      await resetRuntime(workspace, stateForInputs([]));
      successful(await runCandidate(workspace, ['import', exportPath]), 're-import');
      assertEvents(await logicalEvents(workspace), [...inputs, extra]);
      invariant(exported.schemaVersion === 'agentbattler.ledger.v2', 'export did not preserve v2 schema');
    },
  }));
  checks.push(await check(requirements[2], {
    atomic: async () => {
      await resetRuntime(workspace, stateForInputs(inputs));
      const before = await runtimeDigest(workspace);
      const marker = new SeedStream(`${seed}:invalid-atomic`).hex(8);
      const nearbyVersion = 4 + Number.parseInt(marker.slice(0, 2), 16) % 6;
      const unknownSchemas = [
        'agentbattler.ledger.v3',
        `agentbattler.ledger.v${nearbyVersion}`,
        `agentbattler.ledger.v1-${marker.slice(2)}`,
      ];
      for (const [index, schemaVersion] of unknownSchemas.entries()) {
        const file = hiddenArtifact(workspace, seed, `phase1-unknown-${index}`);
        await writeJson(file, { schemaVersion, events: [] });
        failed(await runCandidate(workspace, ['import', file]), `unknown schema import ${index}`);
        invariant(await runtimeDigest(workspace) === before, `unknown schema import ${index} mutated runtime state`);
      }
    },
    composed: async () => {
      await resetRuntime(workspace, stateForInputs(inputs));
      const before = await runtimeDigest(workspace);
      const legacy = (events) => Buffer.from(`${JSON.stringify({ schemaVersion: 'agentbattler.ledger.v1', events })}\n`);
      for (const [role, bytes] of [
        ['duplicate', legacy([{ ...inputs[0] }, { ...inputs[0] }])],
        ['missing-payload', legacy([{ id: inputs[0].id, kind: inputs[0].kind }])],
        ['malformed-json', Buffer.from('{"schemaVersion":"agentbattler.ledger.v1","events":[')],
        ['events-not-array', Buffer.from(`${JSON.stringify({ schemaVersion: 'agentbattler.ledger.v1', events: { first: inputs[0] } })}\n`)],
        ['event-not-object', legacy([null])],
        ['invalid-id', legacy([{ id: 7, kind: inputs[0].kind, payload: inputs[0].payload }])],
        ['invalid-kind', legacy([{ id: inputs[0].id, kind: [], payload: inputs[0].payload }])],
      ]) {
        const file = hiddenArtifact(workspace, seed, `phase1-${role}`);
        await writeFile(file, bytes);
        await candidateOwnedFile(file);
        failed(await runCandidate(workspace, ['import', file]), `invalid import ${role}`);
        invariant(await runtimeDigest(workspace) === before, `${role} import mutated runtime state`);
      }
    },
  }));
  return checks;
}

async function verifyBatchPagination(workspace, seed) {
  const requirements = requirementsForPhase(2);
  const initial = inputsForSeed(seed, 3);
  await resetRuntime(workspace, stateForInputs(initial));
  const variant = new SeedStream(`${seed}:shape`);
  const batch = inputsForSeed(`${seed}:batch`, variant.int(7, 12));
  const batchPath = hiddenArtifact(workspace, seed, 'phase2-batch');
  const idempotencyKey = `key-${variant.hex(12)}`;
  await writeJson(batchPath, batch);
  const checks = [];
  checks.push(await check(requirements[0], async () => {
    const result = successful(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'append-batch');
    invariant(result.ok === true || result.count === batch.length, 'batch success was not explicit');
    assertEvents(await logicalEvents(workspace), [...initial, ...batch]);
  }));
  checks.push(await check(requirements[1], async () => {
    const first = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', '2']), 'cursor query');
    invariant(Array.isArray(first.items) && first.items.length === 2, 'first cursor page is invalid');
    invariant(typeof first.nextCursor === 'string' && first.nextCursor.length > 0, 'cursor is not an opaque string capability');

    const beforeInvalidLimits = await runtimeDigest(workspace);
    for (const value of ['0', '-1', '+1', '01', ' 1', '1 ', '1.0', '1e1', String(Number.MAX_SAFE_INTEGER + 1)]) {
      failed(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', value]), `non-canonical cursor limit ${JSON.stringify(value)}`);
      invariant(await runtimeDigest(workspace) === beforeInvalidLimits, `invalid limit ${JSON.stringify(value)} mutated runtime state`);
    }
  }));
  checks.push(await check(requirements[2], {
    atomic: async () => {
      await resetRuntime(workspace, stateForInputs(initial));
      await writeJson(batchPath, batch);
      successful(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'atomic batch');
      const verifierOwnedArtifacts = [batchPath];
      const before = await workspaceStateDigest(workspace, { verifierOwnedArtifacts });
      const retry = successful(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'batch retry');
      invariant(retry.idempotent === true || retry.alreadyApplied === true || retry.status === 'idempotent', 'batch retry was not explicitly idempotent');
      invariant(await workspaceStateDigest(workspace, { verifierOwnedArtifacts }) === before, 'identical batch retry changed workspace state');
    },
    composed: async () => {
      await resetRuntime(workspace, stateForInputs(initial));
      await writeJson(batchPath, batch);
      successful(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'composed batch');
      const semanticallyIdenticalDifferentBytes = Buffer.from(`${JSON.stringify(batch, null, 2)}\n`);
      await writeFile(batchPath, semanticallyIdenticalDifferentBytes);
      await candidateOwnedFile(batchPath);
      let verifierOwnedArtifacts = [batchPath];
      let beforeInvalid = await workspaceStateDigest(workspace, { verifierOwnedArtifacts });
      failed(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'different-byte idempotency-key collision');
      invariant(await workspaceStateDigest(workspace, { verifierOwnedArtifacts }) === beforeInvalid, 'different-byte key collision changed workspace state');
      const collision = [...batch, ...inputsForSeed(`${seed}:collision`, 1)];
      await writeJson(batchPath, collision);
      verifierOwnedArtifacts = [batchPath];
      beforeInvalid = await workspaceStateDigest(workspace, { verifierOwnedArtifacts });
      failed(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'idempotency-key collision');
      invariant(await workspaceStateDigest(workspace, { verifierOwnedArtifacts }) === beforeInvalid, 'key collision changed workspace state');
      const partialValid = inputsForSeed(`${seed}:partially-invalid-valid-members`, 2);
      const malformedCases = [
        ['malformed-json', Buffer.from('[{"id":')],
        ['not-an-array', Buffer.from(`${JSON.stringify({ event: batch[0] })}\n`)],
        ['partially-invalid', Buffer.from(`${JSON.stringify([partialValid[0], { id: `invalid-${variant.hex(6)}`, kind: 'task' }, partialValid[1]])}\n`)],
        ['duplicate-inside-batch', Buffer.from(`${JSON.stringify([batch[0], { ...batch[0] }])}\n`)],
        ['duplicate-canonical-id', Buffer.from(`${JSON.stringify([{ ...batch[0], id: initial[0].id }])}\n`)],
      ];
      for (const [label, bytes] of malformedCases) {
        const invalidPath = hiddenArtifact(workspace, seed, `phase2-${label}`);
        await writeFile(invalidPath, bytes);
        await candidateOwnedFile(invalidPath);
        verifierOwnedArtifacts = [batchPath, invalidPath];
        beforeInvalid = await workspaceStateDigest(workspace, { verifierOwnedArtifacts });
        failed(await runCandidate(workspace, ['append-batch', '--file', invalidPath, '--idempotency-key', `invalid-${label}-${variant.hex(6)}`]), `invalid batch ${label}`);
        invariant(await workspaceStateDigest(workspace, { verifierOwnedArtifacts }) === beforeInvalid, `${label} batch changed workspace state`);
      }
    },
  }));
  checks.push(await check(requirements[3], {
    atomic: async () => {
      await resetRuntime(workspace, stateForInputs(initial));
      await writeJson(batchPath, batch);
      successful(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'pagination batch');
      const seen = [];
      let cursor = null;
      do {
        const args = ['query', '--kind', 'task', '--limit', '2'];
        if (cursor) args.push('--cursor', cursor);
        const page = successful(await runCandidate(workspace, args), 'cursor page');
        invariant(Array.isArray(page.items), 'cursor page has no items array');
        seen.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      invariant(cursor === null, 'terminal cursor page did not return nextCursor: null');
      assertEvents(seen, (await logicalEvents(workspace)).filter(({ kind }) => kind === 'task'));
      const first = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', '1']), 'cursor binding setup');
      invariant(typeof first.nextCursor === 'string', 'cursor binding setup did not create a continuation');
      let beforeInvalidCursor = await workspaceStateDigest(workspace);
      failed(await runCandidate(workspace, ['query', '--kind', 'note', '--cursor', first.nextCursor, '--limit', '1']), 'cross-kind cursor');
      invariant(await workspaceStateDigest(workspace) === beforeInvalidCursor, 'cross-kind cursor failure mutated workspace state');
      const position = new SeedStream(`${seed}:cursor-tamper`).int(0, first.nextCursor.length - 1);
      const original = first.nextCursor[position];
      const tampered = `${first.nextCursor.slice(0, position)}${original === 'A' ? 'B' : 'A'}${first.nextCursor.slice(position + 1)}`;
      beforeInvalidCursor = await workspaceStateDigest(workspace);
      failed(await runCandidate(workspace, ['query', '--kind', 'task', '--cursor', tampered, '--limit', '1']), 'tampered cursor');
      invariant(await workspaceStateDigest(workspace) === beforeInvalidCursor, 'tampered cursor failure mutated workspace state');
      const malformed = `invalid-${new SeedStream(`${seed}:cursor-malformed`).hex(18)}`;
      beforeInvalidCursor = await workspaceStateDigest(workspace);
      failed(await runCandidate(workspace, ['query', '--kind', 'task', '--cursor', malformed, '--limit', '1']), 'malformed cursor');
      invariant(await workspaceStateDigest(workspace) === beforeInvalidCursor, 'malformed cursor failure mutated workspace state');
    },
    composed: async () => {
      await resetRuntime(workspace, stateForInputs(initial));
      await writeJson(batchPath, batch);
      successful(await runCandidate(workspace, ['append-batch', '--file', batchPath, '--idempotency-key', idempotencyKey]), 'boundary batch');
      const first = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', '1']), 'boundary cursor setup');
      invariant(typeof first.nextCursor === 'string', 'boundary cursor setup did not create a continuation');
      const boundaryEvents = (await logicalEvents(workspace)).filter(({ kind }) => kind === 'task');
      const matchingAfterBoundary = { ...inputsForSeed(`${seed}:after-cursor-boundary`, 1)[0], kind: 'task' };
      await append(workspace, matchingAfterBoundary);
      const continued = [];
      let stableCursor = first.nextCursor;
      while (stableCursor) {
        const page = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--cursor', stableCursor, '--limit', '1']), 'stable-boundary cursor');
        continued.push(...page.items);
        stableCursor = page.nextCursor;
      }
      invariant(stableCursor === null, 'stable-boundary terminal page did not return nextCursor: null');
      assertEvents([...first.items, ...continued], boundaryEvents);
      const preCompactionEvents = (await logicalEvents(workspace)).filter(({ kind }) => kind === 'task');
      const preCompaction = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', '1']), 'pre-compaction cursor setup');
      invariant(typeof preCompaction.nextCursor === 'string', 'pre-compaction cursor setup did not create a continuation');
      successful(await runCandidate(workspace, ['compact', '--keep', '2']), 'cursor-preserving compaction');
      const afterCompaction = [...preCompaction.items];
      let compactionCursor = preCompaction.nextCursor;
      while (compactionCursor) {
        const page = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--cursor', compactionCursor, '--limit', '1']), 'pre-compaction cursor continuation');
        afterCompaction.push(...page.items);
        compactionCursor = page.nextCursor;
      }
      invariant(compactionCursor === null, 'pre-compaction cursor terminal page did not return nextCursor: null');
      assertEvents(afterCompaction, preCompactionEvents);
      const stale = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', '1']), 'stale-lineage cursor setup');
      const current = await logicalEvents(workspace);
      const currentState = await readState(workspace);
      const changed = current.map(({ id, kind, payload }) => ({ id, kind, payload }));
      changed[0] = { ...changed[0], payload: inputsForSeed(`${seed}:history-boundary-payload`, 1)[0].payload };
      const replacementPath = hiddenArtifact(workspace, seed, 'phase2-boundary-replacement');
      await writeJson(replacementPath, stateForInputs(changed, { lineageRootSha256: currentState.lineageRootSha256 }));
      successful(await runCandidate(workspace, ['import', replacementPath]), 'history-changing import');
      failed(await runCandidate(workspace, ['query', '--kind', 'task', '--cursor', stale.nextCursor, '--limit', '1']), 'stale-history cursor');
      const lineageStale = successful(await runCandidate(workspace, ['query', '--kind', 'task', '--limit', '1']), 'lineage-stale cursor setup');
      await writeJson(replacementPath, stateForInputs(changed, { lineageRootSha256: sha256(`${seed}:replacement-lineage`) }));
      successful(await runCandidate(workspace, ['import', replacementPath]), 'lineage-changing import');
      failed(await runCandidate(workspace, ['query', '--kind', 'task', '--cursor', lineageStale.nextCursor, '--limit', '1']), 'stale-lineage cursor');
    },
  }));
  return checks;
}

async function spawnAppend(workspace, event) {
  return runCandidate(workspace, ['append', '--id', event.id, '--kind', event.kind, '--payload', JSON.stringify(event.payload)]);
}

function pathRole(target) {
  if (typeof target !== 'string') return null;
  const basename = path.basename(target);
  if (basename === PRIMARY) return 'primary';
  if (/^\.?ledger\.json(?:\.[^.]+)*\.tmp$/.test(basename)) return 'primary-temporary';
  if (/^ledger\.snapshot(?:\.[^.]+)*\.json$/.test(basename)) return 'snapshot';
  if (/^\.?ledger\.snapshot(?:\.[^.]+)*\.json(?:\.[^.]+)*\.tmp$/.test(basename)) return 'snapshot-temporary';
  if (basename === '.' || basename === '') return 'directory';
  return basename;
}

function attemptedDurabilityBoundary(trace, boundary, role) {
  const attempts = role === 'publication'
    ? trace.publicationAttempts
    : role === 'data' && ['write', 'pwrite64', 'writev', 'pwritev', 'pwritev2'].includes(boundary.syscall)
      ? trace.writeAttempts
      : trace.barrierAttempts;
  return attempts.some((attempt) => {
    if (attempt.succeeded || attempt.syscall !== boundary.syscall || attempt.occurrence !== boundary.occurrence) return false;
    if (role === 'publication') return pathRole(attempt.to) === pathRole(boundary.to);
    if (role === 'directory') return pathRole(attempt.path) === pathRole(boundary.path)
      || (pathRole(attempt.path) === path.basename(path.dirname(path.resolve('.', boundary.path ?? '.'))));
    return pathRole(attempt.path) === pathRole(boundary.path);
  });
}

const V7_CRASH_BOUNDARY_ROLES = Object.freeze({
  'dev-01': Object.freeze(['data', 'data', 'data']),
  'dev-02': Object.freeze(['publication', 'publication', 'publication']),
  'dev-03': Object.freeze(['directory', 'directory', 'directory']),
  'release-01': Object.freeze(['data', 'publication', 'directory']),
  'release-02': Object.freeze(['data', 'directory', 'publication']),
  'release-03': Object.freeze(['publication', 'data', 'directory']),
  'release-04': Object.freeze(['publication', 'directory', 'data']),
  'release-05': Object.freeze(['directory', 'data', 'publication']),
  'reserve-01': Object.freeze(['directory', 'publication', 'data']),
  'reserve-02': Object.freeze(['data', 'data', 'publication']),
  'reserve-03': Object.freeze(['publication', 'publication', 'directory']),
  'reserve-04': Object.freeze(['directory', 'directory', 'data']),
  'reserve-05': Object.freeze(['data', 'directory', 'directory']),
});

export function v7CrashBoundaryRoles(instanceOrPack) {
  const instanceId = typeof instanceOrPack === 'string' ? instanceOrPack : instanceOrPack?.instanceId;
  const roles = V7_CRASH_BOUNDARY_ROLES[instanceId];
  invariant(roles, `unknown V7 crash-boundary instance: ${instanceId}`);
  return roles;
}

async function verifyConcurrentLifecycle(workspace, seed, pack, { durabilityTraceDirectory } = {}) {
  const requirements = requirementsForPhase(3);
  const initial = inputsForSeed(seed, 2);
  await resetRuntime(workspace, stateForInputs(initial));
  const concurrentCount = new SeedStream(`${seed}:writer-count`).int(8, 16);
  const concurrent = seededPermutation(inputsForSeed(`${seed}:writers`, concurrentCount), `${seed}:writer-order`);
  const checks = [];
  checks.push(await check(requirements[0], async () => {
    const attempts = await Promise.all(concurrent.map((event) => spawnAppend(workspace, event)));
    attempts.forEach((result, index) => successful(result, `concurrent append ${index}`));
    const rows = await logicalEvents(workspace);
    const ids = new Set(rows.map(({ id }) => id));
    invariant(ids.size === initial.length + concurrent.length, 'concurrency lost or duplicated ids');
    invariant([...initial, ...concurrent].every(({ id }) => ids.has(id)), 'concurrency lost an acknowledged append');
    invariant(rows.every((event, index) => event.sequence === index + 1), 'concurrency produced non-contiguous sequences');

    const keep = new SeedStream(`${seed}:bounded-tail`).int(2, 5);
    const beforeCompaction = canonicalJson(rows);
    successful(await runCandidate(workspace, ['compact', '--keep', String(keep)]), 'bounded-tail compaction');
    const compacted = await readState(workspace);
    invariant(Array.isArray(compacted.events) && compacted.events.length <= keep, 'compaction left an unbounded live tail');
    invariant(canonicalJson(await logicalEvents(workspace, compacted)) === beforeCompaction, 'compaction changed logical history');
    if (rows.length > keep) {
      invariant(typeof compacted.snapshotFile === 'string' && compacted.snapshotThroughSequence === rows.length - keep, 'compaction recorded the wrong snapshot boundary');
      const snapshotBytes = await readFile(path.join(workspace, compacted.snapshotFile));
      invariant(sha256(snapshotBytes) === compacted.snapshotSha256, 'compaction published an unverified snapshot');
    }
  }));
  checks.push(await check(requirements[1], {
    atomic: async () => {
      const base = inputsForSeed(`${seed}:atomic-lifecycle-base`, 7);
      await resetRuntime(workspace, stateForInputs(base));
      const importedEvent = inputsForSeed(`${seed}:atomic-lifecycle-import`, 1)[0];
      const importPath = hiddenArtifact(workspace, seed, 'phase3-atomic-import');
      await writeJson(importPath, stateForInputs([...base, importedEvent]));
      const appendedEvent = inputsForSeed(`${seed}:atomic-lifecycle-append`, 1)[0];
      const outcomes = await Promise.all([
        runCandidate(workspace, ['import', importPath]),
        spawnAppend(workspace, appendedEvent),
        runCandidate(workspace, ['compact', '--keep', '3']),
      ]);
      outcomes.forEach((result, index) => successful(result, `atomic lifecycle operation ${index}`));
      successful(await runCandidate(workspace, ['audit']), 'atomic lifecycle audit');
      const rows = await logicalEvents(workspace);
      const ids = new Set(rows.map(({ id }) => id));
      invariant(ids.has(importedEvent.id), 'atomic lifecycle lost its successful import');
      invariant(ids.size === base.length + 1 || ids.size === base.length + 2, 'atomic lifecycle matches no serial order');
      invariant(rows.every((event, index) => event.sequence === index + 1), 'atomic lifecycle exposed non-contiguous sequences');
    },
    composed: async () => {
    const base = inputsForSeed(`${seed}:composed-lifecycle-base`, 9);
    await resetRuntime(workspace, stateForInputs(base));
    const plainBase = base.map(({ id, kind, payload }) => ({ id, kind, payload }));
    const importedEvents = inputsForSeed(`${seed}:imports`, 2);
    const importPaths = [];
    for (const [index, importedEvent] of importedEvents.entries()) {
      const importPath = hiddenArtifact(workspace, seed, `phase3-concurrent-import-${index}`);
      await writeJson(importPath, stateForInputs([...plainBase, importedEvent]));
      importPaths.push(importPath);
    }
    const raced = inputsForSeed(`${seed}:raced`, 4);
    const operations = seededPermutation([
      ...importPaths.map((importPath, index) => ({ role: 'import', importedEvent: importedEvents[index], run: () => runCandidate(workspace, ['import', importPath]) })),
      ...raced.map((event) => ({ role: 'append', event, run: () => spawnAppend(workspace, event) })),
      { role: 'compact', run: () => runCandidate(workspace, ['compact', '--keep', '2']) },
      { role: 'compact', run: () => runCandidate(workspace, ['compact', '--keep', '4']) },
      { role: 'read', queryKind: 'task', run: () => runCandidate(workspace, ['query', '--kind', 'task', '--after-sequence', '0', '--limit', '100000']) },
      { role: 'read', queryKind: 'note', run: () => runCandidate(workspace, ['query', '--kind', 'note', '--after-sequence', '0', '--limit', '100000']) },
    ], `${seed}:lifecycle-order`);
    const outcomes = await Promise.all(operations.map(async (operation) => ({ operation, result: await operation.run() })));
    outcomes.forEach(({ result }, index) => successful(result, `concurrent lifecycle operation ${index}`));
    const readers = [];
    for (const { operation, result } of outcomes.filter(({ operation }) => operation.role === 'read')) {
      const rows = successful(result, `concurrent lifecycle ${operation.queryKind} read`);
      invariant(Array.isArray(rows) && rows.every((event, index) => index === 0 || rows[index - 1].sequence < event.sequence), 'concurrent reader observed a partial or unordered revision');
      readers.push({ queryKind: operation.queryKind, rows });
    }
    successful(await runCandidate(workspace, ['audit']), 'post-concurrency audit');
    const finalRows = await logicalEvents(workspace);
    const ids = new Set(finalRows.map(({ id }) => id));
    invariant(ids.size === finalRows.length && finalRows.every((event, index) => event.sequence === index + 1), 'concurrent lifecycle left duplicated ids or sequences');
    const representedImports = importedEvents.filter(({ id }) => ids.has(id));
    invariant(representedImports.length === 1, 'concurrent imports did not resolve to one complete observable serial order');
    invariant(plainBase.every(({ id }) => ids.has(id)), 'concurrent lifecycle lost the imported base revision');
    const allowed = new Set([...plainBase, representedImports[0], ...raced].map(({ id }) => id));
    invariant(finalRows.every(({ id }) => allowed.has(id)), 'concurrent lifecycle exposed a hybrid revision');
    invariant(hasCompleteConcurrentSerialization({
      base: plainBase,
      importedEvents,
      appendedEvents: raced,
      readers,
      finalRows,
    }), 'concurrent readers and final state match no complete serialized revision sequence');
    },
  }));
  const durabilityBase = inputsForSeed(`${seed}:durability-base`, 10);
  const appendEvent = inputsForSeed(`${seed}:durability-append`, 1)[0];
  const importedEvents = [...durabilityBase, ...inputsForSeed(`${seed}:durability-import`, 2)];
  const importPath = hiddenArtifact(workspace, seed, 'phase3-durability-import');
  await writeJson(importPath, stateForInputs(importedEvents));
  const traceNamespace = sha256(`${seed}:trace-artifacts`).slice(0, 12);
  const durabilityOperations = [
    {
      id: 'append',
      args: ['append', '--id', appendEvent.id, '--kind', appendEvent.kind, '--payload', JSON.stringify(appendEvent.payload)],
      prior: durabilityBase,
      next: [...durabilityBase, appendEvent],
    },
    {
      id: 'import',
      args: ['import', importPath],
      prior: durabilityBase,
      next: importedEvents,
    },
    {
      id: 'compact',
      args: ['compact', '--keep', '3'],
      prior: durabilityBase,
      next: durabilityBase,
    },
  ];
  const stableProfiles = async (label) => {
    const profiles = [];
    for (const operation of durabilityOperations) {
      await resetRuntime(workspace, stateForInputs(durabilityBase));
      const baseline = await runTracedCandidate(workspace, operation.args, {
        traceDirectory: durabilityTraceDirectory,
        label: `phase3-${traceNamespace}-${label}-${operation.id}-stable`,
      });
      successful(baseline, `traced stable ${operation.id}`);
      assertEvents(await logicalEvents(workspace), operation.next);
      const durability = analyzeV7DurabilityTrace(baseline.traces, { workspace: baseline.traceWorkspace });
      invariant(durability.stable, `${operation.id} commit lacks synchronized replacement bytes, atomic publication, or a post-publication directory barrier`);
      let snapshotDurability = null;
      if (operation.id === 'compact') {
        const state = await readState(workspace);
        invariant(typeof state.snapshotFile === 'string' && path.basename(state.snapshotFile) === state.snapshotFile, 'compaction did not publish a safe snapshot artifact');
        const snapshotBytes = await readFile(path.join(workspace, state.snapshotFile));
        invariant(sha256(snapshotBytes) === state.snapshotSha256, 'compaction primary references the wrong snapshot bytes');
        const snapshotTarget = path.resolve(baseline.traceWorkspace, state.snapshotFile);
        snapshotDurability = durability.snapshotPublications.filter(({ target }) => target === snapshotTarget).at(-1) ?? null;
        invariant(snapshotDurability?.stable, 'compaction snapshot lacks synchronized replacement bytes, atomic publication, or a post-publication directory barrier');
        invariant(
          snapshotDurability.directoryBarrierOrder < durability.publicationOrder,
          'compaction published its primary before the referenced snapshot was durably installed',
        );
      }
      profiles.push({ operation, durability, snapshotDurability });
    }
    return profiles;
  };
  checks.push(await check(requirements[2], {
    atomic: async () => {
      await stableProfiles('atomic');
    },
    composed: async () => {
    const profiles = await stableProfiles('composed');
    const boundaryRoles = v7CrashBoundaryRoles(pack);
    const boundaryFor = (durability, role) => role === 'data'
      ? durability.dataBarrier
      : role === 'publication'
        ? durability.publication
        : durability.directoryBarrier;
    await resetRuntime(workspace, stateForInputs(durabilityBase));
    await writeJson(path.join(workspace, LOCK), {
      schema: 'agentbattler.ledger.lock.v1',
      pid: 2_147_483_647,
      token: sha256(`${seed}:stale-canonical-lock`).slice(0, 32),
    });
    successful(await runCandidate(workspace, ['recover']), 'seeded stale canonical lock recovery');
    try {
      await readFile(path.join(workspace, LOCK));
      throw new Error('recover left the seeded stale canonical ledger.lock in place');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const exerciseTermination = async ({ operation, durability, role, artifact }) => {
      const crashBoundary = role === 'data' ? durability.dataBarrier : role === 'publication' ? durability.publication : durability.directoryBarrier;
      invariant(crashBoundary, `${operation.id} has no traceable ${artifact} ${role} durability boundary`);
      await resetRuntime(workspace, stateForInputs(durabilityBase));
      const terminated = await runTracedCandidate(workspace, operation.args, {
        traceDirectory: durabilityTraceDirectory,
        label: `phase3-${traceNamespace}-${operation.id}-${artifact}-terminated-${role}`,
        injectSyscall: crashBoundary.syscall,
        injectOccurrence: crashBoundary.occurrence,
      });
      invariant(!terminated.timedOut, `deterministic ${operation.id}/${artifact}/${role} termination probe timed out`);
      invariant(terminated.code !== 0 || terminated.signal, `strace did not terminate ${operation.id} at its seeded ${artifact} ${role} boundary`);
      const terminationTrace = analyzeV7DurabilityTrace(terminated.traces, { workspace: terminated.traceWorkspace });
      invariant(attemptedDurabilityBoundary(terminationTrace, crashBoundary, role), `deterministic termination did not strike the traced ${operation.id}/${artifact}/${role} syscall`);
      successful(await runCandidate(workspace, ['recover']), `post-termination ${operation.id}/${artifact} recovery`);
      const recovered = await logicalEvents(workspace);
      const prior = canonicalJson(recovered) === canonicalJson(sequenced(operation.prior));
      const next = canonicalJson(recovered) === canonicalJson(sequenced(operation.next));
      invariant(prior || next, `terminated ${operation.id}/${artifact} recovered neither its prior nor next complete revision`);
      successful(await runCandidate(workspace, ['audit']), `post-termination ${operation.id}/${artifact} audit`);
      try { await readFile(path.join(workspace, LOCK)); throw new Error(`stale lock remains after ${operation.id}/${artifact} termination recovery`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    for (const [index, { operation, durability }] of profiles.entries()) {
      const role = boundaryRoles[index];
      invariant(boundaryFor(durability, role), `${operation.id} has no traceable primary ${role} durability boundary`);
      await exerciseTermination({ operation, durability, role, artifact: 'primary' });
    }
    const compact = profiles.find(({ operation }) => operation.id === 'compact');
    invariant(compact?.snapshotDurability, 'compaction has no traceable snapshot durability profile');
    const snapshotRole = Object.freeze({ data: 'publication', publication: 'directory', directory: 'data' })[boundaryRoles[2]];
    invariant(boundaryFor(compact.snapshotDurability, snapshotRole), `compact has no traceable snapshot ${snapshotRole} durability boundary`);
    await exerciseTermination({ operation: compact.operation, durability: compact.snapshotDurability, role: snapshotRole, artifact: 'snapshot' });
    },
  }));
  return checks;
}

function resolveCandidateArtifact(workspace, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'candidate artifact path must be relative');
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, relative);
  invariant(resolved.startsWith(`${root}${path.sep}`), 'candidate artifact path escapes the workspace');
  return resolved;
}

async function verifyIncident({ workspace, source, pack, contract }) {
  const requirements = requirementsForPhase(4);
  invariant(contract?.phase === 4, 'trusted phase-4 task contract is missing');
  invariant(contract.instanceId === pack.instanceId && (!contract.scenarioId || contract.scenarioId === pack.scenarioId), 'phase-4 contract names the wrong sealed instance');
  if (contract.packSha256) invariant(contract.packSha256 === pack.packSha256, 'phase-4 contract names the wrong sealed pack');
  invariant(/^[0-9a-f]{64}$/.test(contract.executableSourceSha256), 'phase-4 contract has no trusted executable source hash');
  const derived = buildV7IncidentEvidence(pack);
  if (contract.incidentEvidenceSha256) invariant(contract.incidentEvidenceSha256 === derived.sha256, 'phase-4 evidence commitment does not match the sealed pack');
  const evidence = derived.evidence;
  const canonical = evidence.evidence.find(({ id }) => id === 'E-CANONICAL-PRIMARY');
  const expectedEvidenceIds = evidence.evidence.map(({ id }) => id).sort();
  async function response() {
    const file = resolveCandidateArtifact(workspace, contract.responsePath);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'incident response must be one regular unlinked file');
    return JSON.parse(await readFile(file, 'utf8'));
  }
  const checks = [];
  checks.push(await check(requirements[0], async () => {
    const value = await response();
    invariant(value.schema === 'agentbattler.ledger.incident-response.v1', 'incident response schema is invalid');
    invariant(value.conclusion === 'no-canonical-data-loss', 'incident conclusion is not supported');
    invariant(value.canonicalEventCount === canonical.eventCount && value.canonicalHeadSha256 === canonical.headSha256, 'incident response identifies the wrong canonical state');
  }));
  checks.push(await check(requirements[1], {
    atomic: async () => {
      const value = await response();
      invariant(canonical.authority === 'canonical', 'canonical evidence role is missing');
      invariant(Array.isArray(value.evidenceIds) && value.evidenceIds.includes('E-CANONICAL-PRIMARY') && value.evidenceIds.includes('E-ACKNOWLEDGED-IDS'), 'incident response omitted canonical lineage evidence');
    },
    composed: async () => {
      const value = await response();
      const acknowledgements = evidence.evidence.find(({ id }) => id === 'E-ACKNOWLEDGED-IDS');
      invariant(acknowledgements.acknowledgedIds.every((id) => canonical.eventIds.includes(id)), 'lineage evidence is internally inconsistent');
      invariant(canonical.deploymentId === acknowledgements.deploymentId, 'canonical deployment provenance is inconsistent');
      invariant(canonicalJson(value.evidenceIds) === canonicalJson(expectedEvidenceIds), 'incident response did not cite the complete sorted evidence set');
    },
  }));
  checks.push(await check(requirements[2], {
    atomic: async () => {
      const current = await hashV7ExecutableTree(source);
      invariant(current === contract.executableSourceSha256, 'phase-4 executable source changed');
    },
    composed: async () => {
      const value = await response();
      invariant(value.executableSourceSha256 === contract.executableSourceSha256, 'incident response cites the wrong executable source hash');
    },
  }));
  return checks;
}

async function verifyRecoveryScale(workspace, seed) {
  const requirements = requirementsForPhase(5);
  const initial = inputsForSeed(seed, 12);
  await resetRuntime(workspace, stateForInputs(initial));
  const removeRecoveryCandidates = async () => {
    for (const name of await readdir(workspace)) {
      if (name === TEMPORARY
        || (name.startsWith(`${PRIMARY}.`) && name.endsWith('.tmp'))
        || /^ledger(?:\.json)?\.export(?:\.[a-z0-9_-]+)?\.json$/i.test(name)) {
        await rm(path.join(workspace, name), { force: true });
      }
    }
  };
  const restoreBytes = async (file, bytes) => {
    await writeFile(file, bytes);
    await candidateOwnedFile(file);
  };
  const checks = [];
  checks.push(await check(requirements[0], async () => {
    await removeRecoveryCandidates();
    const primary = await readState(workspace);
    const primaryBytes = await readFile(path.join(workspace, PRIMARY));
    const extra = { ...inputsForSeed(`${seed}:recover`, 1)[0], sequence: primary.nextSequence };
    const descendant = { ...primary, generation: 1, parentStateSha256: sha256(canonicalJson(primary)), events: [...primary.events, extra], nextSequence: primary.nextSequence + 1 };
    await writeJson(path.join(workspace, TEMPORARY), descendant);
    await writeFile(path.join(workspace, PRIMARY), corruptedBytes(primaryBytes, `${seed}:primary-corruption`));
    await candidateOwnedFile(path.join(workspace, PRIMARY));
    successful(await runCandidate(workspace, ['recover']), 'corrupt-primary recovery');
    invariant((await logicalEvents(workspace)).some(({ id }) => id === extra.id), 'valid descendant was not recovered');

    const corruptionVariants = [
      Buffer.from('{"schemaVersion":'),
      Buffer.from(`${JSON.stringify({ schemaVersion: 'agentbattler.ledger.v99', events: [] })}\n`),
      Buffer.concat([primaryBytes.subarray(0, Math.max(1, primaryBytes.length - 3)), Buffer.from([0, 10])]),
    ];
    for (const [index, corrupt] of corruptionVariants.entries()) {
      await removeRecoveryCandidates();
      await resetRuntime(workspace, stateForInputs(initial));
      const exportedExtra = inputsForSeed(`${seed}:export-recovery-${index}`, 1)[0];
      await append(workspace, exportedExtra);
      const exportName = `ledger.export.${sha256(`${seed}:export:${index}`).slice(0, 12)}.json`;
      successful(await runCandidate(workspace, ['export', exportName]), `recovery export ${index}`);
      const corruptCandidate = path.join(workspace, TEMPORARY);
      await restoreBytes(corruptCandidate, Buffer.from(index === 1 ? '[]\n' : '{broken'));
      await restoreBytes(path.join(workspace, PRIMARY), corrupt);
      successful(await runCandidate(workspace, ['recover']), `export recovery variant ${index}`);
      assertEvents(await logicalEvents(workspace), [...initial, exportedExtra]);
    }

    await removeRecoveryCandidates();
    await resetRuntime(workspace, stateForInputs(initial));
    successful(await runCandidate(workspace, ['compact', '--keep', '3']), 'snapshot recovery compaction');
    const compacted = await readState(workspace);
    invariant(typeof compacted.snapshotFile === 'string' && typeof compacted.snapshotSha256 === 'string', 'compaction did not publish a snapshot candidate');
    const snapshotBytes = await readFile(path.join(workspace, compacted.snapshotFile));
    invariant(sha256(snapshotBytes) === compacted.snapshotSha256, 'snapshot recovery fixture has an invalid checksum');
    const snapshotExtra = inputsForSeed(`${seed}:snapshot-recovery`, 1)[0];
    await append(workspace, snapshotExtra);
    const snapshotDescendant = await readState(workspace);
    invariant(snapshotDescendant.snapshotFile === compacted.snapshotFile, 'snapshot descendant discarded its validated snapshot boundary');
    await writeJson(path.join(workspace, TEMPORARY), snapshotDescendant);
    const snapshotPrimaryBytes = await readFile(path.join(workspace, PRIMARY));
    await restoreBytes(path.join(workspace, PRIMARY), corruptedBytes(snapshotPrimaryBytes, `${seed}:snapshot-primary-corruption`));
    successful(await runCandidate(workspace, ['recover']), 'snapshot-backed recovery candidate');
    assertEvents(await logicalEvents(workspace), [...initial, snapshotExtra]);

    await removeRecoveryCandidates();
    const snapshotCorruptExtra = inputsForSeed(`${seed}:snapshot-corrupt-recovery`, 1)[0];
    const snapshotCorruptEvents = [...initial, snapshotCorruptExtra];
    const standalone = stateForInputs(snapshotCorruptEvents);
    const standaloneExport = `ledger.export.${sha256(`${seed}:snapshot-corrupt-export`).slice(0, 12)}.json`;
    await writeJson(path.join(workspace, standaloneExport), standalone);
    const split = 6;
    const snapshotDocument = {
      schemaVersion: 'agentbattler.ledger.snapshot.v1',
      throughSequence: split,
      events: sequenced(snapshotCorruptEvents).slice(0, split),
    };
    const validSnapshotBytes = Buffer.from(`${JSON.stringify(snapshotDocument)}\n`);
    const snapshotName = `ledger.snapshot.${sha256(validSnapshotBytes)}.json`;
    await restoreBytes(path.join(workspace, snapshotName), corruptedBytes(validSnapshotBytes, `${seed}:recovery-snapshot-checksum-corruption`));
    await writeJson(path.join(workspace, TEMPORARY), {
      ...standalone,
      generation: 1,
      parentStateSha256: sha256(canonicalJson(standalone)),
      snapshotFile: snapshotName,
      snapshotSha256: sha256(validSnapshotBytes),
      snapshotThroughSequence: split,
      events: sequenced(snapshotCorruptEvents).slice(split),
    });
    await restoreBytes(path.join(workspace, PRIMARY), corruptedBytes(Buffer.from(`${JSON.stringify(standalone)}\n`), `${seed}:snapshot-corrupt-primary`));
    successful(await runCandidate(workspace, ['recover']), 'snapshot-checksum-corrupt candidate recovery');
    assertEvents(await logicalEvents(workspace), snapshotCorruptEvents);
  }));
  checks.push(await check(requirements[1], {
    atomic: async () => {
      await removeRecoveryCandidates();
      await resetRuntime(workspace, stateForInputs(initial));
      const lineageEvents = inputsForSeed(`${seed}:lineage-advance-atomic`, 2);
      await append(workspace, lineageEvents[0]);
      await append(workspace, lineageEvents[1]);
      const before = await readFile(path.join(workspace, PRIMARY));
      const primary = JSON.parse(before);
      const fork = { ...primary, generation: primary.generation + 1, lineageRootSha256: 'f'.repeat(64), parentStateSha256: 'e'.repeat(64) };
      await writeJson(path.join(workspace, TEMPORARY), fork);
      failed(await runCandidate(workspace, ['recover']), 'fork recovery');
      invariant(Buffer.compare(before, await readFile(path.join(workspace, PRIMARY))) === 0, 'fork recovery changed primary state');

      await rm(path.join(workspace, TEMPORARY), { force: true });
      const rollback = stateForInputs(initial.slice(0, 7), {
        generation: primary.generation - 1,
        lineageRootSha256: primary.lineageRootSha256,
        parentStateSha256: primary.generation - 1 === 0 ? null : sha256(`${seed}:rollback-parent`),
      });
      await writeJson(path.join(workspace, TEMPORARY), rollback);
      failed(await runCandidate(workspace, ['recover']), 'rollback recovery candidate');
      invariant(Buffer.compare(before, await readFile(path.join(workspace, PRIMARY))) === 0, 'rollback recovery changed primary state');
    },
    composed: async () => {
      await removeRecoveryCandidates();
      await resetRuntime(workspace, stateForInputs(initial));
      const lineageEvents = inputsForSeed(`${seed}:lineage-advance-composed`, 2);
      await append(workspace, lineageEvents[0]);
      await append(workspace, lineageEvents[1]);
      const before = await readFile(path.join(workspace, PRIMARY));
      const primary = JSON.parse(before);
      const conflicting = structuredClone(primary);
      conflicting.events[0] = { ...conflicting.events[0], payload: inputsForSeed(`${seed}:equal-generation-conflict`, 1)[0].payload };
      await writeJson(path.join(workspace, TEMPORARY), conflicting);
      failed(await runCandidate(workspace, ['recover']), 'equal-generation recovery conflict');
      invariant(Buffer.compare(before, await readFile(path.join(workspace, PRIMARY))) === 0, 'equal-generation recovery conflict changed primary state');

      await rm(path.join(workspace, TEMPORARY), { force: true });
      const rollbackExport = `ledger.export.${sha256(`${seed}:rollback-export`).slice(0, 12)}.json`;
      await writeJson(path.join(workspace, rollbackExport), stateForInputs(initial.slice(0, 5), {
        generation: primary.generation - 1,
        lineageRootSha256: primary.lineageRootSha256,
        parentStateSha256: primary.generation - 1 === 0 ? null : sha256(`${seed}:rollback-export-parent`),
      }));
      failed(await runCandidate(workspace, ['recover']), 'exported rollback recovery candidate');
      invariant(Buffer.compare(before, await readFile(path.join(workspace, PRIMARY))) === 0, 'exported rollback changed primary state');

      await rm(path.join(workspace, rollbackExport), { force: true });
      await restoreBytes(path.join(workspace, TEMPORARY), Buffer.from('{corrupt'));
      successful(await runCandidate(workspace, ['recover']), 'invalid candidate reconciliation');
      invariant(Buffer.compare(before, await readFile(path.join(workspace, PRIMARY))) === 0, 'invalid candidate reconciliation changed primary state');
    },
  }));
  const prepareReplayFixture = async () => {
    await removeRecoveryCandidates();
    await resetRuntime(workspace, stateForInputs(initial));
    const receiptEvents = inputsForSeed(`${seed}:audit-receipt`, 3);
    const receiptPath = hiddenArtifact(workspace, seed, 'phase5-audit-receipt');
    await writeJson(receiptPath, receiptEvents);
    successful(await runCandidate(workspace, ['append-batch', '--file', receiptPath, '--idempotency-key', `audit-${sha256(seed).slice(0, 10)}`]), 'audit receipt batch');
    successful(await runCandidate(workspace, ['compact', '--keep', '3']), 'compaction');
    const expected = await logicalEvents(workspace);
    const state = await readState(workspace);
    const primaryPath = path.join(workspace, PRIMARY);
    const snapshotPath = path.join(workspace, state.snapshotFile);
    const primaryBytes = await readFile(primaryPath);
    const snapshotBytes = await readFile(snapshotPath);
    return { expected, state, primaryPath, snapshotPath, primaryBytes, snapshotBytes, receiptPath };
  };
  checks.push(await check(requirements[2], {
    atomic: async () => {
      const { expected, state } = await prepareReplayFixture();
      const replayed = successful(await runCandidate(workspace, ['replay']), 'replay');
      const audited = successful(await runCandidate(workspace, ['audit']), 'audit');
      const expectedHead = sha256(canonicalJson(expected));
      const expectedState = sha256(canonicalJson(state));
      for (const [label, value] of [['replay', replayed], ['audit', audited]]) {
        invariant(value.ok === true && value.verified === true, `${label} did not report verified history`);
        invariant(value.eventCount === expected.length && value.headSha256 === expectedHead, `${label} did not reconstruct the exact logical history`);
        invariant(value.generation === state.generation && value.lineageRootSha256 === state.lineageRootSha256, `${label} reported the wrong lineage`);
      }
      invariant(audited.stateSha256 === expectedState, 'audit reported the wrong canonical state hash');
    },
    composed: async () => {
    const { state, primaryPath, snapshotPath, primaryBytes, snapshotBytes, receiptPath } = await prepareReplayFixture();
    const corruptionCases = [
      {
        label: 'snapshot-checksum',
        primary: primaryBytes,
        snapshot: corruptedBytes(snapshotBytes, `${seed}:snapshot-corruption`),
      },
      {
        label: 'primary-schema',
        primary: Buffer.from(`${JSON.stringify({ ...state, schemaVersion: `agentbattler.ledger.corrupt-${sha256(seed).slice(0, 8)}` })}\n`),
        snapshot: snapshotBytes,
      },
      {
        label: 'lineage-root-hash',
        primary: Buffer.from(`${JSON.stringify({ ...state, lineageRootSha256: `corrupt-${sha256(`${seed}:lineage`).slice(0, 20)}` })}\n`),
        snapshot: snapshotBytes,
      },
      {
        label: 'parent-state-hash',
        primary: Buffer.from(`${JSON.stringify({ ...state, parentStateSha256: `corrupt-${sha256(`${seed}:parent`).slice(0, 20)}` })}\n`),
        snapshot: snapshotBytes,
      },
      {
        label: 'sequence',
        primary: Buffer.from(`${JSON.stringify({ ...state, events: state.events.map((event, index) => index === 0 ? { ...event, sequence: event.sequence + 1 } : event) })}\n`),
        snapshot: snapshotBytes,
      },
      {
        label: 'duplicate-id',
        primary: Buffer.from(`${JSON.stringify({ ...state, events: state.events.map((event, index) => index === 1 ? { ...event, id: state.events[0].id } : event) })}\n`),
        snapshot: snapshotBytes,
      },
      {
        label: 'batch-receipt',
        primary: Buffer.from(`${JSON.stringify({ ...state, batches: Object.fromEntries(Object.entries(state.batches).map(([key, receipt], index) => [key, index === 0 ? { ...receipt, eventIds: receipt.eventIds.map((id, eventIndex) => eventIndex === 0 ? `missing-${sha256(seed).slice(0, 10)}` : id) } : receipt])) })}\n`),
        snapshot: snapshotBytes,
      },
      {
        label: 'snapshot-boundary',
        primary: Buffer.from(`${JSON.stringify({ ...state, snapshotThroughSequence: state.snapshotThroughSequence + 1 })}\n`),
        snapshot: snapshotBytes,
      },
    ];
    for (const corruption of corruptionCases) {
      await restoreBytes(primaryPath, corruption.primary);
      await restoreBytes(snapshotPath, corruption.snapshot);
      const verifierOwnedArtifacts = [receiptPath];
      const corruptDigest = await workspaceStateDigest(workspace, { verifierOwnedArtifacts });
      failed(await runCandidate(workspace, ['replay']), `${corruption.label} replay`);
      invariant(await workspaceStateDigest(workspace, { verifierOwnedArtifacts }) === corruptDigest, `${corruption.label} replay mutated corrupt evidence`);
      failed(await runCandidate(workspace, ['audit']), `${corruption.label} audit`);
      invariant(await workspaceStateDigest(workspace, { verifierOwnedArtifacts }) === corruptDigest, `${corruption.label} audit mutated corrupt evidence`);
    }
    await restoreBytes(primaryPath, primaryBytes);
    await restoreBytes(snapshotPath, snapshotBytes);
    },
  }));
  checks.push(await check(requirements[3], {
    atomic: async () => {
      await removeRecoveryCandidates();
      await resetRuntime(workspace, stateForInputs([]));
      const atomicWorkload = inputsForSeed(`${seed}:atomic-scale`, 60);
      for (const event of atomicWorkload.slice(0, 5)) await append(workspace, event);
      const atomicBatchPath = hiddenArtifact(workspace, seed, 'phase5-atomic-scale-batch');
      await writeJson(atomicBatchPath, atomicWorkload.slice(5));
      successful(await runCandidate(workspace, ['append-batch', '--file', atomicBatchPath, '--idempotency-key', `atomic-scale-${sha256(seed).slice(0, 8)}`]), 'atomic scale batch');
      successful(await runCandidate(workspace, ['append-batch', '--file', atomicBatchPath, '--idempotency-key', `atomic-scale-${sha256(seed).slice(0, 8)}`]), 'atomic scale batch retry');
      const after = await queryAfter(workspace, 'task', 20, 1000);
      assertEvents(after, sequenced(atomicWorkload).filter(({ kind, sequence }) => kind === 'task' && sequence > 20));
      const cursorRows = [];
      let atomicCursor = null;
      do {
        const args = ['query', '--kind', 'note', '--limit', '7'];
        if (atomicCursor) args.push('--cursor', atomicCursor);
        const page = successful(await runCandidate(workspace, args), 'atomic scale cursor');
        cursorRows.push(...page.items);
        atomicCursor = page.nextCursor;
      } while (atomicCursor);
      invariant(atomicCursor === null, 'atomic scale terminal page did not return nextCursor: null');
      assertEvents(cursorRows, sequenced(atomicWorkload).filter(({ kind }) => kind === 'note'));
      const atomicExport = hiddenArtifact(workspace, seed, 'phase5-atomic-scale-export');
      successful(await runCandidate(workspace, ['export', atomicExport]), 'atomic scale export');
      successful(await runCandidate(workspace, ['import', atomicExport]), 'atomic scale import');
      assertEvents(await logicalEvents(workspace), atomicWorkload);
    },
    composed: async () => {
    await removeRecoveryCandidates();
    await resetRuntime(workspace, stateForInputs([]));
    const workload = inputsForSeed(`${seed}:scale`, 240);
    const direct = workload.slice(0, 12);
    const batched = workload.slice(12);
    for (const event of direct) await append(workspace, event);
    for (let index = 0; index < batched.length; index += 38) {
      const file = hiddenArtifact(workspace, seed, `phase5-scale-${index}`);
      await writeJson(file, batched.slice(index, index + 38));
      successful(await runCandidate(workspace, ['append-batch', '--file', file, '--idempotency-key', `scale-${index}`], { timeoutMs: 60_000 }), 'scale batch');
      successful(await runCandidate(workspace, ['append-batch', '--file', file, '--idempotency-key', `scale-${index}`], { timeoutMs: 60_000 }), 'scale batch retry');
    }
    const afterBoundary = new SeedStream(`${seed}:scale-after`).int(25, 120);
    for (const kind of ['task', 'note']) {
      const rows = await queryAfter(workspace, kind, afterBoundary, 100_000);
      const expectedAfter = sequenced(workload).filter((event) => event.kind === kind && event.sequence > afterBoundary);
      assertEvents(rows, expectedAfter);
    }
    let cursor = null;
    const seen = [];
    do {
      const args = ['query', '--kind', 'task', '--limit', '17'];
      if (cursor) args.push('--cursor', cursor);
      const page = successful(await runCandidate(workspace, args, { timeoutMs: 60_000 }), 'scale cursor query');
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    invariant(cursor === null, 'mixed scale terminal page did not return nextCursor: null');
    invariant(seen.length === workload.filter(({ kind }) => kind === 'task').length, 'scale pagination lost events');
    assertEvents(seen, sequenced(workload).filter(({ kind }) => kind === 'task'));
    const exported = path.join(workspace, `ledger.export.${sha256(`${seed}:scale-export`).slice(0, 12)}.json`);
    successful(await runCandidate(workspace, ['export', exported], { timeoutMs: 60_000 }), 'scale export');
    successful(await runCandidate(workspace, ['compact', '--keep', '25'], { timeoutMs: 60_000 }), 'scale compact');
    const compacted = await readState(workspace);
    invariant(compacted.events.length <= 25, 'scale compaction left an unbounded live tail');
    const replayed = successful(await runCandidate(workspace, ['replay'], { timeoutMs: 60_000 }), 'scale replay');
    const audited = successful(await runCandidate(workspace, ['audit'], { timeoutMs: 60_000 }), 'scale audit');
    const workloadHead = sha256(canonicalJson(sequenced(workload)));
    invariant(replayed.headSha256 === workloadHead && audited.headSha256 === workloadHead, 'scale replay/audit reported the wrong history');
    successful(await runCandidate(workspace, ['import', exported], { timeoutMs: 60_000 }), 'scale re-import');
    assertEvents(await logicalEvents(workspace), workload);
    const exportedBytes = await readFile(exported);
    await restoreBytes(path.join(workspace, PRIMARY), corruptedBytes(await readFile(path.join(workspace, PRIMARY)), `${seed}:scale-primary-corruption`));
    successful(await runCandidate(workspace, ['recover'], { timeoutMs: 60_000 }), 'scale exported-candidate recovery');
    assertEvents(await logicalEvents(workspace), workload);
    invariant(Buffer.compare(exportedBytes, await readFile(exported)) === 0, 'scale recovery mutated its exported candidate');
    const afterRecovery = inputsForSeed(`${seed}:scale-after-recovery`, 1)[0];
    await append(workspace, afterRecovery);
    const resumed = await queryAfter(workspace, afterRecovery.kind, workload.length, 10);
    assertEvents(resumed, [{ ...afterRecovery, sequence: workload.length + 1 }]);
    successful(await runCandidate(workspace, ['audit'], { timeoutMs: 60_000 }), 'scale post-recovery audit');
    },
  }));
  return checks;
}

async function withCandidateCopy(source, operation) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-mini-ledger-v7-'));
  const workspace = path.join(root, 'candidate');
  try {
    await cp(source, workspace, { recursive: true });
    await grantCandidateAccess(workspace);
    return await operation(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function grantCandidateAccess(target) {
  const stat = await lstat(target);
  invariant(!stat.isSymbolicLink(), `Mini Ledger V7 candidate tree contains a symbolic link: ${target}`);
  if (stat.isDirectory()) {
    await candidateOwnedDirectory(target);
    for (const name of await readdir(target)) await grantCandidateAccess(path.join(target, name));
    return;
  }
  invariant(stat.isFile(), `Mini Ledger V7 candidate tree contains an unsupported entry: ${target}`);
  await candidateOwnedFile(target, target.endsWith(`${path.sep}bin${path.sep}ledger.mjs`) ? 0o750 : 0o660);
}

function normalizePack({ instance, pack, seedKey }) {
  const value = pack ?? instance;
  invariant(value && typeof value === 'object', 'verifyPhase requires a V7 pack descriptor');
  if (value.schemaVersion === V7_SEALED_PACK_SCHEMA) return assertV7PackSeal(value, { seedKey });
  return sealV7Pack(loadV7Pack(value.instanceId, { variant: value.variant }), { seedKey });
}

function phaseSeed(pack, phase, seedKey, verifierSeedIndex) {
  const cases = V7_HIDDEN_CASES.filter((entry) => entry.phase === phase);
  return sha256(cases.map(({ id }) => sha256(`mini-ledger-v7/hidden-variant/v1\0${deriveV7HiddenSeed(pack, id, { seedKey })}\0${verifierSeedIndex}`)).join('\0'));
}

export function v7ScoredFixtureSchemaEvidence({
  instance,
  pack,
  phase,
  seedKey,
  verifierSeedIndex = 0,
} = {}) {
  invariant(Number.isInteger(phase) && phase >= 1 && phase <= 5, 'V7 scored fixture phase must be 1..5');
  invariant(Number.isInteger(verifierSeedIndex) && verifierSeedIndex >= 0 && verifierSeedIndex <= 99, 'V7 scored fixture verifierSeedIndex must be an integer in [0, 99]');
  const sealed = normalizePack({ instance, pack, seedKey });
  const seed = phaseSeed(sealed, phase, seedKey, verifierSeedIndex);
  const schema = fixturePayloadSchema(seed);
  const schemaSha256 = sha256(canonicalJson(schema));
  return Object.freeze({
    schemaVersion: 'agentbattler.mini-ledger-v7.scored-fixture-schema-evidence.v1',
    instanceId: sealed.instanceId,
    variant: sealed.variant,
    phase,
    verifierSeedIndex,
    derivationVersion: FIXTURE_PAYLOAD_SCHEMA_VERSION,
    phaseSeedCommitment: sha256(seed),
    layout: schema.layout,
    fieldNames: schema.fields,
    schemaSha256,
  });
}

function familyResults(checks) {
  invariant(new Set(checks.map(({ id }) => id)).size === checks.length, 'V7 family scoring received duplicate requirement outcomes');
  return V7_FAMILIES.map((id) => {
    const family = checks.filter((requirement) => requirement.family === id);
    const summarize = (group) => ({
      passed: family.filter((requirement) => requirement.group === group).reduce((sum, requirement) => sum + requirement.points, 0),
      total: family.filter((requirement) => requirement.group === group).reduce((sum, requirement) => sum + requirement.weight, 0),
    });
    const summarizeClass = (caseClass) => ({
      passed: family.filter(({ group }) => group === 'private').reduce((sum, requirement) => sum + requirement.classes[caseClass].points, 0),
      total: family.filter(({ group }) => group === 'private').reduce((sum, requirement) => sum + requirement.classes[caseClass].weight, 0),
    });
    return {
      id,
      public: summarize('public'),
      hidden: summarize('private'),
      hiddenAtomic: summarizeClass('atomic'),
      hiddenComposed: summarizeClass('composed'),
    };
  });
}

function scoreResult(pack, phase, checks, startedAt, seedKey, verifierSeedIndex, { infrastructureErrors = [], adaptability } = {}) {
  const score = checks.reduce((sum, { points }) => sum + points, 0);
  const maxScore = checks.reduce((sum, { weight }) => sum + weight, 0);
  const publicScore = checks.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0);
  const privateScore = checks.filter(({ group }) => group === 'private').reduce((sum, { points }) => sum + points, 0);
  const derivedInfrastructureErrors = checks.filter(({ infrastructureError }) => infrastructureError).map(({ id, diagnostic }) => ({
    code: 'V7_VERIFIER_INFRASTRUCTURE',
    requirementId: id,
    message: diagnostic,
  }));
  const requirements = checks.map(({ infrastructureError: _infrastructureError, ...requirement }) => requirement);
  return {
    schemaVersion: V7_VERIFICATION_SCHEMA,
    challengeId: pack.challengeId,
    instanceId: pack.instanceId,
    variant: pack.variant,
    phase,
    passed: score === maxScore && derivedInfrastructureErrors.length === 0 && infrastructureErrors.length === 0,
    score,
    maxScore,
    publicScore,
    privateScore,
    infrastructureErrors: [...infrastructureErrors, ...derivedInfrastructureErrors],
    requirements,
    checks: requirements,
    families: familyResults(requirements),
    adaptability: adaptability ?? { passed: score === maxScore ? 1 : 0, total: 1 },
    verifierSeedIndex,
    seedCommitments: V7_HIDDEN_CASES.filter((entry) => phase === null || entry.phase === phase).map(({ id }) => ({
      id,
      masterCommitment: sha256(deriveV7HiddenSeed(pack, id, { seedKey })),
      variantCommitment: sha256(`mini-ledger-v7/hidden-variant/v1\0${deriveV7HiddenSeed(pack, id, { seedKey })}\0${verifierSeedIndex}`),
    })),
    durationMs: Date.now() - startedAt,
  };
}

async function trustedPhaseFourContract(workspace, explicit) {
  if (explicit) return explicit;
  const file = path.join(workspace, '.agentbattler', 'current', 'task-contract.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new InfrastructureError(`trusted phase-4 contract is unavailable: ${error.message}`);
  }
}

function validatedPreservedPhaseResult(result, pack, phase, verifierSeedIndex) {
  invariant(result?.schemaVersion === V7_VERIFICATION_SCHEMA && result.challengeId === pack.challengeId && result.instanceId === pack.instanceId, 'preserved V7 phase result has the wrong identity');
  invariant(result.phase === phase && result.verifierSeedIndex === verifierSeedIndex, 'preserved V7 phase result has the wrong phase or verifier seed index');
  const expected = requirementsForPhase(phase);
  invariant(Array.isArray(result.requirements) && result.requirements.length === expected.length, 'preserved V7 phase result has the wrong requirement count');
  for (const requirement of expected) {
    const actual = result.requirements.find(({ id }) => id === requirement.id);
    invariant(actual && actual.family === requirement.family && actual.group === requirement.group && actual.weight === requirement.weight && typeof actual.passed === 'boolean', `preserved V7 phase result has an invalid requirement: ${requirement.id}`);
    invariant(Number.isSafeInteger(actual.points) && actual.points >= 0 && actual.points <= actual.weight, `preserved V7 requirement has invalid points: ${requirement.id}`);
    const catalog = V7_VERIFIER_ASSERTIONS[requirement.id];
    if (requirement.group === 'public') {
      invariant(actual.assertionId === catalog.public.assertionId && actual.caseCount === catalog.public.caseCount, `preserved V7 public assertion identity changed: ${requirement.id}`);
      invariant(actual.points === (actual.passed ? actual.weight : 0), `preserved V7 public points are inconsistent: ${requirement.id}`);
    } else {
      invariant(actual.classes && Object.keys(actual.classes).length === 2, `preserved V7 private classes are incomplete: ${requirement.id}`);
      let classPoints = 0;
      for (const caseClass of ['atomic', 'composed']) {
        const item = actual.classes[caseClass];
        const metadata = catalog[caseClass];
        invariant(item?.assertionId === metadata.assertionId && item.caseCount === metadata.caseCount, `preserved V7 assertion identity changed: ${requirement.id}/${caseClass}`);
        invariant(item.weight === requirement.privateClassWeights[caseClass] && item.points === (item.passed ? item.weight : 0), `preserved V7 class points are inconsistent: ${requirement.id}/${caseClass}`);
        classPoints += item.points;
      }
      invariant(actual.points === classPoints && actual.passed === (classPoints === actual.weight), `preserved V7 private points are inconsistent: ${requirement.id}`);
    }
  }
  invariant(Array.isArray(result.infrastructureErrors), 'preserved V7 phase result has no infrastructure classification');
  const score = result.requirements.reduce((sum, { points }) => sum + points, 0);
  const maxScore = result.requirements.reduce((sum, { weight }) => sum + weight, 0);
  const publicScore = result.requirements.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0);
  const privateScore = result.requirements.filter(({ group }) => group === 'private').reduce((sum, { points }) => sum + points, 0);
  invariant(result.score === score && result.maxScore === maxScore && result.publicScore === publicScore && result.privateScore === privateScore, 'preserved V7 phase result score is inconsistent with its requirements');
  if (result.regressionGate) {
    const gate = result.regressionGate;
    invariant(gate.schemaVersion === 'agentbattler.mini-ledger-v7.regression-gate.v1', 'preserved V7 regression-gate schema changed');
    invariant(JSON.stringify(gate.evaluatedPhases) === JSON.stringify(Array.from({ length: phase }, (_, index) => index + 1)), 'preserved V7 regression-gate phase set is invalid');
    invariant(Array.isArray(gate.failedPhases)
      && new Set(gate.failedPhases).size === gate.failedPhases.length
      && gate.failedPhases.every((failedPhase) => Number.isInteger(failedPhase) && failedPhase >= 1 && failedPhase <= phase), 'preserved V7 regression-gate failures are invalid');
    const passed = gate.failedPhases.length === 0 && result.infrastructureErrors.length === 0;
    invariant(gate.passed === passed && result.passed === passed, 'preserved V7 phase result disagrees with its regression gate');
    invariant(result.adaptability?.passed === (passed ? 1 : 0) && result.adaptability?.total === 1, 'preserved V7 trajectory adaptability is inconsistent');
    if (result.trajectoryPhases !== undefined) {
      invariant(Array.isArray(result.trajectoryPhases) && result.trajectoryPhases.length === phase, 'preserved V7 trajectory requirement outcomes are incomplete');
      const trajectoryByPhase = new Map(result.trajectoryPhases.map((entry) => [entry?.phase, entry]));
      invariant(trajectoryByPhase.size === phase, 'preserved V7 trajectory contains duplicate or missing phases');
      const derivedFailures = [];
      for (let trajectoryPhase = 1; trajectoryPhase <= phase; trajectoryPhase += 1) {
        const entry = validatedPreservedPhaseResult(trajectoryByPhase.get(trajectoryPhase), pack, trajectoryPhase, verifierSeedIndex);
        if (!entry.passed || entry.infrastructureErrors.length > 0) derivedFailures.push(trajectoryPhase);
      }
      invariant(JSON.stringify([...gate.failedPhases].sort((left, right) => left - right)) === JSON.stringify(derivedFailures), 'preserved V7 regression gate disagrees with trajectory requirement outcomes');
    }
  } else {
    const passed = score === maxScore && result.infrastructureErrors.length === 0;
    invariant(result.passed === passed, 'preserved V7 phase result pass flag is inconsistent');
  }
  return result;
}

export async function verifyPhase({
  instance,
  pack,
  phase,
  candidateTree,
  workspace,
  seedKey,
  verifierSeedIndex = 0,
  contract,
  phaseContracts,
  previousCandidateTreeSha256: _previousCandidateTreeSha256,
  durabilityTraceDirectory,
} = {}) {
  const startedAt = Date.now();
  invariant(Number.isInteger(phase) && phase >= 1 && phase <= 5, 'verifyPhase phase must be 1..5');
  invariant(Number.isInteger(verifierSeedIndex) && verifierSeedIndex >= 0 && verifierSeedIndex <= 99, 'verifierSeedIndex must be an integer in [0, 99]');
  const sealed = normalizePack({ instance, pack, seedKey });
  const source = typeof candidateTree === 'string' ? candidateTree : candidateTree?.workspace ?? workspace;
  invariant(typeof source === 'string', 'verifyPhase requires workspace or candidateTree');
  let checks;
  const infrastructureErrors = [];
  if (phase === 4) {
    const candidateWorkspace = path.resolve(workspace ?? source);
    let trustedContract;
    try {
      const explicitPhaseFour = contract?.phase === 4 ? contract : null;
      trustedContract = await trustedPhaseFourContract(candidateWorkspace, explicitPhaseFour ?? phaseContracts?.[4] ?? phaseContracts?.['4'] ?? phaseContracts?.['phase-04']);
      checks = await verifyIncident({
        workspace: candidateWorkspace,
        source: path.resolve(source),
        pack: sealed,
        contract: trustedContract,
      });
    } catch (error) {
      if (!(error instanceof InfrastructureError)) throw error;
      infrastructureErrors.push({ code: 'V7_PHASE4_CONTROL_INFRASTRUCTURE', requirementId: null, message: error.message });
      checks = await Promise.all(requirementsForPhase(4).map((requirement) => {
        const unavailable = async () => { throw new Error('phase-4 verification unavailable because its trusted control contract is missing'); };
        return check(requirement, requirement.group === 'private' ? { atomic: unavailable, composed: unavailable } : unavailable);
      }));
    }
  } else {
    checks = await withCandidateCopy(path.resolve(source), async (candidate) => {
      const seed = phaseSeed(sealed, phase, seedKey, verifierSeedIndex);
      if (phase === 1) return verifyMigration(candidate, seed);
      if (phase === 2) return verifyBatchPagination(candidate, seed);
      if (phase === 3) return verifyConcurrentLifecycle(candidate, seed, sealed, { durabilityTraceDirectory });
      return verifyRecoveryScale(candidate, seed);
    });
  }
  return scoreResult(sealed, phase, checks, startedAt, seedKey, verifierSeedIndex, { infrastructureErrors });
}

export function createV7CandidateFailureResult({
  instance,
  pack,
  phase,
  seedKey,
  verifierSeedIndex = 0,
  diagnostic = 'candidate overlay or declared artifact is invalid',
} = {}) {
  invariant(Number.isInteger(phase) && phase >= 1 && phase <= 5, 'candidate failure phase must be 1..5');
  invariant(Number.isInteger(verifierSeedIndex) && verifierSeedIndex >= 0 && verifierSeedIndex <= 99, 'verifierSeedIndex must be an integer in [0, 99]');
  const sealed = normalizePack({ instance, pack, seedKey });
  const message = String(diagnostic).slice(0, 500);
  const checks = requirementsForPhase(phase).map((requirement) => {
    const common = {
      id: requirement.id,
      family: requirement.family,
      group: requirement.group,
      weight: requirement.weight,
      points: 0,
      passed: false,
      diagnostic: message,
    };
    if (requirement.group === 'public') return { ...common, ...V7_VERIFIER_ASSERTIONS[requirement.id].public };
    return {
      ...common,
      classes: Object.fromEntries(['atomic', 'composed'].map((caseClass) => [caseClass, {
        ...V7_VERIFIER_ASSERTIONS[requirement.id][caseClass],
        weight: requirement.privateClassWeights[caseClass],
        points: 0,
        passed: false,
        diagnostic: message,
      }])),
    };
  });
  return scoreResult(sealed, phase, checks, Date.now(), seedKey, verifierSeedIndex, {
    infrastructureErrors: [],
    adaptability: { passed: 0, total: 1 },
  });
}

export function createV7CandidateTrajectoryFailureResult(options = {}) {
  const phase = options.phase;
  invariant(Number.isInteger(phase) && phase >= 1 && phase <= 5, 'candidate trajectory failure phase must be 1..5');
  const trajectoryPhases = Array.from({ length: phase }, (_, index) => createV7CandidateFailureResult({
    ...options,
    phase: index + 1,
  }));
  const current = trajectoryPhases.at(-1);
  const evaluatedPhases = trajectoryPhases.map((result) => result.phase);
  return {
    ...current,
    passed: false,
    adaptability: { passed: 0, total: 1 },
    regressions: Math.max(0, phase - 1),
    regressionGate: {
      schemaVersion: 'agentbattler.mini-ledger-v7.regression-gate.v1',
      evaluatedPhases,
      failedPhases: [...evaluatedPhases],
      passed: false,
    },
    trajectoryPhases,
  };
}

export async function verifyPhaseTrajectory(options = {}) {
  const phase = options.phase;
  invariant(Number.isInteger(phase) && phase >= 1 && phase <= 5, 'verifyPhaseTrajectory phase must be 1..5');
  const verifierSeedIndex = options.verifierSeedIndex ?? 0;
  const current = await verifyPhase(options);
  const priorResults = options.phaseResults ?? options.candidateTree?.phaseResults ?? [];
  const priorByPhase = new Map((Array.isArray(priorResults) ? priorResults : []).map((result) => [result?.phase, result]));
  const regressionResults = [];
  for (let earlier = 1; earlier < phase; earlier += 1) {
    if (earlier === 4) {
      const preserved = priorByPhase.get(4);
      if (preserved) {
        const sealed = normalizePack(options);
        regressionResults.push(validatedPreservedPhaseResult(preserved, sealed, 4, verifierSeedIndex));
      } else {
        const missing = createV7CandidateFailureResult({
          ...options,
          phase: 4,
          diagnostic: 'trusted phase-4 trajectory result is unavailable',
        });
        regressionResults.push({
          ...missing,
          infrastructureErrors: [{ code: 'V7_PHASE4_TRAJECTORY_INFRASTRUCTURE', requirementId: null, message: 'trusted phase-4 trajectory result is unavailable' }],
        });
      }
      continue;
    }
    regressionResults.push(await verifyPhase({ ...options, phase: earlier, contract: undefined }));
  }
  const evaluated = [...regressionResults, current];
  const infrastructureErrors = evaluated.flatMap((result) => result.infrastructureErrors.map((error) => ({ ...error, phase: result.phase })));
  const failedPhases = evaluated.filter(({ passed }) => !passed).map(({ phase: failedPhase }) => failedPhase);
  const passed = failedPhases.length === 0 && infrastructureErrors.length === 0;
  return {
    ...current,
    passed,
    infrastructureErrors,
    adaptability: { passed: passed ? 1 : 0, total: 1 },
    regressions: failedPhases.filter((failedPhase) => failedPhase < phase).length,
    regressionGate: {
      schemaVersion: 'agentbattler.mini-ledger-v7.regression-gate.v1',
      evaluatedPhases: Array.from({ length: phase }, (_, index) => index + 1),
      failedPhases,
      passed,
    },
    trajectoryPhases: evaluated,
  };
}

export async function verifyFinal(options = {}) {
  const startedAt = Date.now();
  const sealed = normalizePack(options);
  const preserved = options.phaseResults ?? options.candidateTree?.phaseResults ?? [];
  const preservedByPhase = new Map((Array.isArray(preserved) ? preserved : []).map((result) => [result?.phase, result]));
  const verifierSeedIndex = options.verifierSeedIndex ?? 0;
  const source = typeof options.candidateTree === 'string'
    ? options.candidateTree
    : options.candidateTree?.workspace ?? options.workspace;
  const phaseResults = [];
  if (typeof source === 'string') {
    for (let phase = 1; phase <= 5; phase += 1) {
      // Phase 4 is a historical no-source-change checkpoint. Later phases may
      // legitimately modify executable source, so preserve its trusted result;
      // every behavioral phase is re-run against the final candidate tree.
      const historical = phase === 4 ? preservedByPhase.get(4) : null;
      phaseResults.push(historical
        ? validatedPreservedPhaseResult(historical, sealed, phase, verifierSeedIndex)
        : await verifyPhase({ ...options, pack: sealed, phase }));
    }
  } else {
    // Harbor's final host aggregator does not receive candidate bytes. Its
    // phase-5 verifier already re-runs phases 1, 2, 3, and 5 against the final
    // tree; consume those requirement-level outcomes, never the older phase
    // checkpoints. Phase 4 remains the independently preserved forensic proof.
    const terminal = validatedPreservedPhaseResult(preservedByPhase.get(5), sealed, 5, verifierSeedIndex);
    invariant(Array.isArray(terminal.trajectoryPhases) && terminal.trajectoryPhases.length === 5, 'final V7 trajectory requirement outcomes are unavailable');
    const finalByPhase = new Map(terminal.trajectoryPhases.map((result) => [result?.phase, result]));
    invariant(finalByPhase.size === 5, 'final V7 trajectory phase set is incomplete');
    for (let phase = 1; phase <= 5; phase += 1) {
      const selected = phase === 4 ? preservedByPhase.get(4) : finalByPhase.get(phase);
      phaseResults.push(validatedPreservedPhaseResult(selected, sealed, phase, verifierSeedIndex));
    }
  }
  const checks = phaseResults.flatMap(({ requirements }) => requirements);
  const infrastructureErrors = phaseResults.flatMap((result) => result.infrastructureErrors.map((error) => ({ ...error, phase: result.phase })));
  const completeCheckpointHistory = Array.from({ length: 5 }, (_, index) => preservedByPhase.has(index + 1));
  const adaptabilityResults = completeCheckpointHistory.every(Boolean)
    ? Array.from({ length: 5 }, (_, index) => validatedPreservedPhaseResult(preservedByPhase.get(index + 1), sealed, index + 1, verifierSeedIndex))
    : phaseResults;
  const adaptability = { passed: adaptabilityResults.filter(({ passed }) => passed).length, total: 5 };
  return {
    ...scoreResult(sealed, null, checks, startedAt, options.seedKey, verifierSeedIndex, { infrastructureErrors, adaptability }),
    phases: phaseResults,
  };
}
