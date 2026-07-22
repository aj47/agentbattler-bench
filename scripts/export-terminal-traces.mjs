#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

import { canonicalJson, canonicalJsonSha256 } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v4';
if (!/^v\d+$/.test(version)) throw new Error('Challenge version must look like v4');
const resultRoot = path.join(ROOT, `results/terminal-mini-ledger-${version}`);
const workRoot = path.resolve(process.env.AGENTBATTLER_TERMINAL_WORK_ROOT ?? path.join(resultRoot, 'work'));
const outputRoot = path.join(resultRoot, 'traces');

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|oauth|credential|secret)/i;
const SECRET_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
let redactionCount = 0;

function sanitize(value, key = '') {
  if (SECRET_KEY.test(key) && typeof value === 'string' && value.length > 0) {
    redactionCount += 1;
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    const normalized = value
      .replaceAll('/private/tmp/agentbattler-v4b-calibration', '$BENCH_ROOT')
      .replace(/\/Users\/aj(?:joobandi)?(?=\/|\b)/g, '$HOME');
    return normalized.replace(SECRET_VALUE, () => {
      redactionCount += 1;
      return '[REDACTED]';
    });
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeLine(stream, value) {
  if (!stream.write(`${canonicalJson(sanitize(value))}\n`)) await once(stream, 'drain');
}

async function scanLines(file, onLine) {
  const hash = createHash('sha256');
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  let pending = '';
  let lines = 0;
  for await (const chunk of stream) {
    hash.update(chunk, 'utf8');
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      lines += 1;
      if (line) await onLine(line);
    }
  }
  if (pending) {
    lines += 1;
    await onLine(pending.replace(/\r$/, ''));
  }
  return { sha256: hash.digest('hex'), lines };
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function lastNonEmptyLine(file) {
  const handle = await import('node:fs/promises').then(({ open }) => open(file, 'r'));
  try {
    const size = (await handle.stat()).size;
    const chunkSize = 1024 * 1024;
    let cursor = size;
    let suffix = '';
    while (cursor > 0) {
      const length = Math.min(chunkSize, cursor);
      cursor -= length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, cursor);
      suffix = buffer.toString('utf8') + suffix;
      const lines = suffix.trimEnd().split(/\r?\n/);
      if (lines.length > 1 || cursor === 0) return lines.at(-1) ?? '';
      if (suffix.length > 32 * 1024 * 1024) throw new Error(`Terminal event exceeds 32 MiB: ${file}`);
    }
    return '';
  } finally {
    await handle.close();
  }
}

function commonPrefixLength(left, right) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && canonicalJson(left[index]) === canonicalJson(right[index])) index += 1;
  return index;
}

