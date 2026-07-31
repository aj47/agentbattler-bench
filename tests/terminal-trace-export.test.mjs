import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

function runExporter(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('scripts/export-terminal-traces.mjs'), '--allow-incomplete'], {
      env: {
        ...process.env,
        AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: 'v5',
        AGENTBATTLER_TERMINAL_RESULT_TAG: 'v5-test',
        AGENTBATTLER_TERMINAL_RESULT_ROOT: root,
        AGENTBATTLER_TERMINAL_WORK_ROOT: path.join(root, 'work'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve()
      : reject(new Error(Buffer.concat(stderr).toString('utf8') || `exporter exited ${code}`)));
  });
}

test('trace exporter packages completed runs from an incomplete external result root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentbattler-traces-'));
  try {
    const runKey = 'a'.repeat(64);
    await mkdir(path.join(root, 'runs'), { recursive: true });
    await mkdir(path.join(root, 'work', runKey), { recursive: true });
    await writeFile(path.join(root, 'schedule.json'), `${JSON.stringify({ jobs: [{ runKey }, { runKey: 'b'.repeat(64) }] })}\n`);
    await writeFile(path.join(root, 'runs', `${runKey}.json`), `${JSON.stringify({
      runKey,
      artifactId: 'terminal-codex-cli-luna-01',
      harness: 'codex-cli',
      harnessVersion: 'test',
      model: 'gpt-5.6-luna',
      generationIndex: 1,
      status: 'completed',
      validity: 'valid',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      durationMs: 60_000,
      reasoningEffort: 'high',
      sessionId: 'session-test',
      sameSessionProof: { verified: true },
      toolCalls: [],
      usage: {},
      turns: [],
    })}\n`);
    for (let turn = 1; turn <= 15; turn += 1) {
      await writeFile(path.join(root, 'work', runKey, `turn-${turn}.jsonl`), `${JSON.stringify({
        type: 'done',
        turn,
        thinking: 'hidden reasoning must not be published',
        thinkingSignature: 'hidden-signature',
        encryptedContent: 'hidden-encrypted-content',
      })}\n`);
    }
    await runExporter(root);
    const manifest = JSON.parse(await readFile(path.join(root, 'trace-manifest.json'), 'utf8'));
    assert.equal(manifest.totals.runs, 1);
    assert.equal(manifest.totals.turns, 15);
    assert.equal(manifest.traces[0].runKey, runKey);
    const trace = gunzipSync(await readFile(path.join(root, 'traces', 'terminal-codex-cli-luna-01.jsonl.gz'))).toString('utf8');
    assert.doesNotMatch(trace, /hidden reasoning|hidden-signature|hidden-encrypted-content/);
    const done = trace.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.type === 'done');
    assert.equal(done.thinking, '[REDACTED]');
    assert.equal(done.thinkingSignature, '[REDACTED]');
    assert.equal(done.encryptedContent, '[REDACTED]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
