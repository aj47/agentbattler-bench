#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(ROOT, 'scripts/run-terminal-matrix.mjs');
const version = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
const v4Adapter = version === 'v4' ? 'scripts/terminal-adapter-all.mjs' : null;
const passes = Number.parseInt(process.env.AGENTBATTLER_TERMINAL_RETRY_PASSES ?? '3', 10);
if (!Number.isSafeInteger(passes) || passes < 1) throw new Error('AGENTBATTLER_TERMINAL_RETRY_PASSES must be a positive integer');

const jobs = [
  { harness: 'codex-cli', adapter: v4Adapter ?? 'scripts/terminal-adapter-codex.mjs', concurrency: process.env.AGENTBATTLER_CODEX_CONCURRENCY ?? '2' },
  { harness: 'pi-coding-agent', adapter: v4Adapter ?? 'scripts/terminal-adapter-pi.mjs', concurrency: process.env.AGENTBATTLER_PI_CONCURRENCY ?? '2' },
  // DotAgents is deliberately single-filed: the container is memory-heavy and
  // its stateful trace can be very large even when the trace is streamed.
  { harness: 'dotagents-mono', adapter: v4Adapter ?? 'scripts/terminal-adapter-dotagents.mjs', concurrency: process.env.AGENTBATTLER_DOTAGENTS_CONCURRENCY ?? '1' },
  // Claude's ChatGPT OAuth refresh token is single-use and is brokered for the
  // lifetime of a gateway, so Claude jobs must be serialized.
  { harness: 'claude-code', adapter: v4Adapter ?? 'scripts/terminal-adapter-claude.mjs', concurrency: process.env.AGENTBATTLER_CLAUDE_CONCURRENCY ?? '1' },
];

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { cwd: ROOT, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

for (const job of jobs) {
  for (let pass = 1; pass <= passes; pass += 1) {
    console.log(`\n=== ${job.harness}: pass ${pass}/${passes} ===`);
    const result = await run(runner, [
      '--adapter', job.adapter,
      '--harness', job.harness,
      '--concurrency', job.concurrency,
      '--retry-invalid',
    ], { ...process.env, AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version });
    if (result.code !== 0) throw new Error(`${job.harness} runner exited ${result.code ?? result.signal}`);

    const verify = await run(path.join(ROOT, 'scripts/verify-terminal-results.mjs'), ['--allow-incomplete'], {
      ...process.env,
      AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version,
    });
    if (verify.code !== 0) throw new Error(`Verification process exited ${verify.code ?? verify.signal}`);
    // The per-harness runner is intentionally followed by another pass when
    // invalid jobs remain. The final strict verifier is run after all harnesses.
    // Avoid parsing human output here; the sealed result files are the source
    // of truth and the strict verifier below decides completion.
    if (pass === passes) break;
  }
}

const final = await run(path.join(ROOT, 'scripts/verify-terminal-results.mjs'), [], {
  ...process.env,
  AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version,
});
if (final.code !== 0) process.exitCode = final.code ?? 1;