async function exportRun(run) {
  const destination = path.join(outputRoot, `${run.artifactId}.jsonl.gz`);
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(destination, { mode: 0o644 });
  gzip.pipe(output);
  const sourceFiles = [];
  let omittedStreamingEvents = 0;
  let previousDotAgentsHistory = [];

  await writeLine(gzip, {
    type: 'trace_header',
    schemaVersion: 'agentbattler.terminal-semantic-trace.v1',
    artifactId: run.artifactId,
    runKey: run.runKey,
    harness: run.harness,
    harnessVersion: run.harnessVersion,
    model: run.model,
    generationIndex: run.generationIndex,
    transformation: run.harness === 'pi-coding-agent'
      ? 'All terminal events except cumulative message_update streaming snapshots; final message events are retained.'
      : run.harness === 'dotagents-mono'
        ? 'Each terminal done event is retained as a turn delta; cumulative progress snapshots are omitted.'
        : 'All JSONL terminal events are retained.',
  });

  for (let turn = 1; turn <= 15; turn += 1) {
    const file = path.join(workRoot, run.runKey, `turn-${turn}.jsonl`);
    const fileStat = await stat(file);
    const source = { turn, file: `turn-${turn}.jsonl`, bytes: fileStat.size, lines: 0, sha256: '' };
    await writeLine(gzip, { type: 'turn_boundary', turn });

    if (run.harness === 'dotagents-mono') {
      const [sha256, finalLine] = await Promise.all([fileSha256(file), lastNonEmptyLine(file)]);
      const event = JSON.parse(finalLine);
      if (event?.type !== 'done') throw new Error(`${run.artifactId} turn ${turn} does not end in a done event`);
      const history = event.data?.conversation_history ?? event.data?.conversationHistory ?? [];
      const prefix = commonPrefixLength(previousDotAgentsHistory, history);
      const replacement = prefix !== previousDotAgentsHistory.length;
      const projected = {
        type: 'done',
        data: {
          model: event.data?.model,
          conversationId: event.data?.conversation_id ?? event.data?.conversationId,
          content: event.data?.content ?? '',
          historyMode: replacement ? 'replacement' : 'append',
          historyBaseLength: replacement ? 0 : prefix,
          conversationHistory: replacement ? history : history.slice(prefix),
        },
      };
      await writeLine(gzip, projected);
      previousDotAgentsHistory = history;
      source.sha256 = sha256;
      // DotAgents progress events are cumulative snapshots. The terminal done
      // event carries the complete conversation and tool-call history.
      source.lines = null;
    } else {
      const metadata = await scanLines(file, async (line) => {
        if (run.harness === 'pi-coding-agent' && line.includes('"type":"message_update"')) {
          omittedStreamingEvents += 1;
          return;
        }
        await writeLine(gzip, JSON.parse(line));
      });
      source.sha256 = metadata.sha256;
      source.lines = metadata.lines;
    }

    const stderrFile = path.join(workRoot, run.runKey, `turn-${turn}.stderr`);
    try {
      const stderr = await readFile(stderrFile, 'utf8');
      if (stderr.trim()) await writeLine(gzip, { type: 'stderr', turn, text: stderr });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    sourceFiles.push(source);
  }

  await writeLine(gzip, { type: 'trace_footer', omittedStreamingEvents, sourceFiles });
  gzip.end();
  await finished(output);
  const publishedBytes = (await stat(destination)).size;
  const publishedSha256 = await fileSha256(destination);
  return {
    artifactId: run.artifactId,
    runKey: run.runKey,
    harness: run.harness,
    model: run.model,
    generationIndex: run.generationIndex,
    path: path.relative(ROOT, destination),
    publishedBytes,
    publishedSha256,
    sourceBytes: sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
    sourceFiles,
    omittedStreamingEvents,
  };
}

await mkdir(outputRoot, { recursive: true });
const runFiles = (await readdir(path.join(resultRoot, 'runs'))).filter((file) => file.endsWith('.json')).sort();
const runs = await Promise.all(runFiles.map((file) => readJson(path.join(resultRoot, 'runs', file))));
if (runs.length !== 60 || runs.some((run) => run.status !== 'completed')) throw new Error('Expected 60 completed v4 runs');

const traces = [];
for (const run of runs.sort((left, right) => left.artifactId.localeCompare(right.artifactId))) {
  console.log(`Exporting ${run.artifactId}`);
  traces.push(await exportRun(run));
}

const manifestUnsigned = {
  schemaVersion: 'agentbattler.terminal-trace-manifest.v1',
  challengeVersion: version,
  generatedAt: new Date().toISOString(),
  policy: {
    scope: 'All 60 successful run traces and all 15 turns per run.',
    retained: 'Final messages, tool calls and results, usage events, session metadata, verifier diagnostics, and non-empty stderr.',
    omitted: 'Only cumulative streaming snapshots whose final semantic content is retained.',
    redaction: 'Credential-shaped object values and bearer/JWT/API-key patterns are replaced with [REDACTED]; host paths are normalized.',
    rawWorkspaces: 'Not included. They contain transient harness profiles, credentials, repeated trace snapshots, and reproducible candidate files rather than additional model interaction evidence.',
  },
  totals: {
    runs: traces.length,
    turns: traces.length * 15,
    sourceBytes: traces.reduce((sum, trace) => sum + trace.sourceBytes, 0),
    publishedBytes: traces.reduce((sum, trace) => sum + trace.publishedBytes, 0),
    omittedStreamingEvents: traces.reduce((sum, trace) => sum + trace.omittedStreamingEvents, 0),
    redactions: redactionCount,
  },
  traces,
};
const manifest = { ...manifestUnsigned, manifestSha256: canonicalJsonSha256(manifestUnsigned) };
await writeFile(path.join(resultRoot, 'trace-manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);
console.log(`Published ${traces.length} semantic traces (${manifest.totals.publishedBytes} bytes) from ${manifest.totals.sourceBytes} source bytes`);
console.log(`Trace manifest: ${path.join(resultRoot, 'trace-manifest.json')}`);
