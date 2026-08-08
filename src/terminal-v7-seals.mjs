import {
  assertV7PackSeal,
  listV7Packs,
  sealV7Pack,
  V7_POOL_INSTANCES,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { canonicalJsonSha256 } from './provenance.mjs';

export const TERMINAL_V7_SEAL_MANIFEST_SCHEMA = 'agentbattler.mini-ledger-v7.seal-manifest.v1';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function publicSeal(pack) {
  return {
    schemaVersion: pack.schemaVersion,
    challengeId: pack.challengeId,
    instanceId: pack.instanceId,
    pool: pack.pool,
    variant: pack.variant,
    twinVariant: pack.twinVariant,
    scenarioId: pack.scenarioId,
    seedFingerprint: pack.seedFingerprint,
    packSha256: pack.packSha256,
    starterTreeSha256: pack.starterTreeSha256,
    phaseDeltaSha256: pack.phaseDeltaSha256,
    phases: pack.phases,
    paths: pack.paths,
    requirementsSha256: pack.requirementsSha256,
    requirementMapSha256: pack.requirementMapSha256,
    perPhaseLimitMs: pack.perPhaseLimitMs,
    artifactPolicy: pack.artifactPolicy,
    verifierHashes: pack.verifierHashes,
    rubricVersion: pack.rubricVersion,
    feedbackPolicy: pack.feedbackPolicy,
    hiddenMerkleRoot: pack.hiddenMerkleRoot,
    hiddenCaseCount: pack.hiddenCaseCount,
    twinRelationSha256: pack.twinRelationSha256,
    sealSha256: pack.sealSha256,
  };
}

export function createTerminalV7SealManifest({
  revision,
  seedKey,
  sealedAt,
} = {}) {
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 seal-manifest revision must look like r1');
  invariant(typeof seedKey === 'string' && seedKey.length >= 16, 'V7 evaluator-held seed key must have at least 16 characters');
  invariant(typeof sealedAt === 'string' && Number.isFinite(Date.parse(sealedAt)), 'V7 sealedAt must be an ISO timestamp');
  const packs = [];
  for (const pool of ['dev', 'release', 'reserve']) {
    for (const decoy of listV7Packs({ pool, variant: 'decoy' })) {
      const clean = listV7Packs({ pool, variant: 'clean' }).find(({ instanceId }) => instanceId === decoy.instanceId);
      invariant(clean, `V7 clean twin is missing for ${decoy.instanceId}`);
      const packSeedKey = pool === 'dev' ? undefined : seedKey;
      const sealedDecoy = sealV7Pack(decoy, { seedKey: packSeedKey });
      const sealedClean = sealV7Pack(clean, { seedKey: packSeedKey });
      invariant(sealedDecoy.hiddenMerkleRoot === sealedClean.hiddenMerkleRoot, `V7 twin hidden roots differ for ${decoy.instanceId}`);
      invariant(sealedDecoy.twinRelationSha256 === sealedClean.twinRelationSha256, `V7 twin relation differs for ${decoy.instanceId}`);
      packs.push({
        instanceId: decoy.instanceId,
        pool,
        twinRelationSha256: sealedDecoy.twinRelationSha256,
        hiddenMerkleRoot: sealedDecoy.hiddenMerkleRoot,
        decoy: publicSeal(sealedDecoy),
        clean: publicSeal(sealedClean),
      });
    }
  }
  const unsigned = {
    schemaVersion: TERMINAL_V7_SEAL_MANIFEST_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    revision,
    sealedAt,
    policy: {
      createdBeforeFrontierPilotResults: true,
      scoredVariant: 'decoy',
      cleanTwinUse: 'calibration-only',
      releaseSelectionFromModelResults: 'forbidden',
    },
    pools: Object.fromEntries(Object.entries(V7_POOL_INSTANCES).map(([pool, instances]) => [pool, [...instances]])),
    packs,
  };
  return { ...unsigned, manifestSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7SealManifest(manifest, { seedKey = null } = {}) {
  invariant(manifest?.schemaVersion === TERMINAL_V7_SEAL_MANIFEST_SCHEMA, 'Unsupported V7 seal-manifest schema');
  const { manifestSha256, ...unsigned } = manifest;
  invariant(manifestSha256 === canonicalJsonSha256(unsigned), 'V7 seal-manifest hash mismatch');
  invariant(/^r[1-9]\d*$/.test(manifest.revision ?? ''), 'V7 seal-manifest revision is invalid');
  invariant(manifest.policy?.createdBeforeFrontierPilotResults === true && manifest.policy?.scoredVariant === 'decoy' && manifest.policy?.cleanTwinUse === 'calibration-only' && manifest.policy?.releaseSelectionFromModelResults === 'forbidden', 'V7 seal-manifest policy changed');
  invariant(Array.isArray(manifest.packs) && manifest.packs.length === 13, 'V7 seal manifest must contain 13 twin packs');
  invariant(new Set(manifest.packs.map(({ instanceId }) => instanceId)).size === 13, 'V7 seal manifest contains duplicate instances');
  for (const pool of ['dev', 'release', 'reserve']) {
    const expected = V7_POOL_INSTANCES[pool];
    invariant(JSON.stringify(manifest.pools?.[pool]) === JSON.stringify(expected), `V7 ${pool} pool changed`);
    invariant(manifest.packs.filter((pack) => pack.pool === pool).length === expected.length, `V7 ${pool} pool cardinality changed`);
  }
  for (const twin of manifest.packs) {
    invariant(twin.clean?.variant === 'clean' && twin.decoy?.variant === 'decoy', `V7 twins are mislabeled for ${twin.instanceId}`);
    invariant(twin.clean.instanceId === twin.instanceId && twin.decoy.instanceId === twin.instanceId, `V7 twin identity mismatch for ${twin.instanceId}`);
    invariant(twin.clean.hiddenMerkleRoot === twin.hiddenMerkleRoot && twin.decoy.hiddenMerkleRoot === twin.hiddenMerkleRoot, `V7 twin hidden root mismatch for ${twin.instanceId}`);
    invariant(twin.clean.twinRelationSha256 === twin.twinRelationSha256 && twin.decoy.twinRelationSha256 === twin.twinRelationSha256, `V7 twin relation mismatch for ${twin.instanceId}`);
    if (seedKey) {
      const packSeedKey = twin.pool === 'dev' ? undefined : seedKey;
      assertV7PackSeal(twin.clean, { seedKey: packSeedKey });
      assertV7PackSeal(twin.decoy, { seedKey: packSeedKey });
    }
  }
  return manifest;
}
