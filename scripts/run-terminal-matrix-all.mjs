#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(ROOT, 'scripts/run-terminal-matrix.mjs');
const version = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? (version === 'v5' ? 'v5-r2' : version === 'v6' ? 'v6-luna-max-r11' : version);
const resultRoot = path.join(ROOT, `results/terminal-mini-ledger-${resultTag}`);
const schedule = JSON.parse(await readFile(path.join(resultRoot, 'schedule.json'), 'utf8'));
const v4Adapter = ['v4', 'v5', 'v6'].includes(version) ? 'scripts/terminal-adapter-all.mjs' : null;
const passes = Number.parseInt(process.env.AGENTBATTLER_TERMINAL_RETRY_PASSES ?? '3', 10);
if (!Number.isSafeInteger(passes) || passes < 1) throw new Error('AGENTBATTLER_TERMINAL_RETRY_PASSES must be a positive integer');

const configuredJobs = [
  { harness: 'codex-cli', adapter: v4Adapter ?? 'scripts/terminal-adapter-codex.mjs', concurrency: process.env.AGENTBATTLER_CODEX_CONCURRENCY ?? '2' },
  { harness: 'pi-coding-agent', adapter: v4Adapter ?? 'scripts/terminal-adapter-pi.mjs', concurrency: process.env.AGENTBATTLER_PI_CONCURRENCY ?? '2' },
  // DotAgents is deliberately single-filed: the container is memory-heavy and
  // its stateful trace can be very large even when the trace is streamed.
  { harness: 'dotagents-mono', adapter: v4Adapter ?? 'scripts/terminal-adapter-dotagents.mjs', concurrency: process.env.AGENTBATTLER_DOTAGENTS_CONCURRENCY ?? '1' },
  { harness: 'factory-droid', adapter: v4Adapter ?? 'scripts/terminal-adapter-droid.mjs', concurrency: process.env.AGENTBATTLER_DROID_CONCURRENCY ?? '1' },
  // Claude's ChatGPT OAuth refresh token is single-use and is brokered for the
  // lifetime of a gateway, so Claude jobs must be serialized.
  { harness: 'claude-code', adapter: v4Adapter ?? 'scripts/terminal-adapter-claude.mjs', concurrency: process.env.AGENTBATTLER_CLAUDE_CONCURRENCY ?? '1' },
];
const scheduledHarnesses = new Set(schedule.coverage.map((entry) => entry.combo.harness.id));
const jobs = configuredJobs.filter((job) => scheduledHarnesses.has(job.harness));
const generations = [...new Set(schedule.jobs.map((job) => job.generationIndex))].sort((left, right) => left - right);
if (!jobs.length || !generations.length) throw new Error('Terminal schedule has no runnable harness/generation jobs');

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { cwd: ROOT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function runBreadthPass({ retryInvalid, label }) {
  for (const generation of generations) {
    console.log(`\n=== generation ${generation}: ${label} ===`);
    for (const job of jobs) {
      console.log(`\n--- ${job.harness} generation ${generation} ---`);
      const args = [
        '--adapter', job.adapter,
        '--harness', job.harness,
        '--generation', String(generation),
        '--concurrency', job.concurrency,
      ];
      if (retryInvalid) args.push('--retry-invalid');
      const result = await run(runner, args, { ...process.env, AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version });
      if (result.code !== 0) throw new Error(`${job.harness} generation ${generation} runner exited ${result.code ?? result.signal}`);
    }

    const verify = await run(path.join(ROOT, 'scripts/verify-terminal-results.mjs'), ['--allow-incomplete'], {
      ...process.env,
      AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version,
    });
    if (verify.code !== 0) throw new Error(`Verification process exited ${verify.code ?? verify.signal}`);
  }
}

async function infrastructureInvalidCount() {
  let count = 0;
  for (const job of schedule.jobs) {
    try {
      const run = JSON.parse(await readFile(path.join(resultRoot, 'runs', `${job.runKey}.json`), 'utf8'));
      if (run.status === 'infrastructure-invalid') count += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return count;
}

await runBreadthPass({ retryInvalid: false, label: 'first coverage' });

for (let pass = 1; pass <= passes && await infrastructureInvalidCount() > 0; pass += 1) {
  console.log(`\n=== deferred infrastructure retry pass ${pass}/${passes} ===`);
  await runBreadthPass({ retryInvalid: true, label: `retry ${pass}/${passes}` });
}

const final = await run(path.join(ROOT, 'scripts/verify-terminal-results.mjs'), [], {
  ...process.env,
  AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version,
});
if (final.code !== 0) process.exitCode = final.code ?? 1;
