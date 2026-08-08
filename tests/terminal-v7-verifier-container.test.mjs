import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import os from 'node:os';
import path from 'node:path';

import {
  TERMINAL_V7_VERIFIER_IMAGE,
  terminalV7VerifierRunArguments,
  terminalV7VerifierSourceDescriptor,
} from '../src/terminal-v7-verifier-container.mjs';

test('V7 direct-verifier image source is deterministic and binds the private verifier boundary', async () => {
  const [first, second, dockerfile, runner] = await Promise.all([
    terminalV7VerifierSourceDescriptor(),
    terminalV7VerifierSourceDescriptor(),
    readFile(new URL('../benchmark/verifier/mini-ledger-v7/Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../benchmark/verifier/mini-ledger-v7/run.mjs', import.meta.url), 'utf8'),
  ]);
  assert.deepEqual(first, second);
  assert.match(first.sourceSha256, /^[0-9a-f]{64}$/);
  assert.ok(first.files.some(({ path }) => path.endsWith('/verifier.mjs')));
  assert.match(dockerfile, /strace/);
  assert.match(dockerfile, /verifier-source-sha256/);
  assert.match(runner, /candidateCapabilityMask/);
  assert.match(runner, /durabilityTraceDirectory: '\/evidence\/durability'/);
  const containerSource = await readFile(new URL('../src/terminal-v7-verifier-container.mjs', import.meta.url), 'utf8');
  assert.match(containerSource, /seccomp=unconfined/);
});

test('V7 verifier executes the inspected immutable image ID after a mutable-tag swap', () => {
  const root = path.join(os.tmpdir(), 'agentbattler-v7-verifier-argv-test');
  const inspectedImage = {
    image: TERMINAL_V7_VERIFIER_IMAGE,
    imageId: `sha256:${'a'.repeat(64)}`,
  };
  const args = terminalV7VerifierRunArguments({
    verifierImage: inspectedImage,
    workspace: path.join(root, 'candidate'),
    input: path.join(root, 'input'),
    output: path.join(root, 'output'),
    evidenceDirectory: path.join(root, 'evidence'),
  });

  // A tag can now resolve to arbitrary replacement bytes without changing the
  // already-built argv. The invocation must contain only the inspected ID.
  const replacementImageId = `sha256:${'b'.repeat(64)}`;
  assert.notEqual(replacementImageId, inspectedImage.imageId);
  assert.equal(args.at(-1), inspectedImage.imageId);
  assert.ok(!args.includes(TERMINAL_V7_VERIFIER_IMAGE));
  assert.ok(!args.includes(replacementImageId));
});
