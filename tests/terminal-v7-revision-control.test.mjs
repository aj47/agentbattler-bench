import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson, canonicalJsonSha256, sha256 } from '../src/provenance.mjs';
import {
  assertTerminalV7OfficialResultRootUnused,
  assertTerminalV7RevisionAcceptsNewWork,
  ensureTerminalV7RevisionSaturationForRun,
  readTerminalV7RevisionStopState,
  writeTerminalV7RevisionSaturationMarker,
} from '../src/terminal-v7-revision-control.mjs';
import {
  createTerminalV7RetirementRecord,
  writeTerminalV7RetirementRecord,
} from '../src/terminal-v7-retirement.mjs';
import { readTerminalV7StrictRevisionStopState } from '../scripts/verify-terminal-v7-results.mjs';

async function persistRun(resultRoot, runKey = 'run-01') {
  const attemptId = 'attempt-01';
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-run.v1',
    runKey,
    instanceId: 'dev-01',
    status: 'completed',
    validity: 'valid',
    attemptId,
    evaluation: { score: 100 },
  };
  const run = { ...unsigned, resultSha256: canonicalJsonSha256(unsigned) };
  const current = path.join(resultRoot, 'runs', `${runKey}.json`);
  const attempt = path.join(resultRoot, 'attempts', runKey, `${attemptId}.json`);
  await Promise.all([mkdir(path.dirname(current), { recursive: true }), mkdir(path.dirname(attempt), { recursive: true })]);
  await Promise.all([current, attempt].map((file) => writeFile(file, `${canonicalJson(run, { space: 2 })}\n`, { mode: 0o600 })));
  return { run, current, job: { runKey, instanceId: 'dev-01', harness: { id: 'codex-cli' } } };
}

test('V7 official schedule construction accepts only an absent or empty result root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-official-root-'));
  await assert.doesNotReject(assertTerminalV7OfficialResultRootUnused({ resultRoot: path.join(temporary, 'absent') }));
  const empty = path.join(temporary, 'empty');
  await mkdir(empty);
  await assert.doesNotReject(assertTerminalV7OfficialResultRootUnused({ resultRoot: empty }));

  const directoryState = ['runs', 'attempts', 'work', 'work-attempts', 'locks', 'runner-lock-history', 'control'];
  const fileState = ['challenge.json', 'schedule.json', 'runner.lock', 'runner.pid', 'runner.log', 'runner-state.json', 'unexpected-artifact'];
  for (const entry of directoryState) {
    const root = path.join(temporary, `directory-${entry}`);
    await mkdir(path.join(root, entry), { recursive: true });
    await assert.rejects(assertTerminalV7OfficialResultRootUnused({ resultRoot: root }), /preexisting result state/);
  }
  for (const entry of fileState) {
    const root = path.join(temporary, `file-${entry.replaceAll('.', '-')}`);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, entry), 'orphan state\n');
    await assert.rejects(assertTerminalV7OfficialResultRootUnused({ resultRoot: root }), /preexisting result state/);
  }
});

test('V7 Core-100 saturation state is revision-global and backed by the exact current attempt', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-revision-control-'));
  const controlRoot = path.join(temporary, 'revision-control');
  const resultRoot = path.join(temporary, 'pilot-results');
  const { run, current, job } = await persistRun(resultRoot);
  const marker = await writeTerminalV7RevisionSaturationMarker({
    controlRoot,
    revision: 'r1',
    campaign: 'development-pilot',
    resultRoot,
    job,
    run,
    scoreRun: () => ({ corePoints: 100 }),
    detectedAt: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(marker.detectedCore, 100);
  assert.equal((await readTerminalV7RevisionStopState({ controlRoot, revision: 'r1', scoreRun: () => ({ corePoints: 100 }) })).status, 'saturation-pending');
  await assert.rejects(assertTerminalV7RevisionAcceptsNewWork({ controlRoot, revision: 'r1' }), /pending Core-100 saturation audit/);
  await assert.rejects(writeTerminalV7RevisionSaturationMarker({
    controlRoot,
    revision: 'r1',
    campaign: 'official-release',
    resultRoot,
    job,
    run,
    scoreRun: () => ({ core: { points: 100 } }),
  }), { code: 'EEXIST' });
  await writeFile(current, `${canonicalJson({ ...run, resultSha256: '0'.repeat(64) })}\n`);
  await assert.rejects(readTerminalV7RevisionStopState({ controlRoot, revision: 'r1' }), /bytes changed/);
});

test('V7 Core-100 recovery recreates a missing marker from an already-persisted completed run', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-revision-recovery-'));
  const controlRoot = path.join(temporary, 'revision-control');
  const resultRoot = path.join(temporary, 'pilot-results');
  const { run, job } = await persistRun(resultRoot, 'recovered-run');
  const options = {
    controlRoot,
    revision: 'r1',
    campaign: 'development-pilot',
    resultRoot,
    job,
    run,
    scoreRun: () => ({ corePoints: 100 }),
    detectedAt: '2026-08-08T12:00:00.000Z',
  };
  const recovered = await ensureTerminalV7RevisionSaturationForRun(options);
  const idempotent = await ensureTerminalV7RevisionSaturationForRun(options);
  assert.equal(recovered.markerSha256, idempotent.markerSha256);
  assert.equal((await readTerminalV7RevisionStopState({ controlRoot, revision: 'r1' })).status, 'saturation-pending');
});

test('V7 revision stop state resolves retirement source artifacts from the shared control root', async () => {
  const controlRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-revision-retired-'));
  const evidenceBytes = 'private pack leakage evidence\n';
  const relative = 'retirement-evidence/private-pack-leakage.json';
  const evidenceFile = path.join(controlRoot, ...relative.split('/'));
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, evidenceBytes);
  const digest = sha256(evidenceBytes);
  const record = createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    privatePackLeakage: {
      detected: true,
      evidenceSha256: digest,
      evidenceArtifact: { path: relative, sizeBytes: Buffer.byteLength(evidenceBytes), sha256: digest },
    },
  });
  await writeTerminalV7RetirementRecord({ resultRoot: controlRoot, record });
  const state = await readTerminalV7RevisionStopState({ controlRoot, revision: 'r1' });
  assert.equal(state.status, 'retired');
  assert.equal(state.retirement.recordSha256, record.recordSha256);
  const strictState = await readTerminalV7StrictRevisionStopState({
    root: path.dirname(controlRoot),
    revision: 'r1',
    env: { AGENTBATTLER_V7_REVISION_CONTROL_ROOT: controlRoot },
  });
  assert.equal(strictState.status, 'retired');
  assert.equal(strictState.retirement.recordSha256, record.recordSha256);
});
