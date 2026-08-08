import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('V7 official runner exposes only the sealed infrastructure-invalid retry path', async () => {
  const source = await readFile(new URL('../scripts/run-terminal-v7-matrix.mjs', import.meta.url), 'utf8');
  assert.match(source, /process\.argv\.includes\('--retry-invalid'\)/);
  assert.match(source, /retryInvalid:\s*RETRY_INVALID/);
  assert.match(source, /persistedSaturation/);
  assert.match(source, /readTerminalV7RevisionStopState/);
  assert.match(source, /ensureTerminalV7RevisionSaturationMarker/);
  assert.match(source, /shouldStopBeforeJob:[\s\S]*readTerminalV7RevisionStopState/);
  assert.match(source, /shouldStopBeforeJob:[\s\S]*persistedSaturation\(challenge, schedule\)/);
  assert.doesNotMatch(source, /retryProtocolInvalid|retryCompleted/);
});

test('V7 pilot CLI validates the earliest outstanding unit and saturation before its adapter boundary', async () => {
  const source = await readFile(new URL('../scripts/run-terminal-v7-pilot-job.mjs', import.meta.url), 'utf8');
  const callback = source.indexOf('callback: async () => {');
  const readiness = source.indexOf('await assertTerminalV7CalibrationInvocationReady({', callback);
  const execution = source.indexOf('const outcome = await runTerminalV7CalibrationExecutionUnit({', callback);
  assert.ok(callback >= 0 && readiness > callback && execution > readiness);
  assert.match(source.slice(execution), /shouldStopBeforeRun:[\s\S]*assertTerminalV7RevisionAcceptsNewWork/);
});

test('V7 official schedule builder rejects any existing result-root state before task mutation', async () => {
  const source = await readFile(new URL('../scripts/build-terminal-v7-schedule.mjs', import.meta.url), 'utf8');
  const guard = source.indexOf('await assertTerminalV7OfficialResultRootUnused({ resultRoot: RESULT_ROOT })');
  const taskBuild = source.indexOf('await buildHarborTerminalV7Tasks({');
  assert.ok(guard >= 0, 'official result-root guard is missing');
  assert.ok(taskBuild > guard, 'official tasks can be mutated before the result-root guard');
  assert.doesNotMatch(source, /persistedRuns\.length === 0/);
});
