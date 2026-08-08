import assert from 'node:assert/strict';
import test from 'node:test';

import { loadV7Pack, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';

import {
  createTerminalV7SealManifest,
  validateTerminalV7SealManifest,
} from '../src/terminal-v7-seals.mjs';

const KEY = 'test-only-v7-evaluator-seed-key';

test('V7 precommits three development, five release, and five reserve twin packs', () => {
  const manifest = createTerminalV7SealManifest({ revision: 'r1', seedKey: KEY, sealedAt: '2026-08-08T07:30:00.000Z' });
  assert.equal(validateTerminalV7SealManifest(manifest, { seedKey: KEY }), manifest);
  assert.equal(manifest.packs.length, 13);
  assert.equal(manifest.packs.filter(({ pool }) => pool === 'dev').length, 3);
  assert.equal(manifest.packs.filter(({ pool }) => pool === 'release').length, 5);
  assert.equal(manifest.packs.filter(({ pool }) => pool === 'reserve').length, 5);
  assert.ok(manifest.packs.every(({ clean, decoy }) => clean.hiddenMerkleRoot === decoy.hiddenMerkleRoot));
  assert.ok(manifest.packs.every(({ clean, decoy }) => clean.starterTreeSha256 !== decoy.starterTreeSha256));
  const dev = manifest.packs.find(({ instanceId }) => instanceId === 'dev-01');
  assert.equal(dev.decoy.sealSha256, sealV7Pack(loadV7Pack('dev-01', { variant: 'decoy' })).sealSha256);
});

test('V7 seal manifest rejects post-seal pack substitution', () => {
  const manifest = createTerminalV7SealManifest({ revision: 'r1', seedKey: KEY, sealedAt: '2026-08-08T07:30:00.000Z' });
  const tampered = structuredClone(manifest);
  tampered.packs[0].decoy.starterTreeSha256 = '0'.repeat(64);
  assert.throws(() => validateTerminalV7SealManifest(tampered), /manifest hash mismatch/);
});
