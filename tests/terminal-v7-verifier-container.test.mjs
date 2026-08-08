import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import os from 'node:os';
import path from 'node:path';

import {
  TERMINAL_V7_VERIFIER_IMAGE,
  TERMINAL_V7_VERIFIER_IMAGE_COPY_LAYOUT,
  TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT,
  terminalV7VerifierRunArguments,
  terminalV7VerifierSourceDescriptor,
} from '../src/terminal-v7-verifier-container.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function dockerfileCopyLayout(dockerfile) {
  return dockerfile.split(/\r?\n/).flatMap((line) => {
    const tokens = line.trim().split(/\s+/);
    return tokens[0] === 'COPY' ? [{ source: tokens[1], destination: tokens[2] }] : [];
  });
}

function verifierImageFiles(descriptor) {
  const imageFiles = new Map();
  for (const { source, destination } of TERMINAL_V7_VERIFIER_IMAGE_COPY_LAYOUT) {
    const copied = descriptor.files.filter(({ path: sourcePath }) => sourcePath === source || sourcePath.startsWith(`${source}/`));
    assert.ok(copied.length > 0, `committed COPY source is empty: ${source}`);
    for (const record of copied) {
      const imagePath = record.path === source
        ? destination
        : path.posix.join(destination, record.path.slice(source.length + 1));
      assert.ok(!imageFiles.has(imagePath), `duplicate verifier image destination: ${imagePath}`);
      imageFiles.set(imagePath, record.path);
    }
  }
  return imageFiles;
}

test('V7 direct-verifier image source is deterministic and binds the private verifier boundary', async () => {
  const [first, second, dockerfile, runner] = await Promise.all([
    terminalV7VerifierSourceDescriptor(),
    terminalV7VerifierSourceDescriptor(),
    readFile(new URL('../benchmark/verifier/mini-ledger-v7/Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../benchmark/verifier/mini-ledger-v7/run.mjs', import.meta.url), 'utf8'),
  ]);
  assert.deepEqual(first, second);
  assert.equal(TERMINAL_V7_VERIFIER_IMAGE, 'agentbattler-mini-ledger-v7-verifier:r2');
  assert.match(first.sourceSha256, /^[0-9a-f]{64}$/);
  assert.ok(first.files.some(({ path }) => path.endsWith('/verifier.mjs')));
  assert.match(dockerfile, /strace/);
  assert.match(dockerfile, /verifier-source-sha256/);
  assert.match(runner, /candidateCapabilityMask/);
  assert.match(runner, /durabilityTraceDirectory: '\/evidence\/durability'/);
  const containerSource = await readFile(new URL('../src/terminal-v7-verifier-container.mjs', import.meta.url), 'utf8');
  assert.match(containerSource, /seccomp=unconfined/);
});

test('V7 verifier Docker layout preserves and commits the complete runtime module graph', async () => {
  const [descriptor, dockerfile] = await Promise.all([
    terminalV7VerifierSourceDescriptor(),
    readFile(path.join(ROOT, 'benchmark/verifier/mini-ledger-v7/Dockerfile'), 'utf8'),
  ]);
  assert.deepEqual(dockerfileCopyLayout(dockerfile), TERMINAL_V7_VERIFIER_IMAGE_COPY_LAYOUT);
  assert.match(
    dockerfile,
    new RegExp(`ENTRYPOINT \\["node", "${TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT.replaceAll('/', '\\/')}"\\]`),
  );
  assert.match(
    dockerfile,
    new RegExp(`await import\\('${TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT.replaceAll('/', '\\/')}'\\)`),
  );

  const imageFiles = verifierImageFiles(descriptor);
  assert.equal(imageFiles.get(TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT), 'benchmark/verifier/mini-ledger-v7/run.mjs');

  const copiedSources = [...imageFiles.values()].sort();
  const committedCopiedSources = descriptor.files
    .map(({ path: sourcePath }) => sourcePath)
    .filter((sourcePath) => sourcePath !== 'benchmark/verifier/mini-ledger-v7/Dockerfile')
    .sort();
  assert.deepEqual(committedCopiedSources, copiedSources, 'source hash must bind every file copied into the verifier image');

  for (const [imagePath, sourcePath] of imageFiles) {
    if (!imagePath.endsWith('.mjs')) continue;
    const source = await readFile(path.join(ROOT, sourcePath), 'utf8');
    const importSpecifiers = [...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of importSpecifiers) {
      const dependency = path.posix.resolve(path.posix.dirname(imagePath), specifier);
      assert.ok(imageFiles.has(dependency), `${imagePath} imports missing image module ${dependency}`);
    }
  }
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
