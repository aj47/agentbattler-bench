#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

import { verifyChecksumManifest } from '../src/provenance.mjs';
import { readSnapshot } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//;
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+/\-]{16,}|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
const SECRET_ASSIGNMENT = /\b[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*=[^\s,;]{12,}/i;
const HIDDEN_REASONING_KEY = /^(?:thinking|reasoning_content|thinking_signature|encrypted_content)$/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    packagePointer: path.join(ROOT, '.artifacts/terminal-publication-droid/latest.json'),
    snapshotRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--package-pointer') options.packagePointer = path.resolve(argv[++index]);
    else if (value === '--snapshot-root') options.snapshotRoot = path.resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

function inspectValue(value, state, key = '', protectedReasoning = false) {
  const protectedChild = protectedReasoning || HIDDEN_REASONING_KEY.test(key);
  if (typeof value === 'string') {
    invariant(!HOST_PATH.test(value), `Host path found in ${state.file}:${state.line}`);
    invariant(!SECRET_VALUE.test(value), `Credential-shaped value found in ${state.file}:${state.line}`);
    invariant(!SECRET_ASSIGNMENT.test(value), `Credential assignment found in ${state.file}:${state.line}`);
    if (value.includes('[REDACTED]')) state.redactions += 1;
    if (protectedChild && value.length > 0) {
      invariant(value === '[REDACTED]', `Unredacted hidden reasoning found in ${state.file}:${state.line}`);
    }
  } else if (Array.isArray(value)) {
    for (const child of value) inspectValue(child, state, key, protectedChild);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) inspectValue(child, state, childKey, protectedChild);
  }
}

async function auditTrace(file) {
  const state = { file: path.basename(file), line: 0, records: 0, redactions: 0, types: new Set() };
  const stream = createReadStream(file).pipe(createGunzip()).setEncoding('utf8');
  let pending = '';
  async function inspectLine(line) {
    state.line += 1;
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid trace JSON in ${state.file}:${state.line}: ${error.message}`);
    }
    state.records += 1;
    state.types.add(event.type ?? 'untyped');
    inspectValue(event, state);
  }
  for await (const chunk of stream) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      await inspectLine(pending.slice(0, newline).replace(/\r$/, ''));
      pending = pending.slice(newline + 1);
    }
  }
  if (pending) await inspectLine(pending.replace(/\r$/, ''));
  invariant(state.records > 0, `Trace is empty: ${state.file}`);
  invariant(state.types.has('trace_header') && state.types.has('trace_footer'), `Trace framing is incomplete: ${state.file}`);
  return state;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.snapshotRoot) {
    const pointer = JSON.parse(await readFile(options.packagePointer, 'utf8'));
    invariant(typeof pointer.snapshotRoot === 'string', 'Publication package pointer is invalid');
    options.snapshotRoot = path.resolve(pointer.snapshotRoot);
  }
  const snapshot = await readSnapshot(path.join(options.snapshotRoot, 'snapshot.unpublished.json'), { requirePublished: false });
  const datasetRoot = path.join(options.snapshotRoot, 'dataset');
  const manifest = JSON.parse(await readFile(path.join(datasetRoot, snapshot.dataset.manifest.path), 'utf8'));
  const checksumVerification = await verifyChecksumManifest(manifest, { root: datasetRoot });
  invariant(checksumVerification.ok, `Dataset checksum verification failed: ${JSON.stringify(checksumVerification.mismatches)}`);

  const traceRoot = path.join(datasetRoot, snapshot.dataset.root, 'traces');
  const traceFiles = (await readdir(traceRoot)).filter((name) => name.endsWith('.jsonl.gz')).sort();
  invariant(traceFiles.length === snapshot.totals.runs, `Expected ${snapshot.totals.runs} traces, found ${traceFiles.length}`);
  let records = 0;
  let redactions = 0;
  for (const name of traceFiles) {
    const audited = await auditTrace(path.join(traceRoot, name));
    records += audited.records;
    redactions += audited.redactions;
    console.log(`${name}: ${audited.records} records; ${[...audited.types].sort().join(', ')}`);
  }
  console.log(`Publication audit passed: ${traceFiles.length} traces, ${records} JSON records, ${redactions} redacted values, checksum manifest verified.`);
}

main().catch((error) => {
  console.error(`Terminal publication audit: ${error.message}`);
  process.exitCode = 1;
});
