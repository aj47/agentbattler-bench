import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

const V7_PACKAGE_COMMANDS = Object.freeze([
  'terminal:verifier:image:v7',
  'terminal:seal:v7',
  'terminal:seal:v7:init',
  'terminal:harbor:build:v7',
  'terminal:golds:v7',
  'terminal:quality:v7',
  'terminal:preflight:v7',
  'terminal:scripted-references:v7',
  'terminal:gates:base:v7',
  'terminal:pilot:build:v7',
  'terminal:pilot:run:v7',
  'terminal:pilot:report:v7',
  'terminal:matrix:v7',
  'terminal:reserve:build:v7',
  'terminal:reserve:run:v7',
  'terminal:reserve:report:v7',
  'terminal:retire:v7',
  'terminal:run:v7',
  'terminal:verify:v7',
  'terminal:traces:v7',
]);

const V7_R2_FALLBACKS = Object.freeze([
  ['scripts/assemble-terminal-v7-base-gates.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/build-terminal-v7-pilot.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/build-terminal-v7-reserve.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/build-terminal-v7-schedule.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/export-terminal-v7-traces.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/report-terminal-v7-pilot.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/report-terminal-v7-reserve.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/retire-terminal-v7.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/run-terminal-v7-matrix.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/run-terminal-v7-pilot-job.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/run-terminal-v7-quality-gates.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/run-terminal-v7-reserve.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/run-terminal-v7-scripted-references.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/run-terminal-v7-test-preflights.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/seal-terminal-v7-packs.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/terminal-adapter-harbor.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/validate-terminal-v7-golds.mjs', /revision = 'r2'/],
  ['scripts/validate-terminal-v7-golds.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['scripts/verify-terminal-v7-results.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['src/terminal-v7-direct.mjs', /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION \?\? 'r2'/],
  ['src/terminal-v7.mjs', /protocolRevision = 'r2'/],
]);

test('V7 production package commands pin protocol R2 and R2 result tags', async () => {
  const document = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of V7_PACKAGE_COMMANDS) {
    const command = document.scripts?.[name];
    assert.equal(typeof command, 'string', `missing V7 package command ${name}`);
    assert.match(command, /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION=r2(?:\s|$)/, `${name} does not pin R2`);
    assert.doesNotMatch(command, /AGENTBATTLER_TERMINAL_PROTOCOL_REVISION=r1(?:\s|$)/, `${name} still pins R1`);
  }
  for (const name of ['terminal:matrix:v7', 'terminal:run:v7', 'terminal:verify:v7', 'terminal:traces:v7']) {
    assert.match(document.scripts[name], /AGENTBATTLER_TERMINAL_RESULT_TAG=v7-r2(?:\s|$)/, `${name} does not pin the R2 result root`);
  }
});

test('V7 production entry points default to R2', async () => {
  for (const [relative, expectation] of V7_R2_FALLBACKS) {
    const source = await readFile(path.join(ROOT, relative), 'utf8');
    assert.match(source, expectation, `${relative} does not default to R2`);
  }
  const genericRunner = await readFile(path.join(ROOT, 'scripts/run-terminal-matrix.mjs'), 'utf8');
  assert.match(genericRunner, /challengeVersion === 'v7' \? 'v7-r2'/);
  assert.doesNotMatch(genericRunner, /challengeVersion === 'v7' \? 'v7-r1'/);
});
