#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runTerminalSchedule } from '../src/terminal-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeVersion = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
if (!/^v\d+$/.test(challengeVersion)) throw new Error('AGENTBATTLER_TERMINAL_CHALLENGE_VERSION must look like v2');
const RESULT_ROOT = path.join(ROOT, `results/terminal-mini-ledger-${challengeVersion}`);
const CHALLENGE_ROOT = path.join(ROOT, `benchmark/challenges/mini-ledger-${challengeVersion}`);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const challenge = JSON.parse(await readFile(path.join(RESULT_ROOT, 'challenge.json'), 'utf8'));
const schedule = JSON.parse(await readFile(path.join(RESULT_ROOT, 'schedule.json'), 'utf8'));
const adapterPath = arg('--adapter', process.env.AGENTBATTLER_TERMINAL_ADAPTER);
const retryInvalid = process.argv.includes('--retry-invalid');
const harnessArg = arg('--harness', process.env.AGENTBATTLER_TERMINAL_HARNESSES ?? '');
const onlyHarnesses = harnessArg.split(',').map((value) => value.trim()).filter(Boolean);
const modelArg = arg('--model', process.env.AGENTBATTLER_TERMINAL_MODELS ?? '');
const onlyModels = modelArg.split(',').map((value) => value.trim()).filter(Boolean);
const generationArg = arg('--generation', process.env.AGENTBATTLER_TERMINAL_GENERATIONS ?? '');
const onlyGenerationIndices = generationArg.split(',').map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isSafeInteger);
if (generationArg && onlyGenerationIndices.length !== generationArg.split(',').filter((value) => value.trim()).length) throw new Error('--generation must be a comma-separated list of integers');
const concurrency = Number.parseInt(arg('--concurrency', process.env.AGENTBATTLER_TERMINAL_CONCURRENCY ?? '1'), 10);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
if (!adapterPath) throw new Error('Set --adapter MODULE or AGENTBATTLER_TERMINAL_ADAPTER');
const adapter = await import(pathToFileURL(path.resolve(ROOT, adapterPath)).href);
if (typeof adapter.runTerminalJob !== 'function') throw new Error(`Adapter ${adapterPath} must export runTerminalJob`);
if (Array.isArray(adapter.harnesses)) {
  const required = onlyHarnesses.length ? onlyHarnesses : schedule.coverage.map((entry) => entry.combo.harness.id);
  const unsupported = [...new Set(required.filter((harness) => !adapter.harnesses.includes(harness)))];
  if (unsupported.length) throw new Error(`Adapter ${adapterPath} does not support harnesses: ${unsupported.join(', ')}; pass --harness for a supported subset or install the missing adapters`);
}
await mkdir(RESULT_ROOT, { recursive: true });

const summary = await runTerminalSchedule({
  challenge,
  schedule,
  resultRoot: RESULT_ROOT,
  challengeRoot: CHALLENGE_ROOT,
  retryInvalid,
  onlyHarnesses,
  onlyModels,
  onlyGenerationIndices,
  concurrency,
  runTerminalJob: adapter.runTerminalJob,
  onProgress: ({ job, status, error }) => console.log(`[${status}] ${job.artifactId}${error ? `: ${error}` : ''}`),
});
console.log(`Terminal matrix execution: ${summary.completed} completed, ${summary.invalid} infrastructure-invalid, ${summary.skipped} skipped, ${summary.failed} persisted-result failures (concurrency ${concurrency})`);
