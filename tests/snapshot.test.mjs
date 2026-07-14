import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fileArtifact, fetchVerified, sealSnapshot, validateSnapshot } from '../src/snapshot.mjs';

function fixture(overrides = {}) {
  return sealSnapshot({
    schemaVersion: 'agentbattler.snapshot.v1',
    snapshotId: 'model-suite-2026-07-13',
    createdAt: '2026-07-13T19:07:29.238Z',
    source: { gitCommit: 'a'.repeat(40) },
    dataset: {
      repoType: 'dataset',
      repoId: 'techfren/agentbattler-bench',
      revision: 'b'.repeat(40),
      root: 'snapshots/model-suite-2026-07-13',
      siteData: { path: 'snapshots/model-suite-2026-07-13/site/site-data.json', sha256: 'c'.repeat(64), sizeBytes: 12 },
      manifest: { path: 'snapshots/model-suite-2026-07-13/manifest.json', sha256: 'd'.repeat(64), sizeBytes: 34 },
    },
    release: {
      repository: 'aj47/agentbattler-bench',
      tag: 'snapshot-model-suite-2026-07-13',
      archive: { path: 'agentbattler-model-suite-2026-07-13.tar.gz', sha256: 'e'.repeat(64), sizeBytes: 56 },
    },
    totals: { runs: 3, matches: 72, moves: 2302, tokens: 556657, toolCalls: 25 },
    ...overrides,
  });
}

test('validates a sealed immutable snapshot', () => {
  assert.equal(validateSnapshot(fixture()).snapshotId, 'model-suite-2026-07-13');
});

test('rejects a mutable Hugging Face revision', () => {
  const snapshot = fixture();
  snapshot.dataset.revision = 'main';
  assert.throws(() => validateSnapshot(snapshot), /commit SHA/);
});

test('rejects integrity changes after sealing', () => {
  const snapshot = fixture();
  snapshot.totals.runs = 4;
  assert.throws(() => validateSnapshot(snapshot), /integrity hash mismatch/);
});

test('rejects artifact path traversal', () => {
  const snapshot = fixture();
  snapshot.dataset.siteData.path = '../secret';
  assert.throws(() => validateSnapshot(snapshot), /relative and safe/);
});

test('downloads only content matching the declared size and hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-snapshot-test-'));
  try {
    const source = path.join(root, 'source.json');
    const destination = path.join(root, 'cache/site-data.json');
    await writeFile(source, '{"ok":true}\n');
    const artifact = await fileArtifact(source, 'site-data.json');
    const fetchImpl = async () => new Response(await readFile(source), { status: 200 });
    await fetchVerified(['https://example.invalid/site-data.json'], destination, artifact, { fetchImpl });
    assert.equal(await readFile(destination, 'utf8'), '{"ok":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when every downloaded copy is corrupt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-snapshot-test-'));
  try {
    const destination = path.join(root, 'cache/site-data.json');
    const artifact = { path: 'site-data.json', sha256: 'f'.repeat(64), sizeBytes: 4 };
    const fetchImpl = async () => new Response('nope', { status: 200 });
    await assert.rejects(fetchVerified(['https://one.invalid', 'https://two.invalid'], destination, artifact, { fetchImpl }), /All snapshot downloads failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
