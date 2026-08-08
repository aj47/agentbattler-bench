import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  V7_AUXILIARY_TWIN_CLASSES,
  V7_POOL_INSTANCES,
  assertV7PhasePayloadCommitment,
  bindV7PhaseEntryContract,
  buildV7IncidentEvidence,
  hashV7ExecutableTree,
  installV7Phase,
  listV7Packs,
  loadV7Pack,
  materializeV7Starter,
  sealV7Pack,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  materializeFreshGoldImplementationA,
  respondToGoldAPhase4,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import {
  V7_FAMILIES,
  V7_PRIVATE_REQUIREMENT_CLASSIFICATION,
  V7_PRIVATE_SCORE_CLASSES,
  V7_REQUIREMENTS,
  V7_SCORE_GROUPS,
  canonicalJson,
  sha256,
} from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import {
  V7_VERIFICATION_SCHEMA,
  V7_VERIFIER_ASSERTIONS,
  analyzeV7DurabilityTrace,
  buildV7StraceInjection,
  createV7CandidateFailureResult,
  v7ScoredFixtureSchemaEvidence,
  v7CrashBoundaryRoles,
  verifyFinal,
  verifyPhase,
} from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';

const execFileAsync = promisify(execFile);
const TEST_SEED_KEY = 'mini-ledger-v7-test-seed-key';

async function temporary(label, operation) {
  const root = await mkdtemp(path.join(os.tmpdir(), `agentbattler-${label}-`));
  try { return await operation(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function files(root, relative = '') {
  const output = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) output.push(...await files(root, child));
    else output.push(child);
  }
  return output.sort();
}

function jsonShape(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.map(jsonShape) };
  if (value && typeof value === 'object') {
    return { type: 'object', fields: Object.fromEntries(Object.keys(value).sort().map((key) => [key, jsonShape(value[key])])) };
  }
  return { type: value === null ? 'null' : typeof value };
}

function lineByteShape(bytes) {
  return bytes.toString('utf8').split('\n').map((line) => Buffer.byteLength(line));
}

async function responseFor(workspace, evidence, executableSourceSha256) {
  const canonical = evidence.evidence.find(({ id }) => id === 'E-CANONICAL-PRIMARY');
  const value = {
    schema: 'agentbattler.ledger.incident-response.v1',
    conclusion: 'no-canonical-data-loss',
    canonicalEventCount: canonical.eventCount,
    canonicalHeadSha256: canonical.headSha256,
    executableSourceSha256,
    evidenceIds: evidence.evidence.map(({ id }) => id).sort(),
  };
  await writeFile(path.join(workspace, 'incident-response.json'), `${JSON.stringify(value)}\n`);
}

test('V7 packs expose exact pools, phases, score groups, and sealed commitments', () => {
  assert.deepEqual(V7_POOL_INSTANCES, {
    dev: ['dev-01', 'dev-02', 'dev-03'],
    release: ['release-01', 'release-02', 'release-03', 'release-04', 'release-05'],
    reserve: ['reserve-01', 'reserve-02', 'reserve-03', 'reserve-04', 'reserve-05'],
  });
  assert.deepEqual(Object.keys(V7_POOL_INSTANCES).map((pool) => listV7Packs({ pool }).length), [3, 5, 5]);
  assert.deepEqual(V7_FAMILIES, ['migration-compatibility', 'idempotency-pagination', 'concurrency-atomicity', 'crash-recovery', 'audit-replay-scale']);
  assert.deepEqual(V7_SCORE_GROUPS.public.weight, 20);
  assert.deepEqual(V7_SCORE_GROUPS.private.weight, 80);
  assert.deepEqual(V7_PRIVATE_SCORE_CLASSES.atomic, {
    id: 'atomic',
    description: 'Seeded variants of one disclosed behavioral contract.',
    perFamilyWeight: 6,
    totalWeight: 30,
  });
  assert.deepEqual(V7_PRIVATE_SCORE_CLASSES.composed, {
    id: 'composed',
    description: 'Seeded cross-feature, interleaving, scale, or fault scenarios.',
    perFamilyWeight: 10,
    totalWeight: 50,
  });
  assert.equal(V7_REQUIREMENTS.reduce((sum, requirement) => sum + requirement.weight, 0), 100);
  assert.equal(V7_REQUIREMENTS.find(({ id }) => id === 'V7-P3-PRIVATE-TERMINATION').family, 'crash-recovery');
  assert.equal(V7_REQUIREMENTS.find(({ id }) => id === 'V7-P4-PRIVATE-PROVENANCE').family, 'audit-replay-scale');
  assert.equal(V7_REQUIREMENTS.find(({ id }) => id === 'V7-P5-PUBLIC-RECOVER').family, 'crash-recovery');
  for (const family of V7_FAMILIES) {
    assert.equal(V7_REQUIREMENTS.filter((requirement) => requirement.family === family && requirement.group === 'public').reduce((sum, requirement) => sum + requirement.weight, 0), 4);
    assert.equal(V7_REQUIREMENTS.filter((requirement) => requirement.family === family && requirement.group === 'private').reduce((sum, requirement) => sum + requirement.weight, 0), 16);
    const classified = V7_PRIVATE_REQUIREMENT_CLASSIFICATION.filter((entry) => entry.family === family);
    assert.equal(classified.reduce((sum, entry) => sum + entry.atomicWeight, 0), 6);
    assert.equal(classified.reduce((sum, entry) => sum + entry.composedWeight, 0), 10);
  }
  const pack = loadV7Pack('dev-01');
  assert.deepEqual(pack.phases.map(({ id }) => id), ['legacy-migration', 'batch-pagination', 'concurrent-lifecycle', 'incident-evidence', 'recovery-scale']);
  assert.equal(pack.phaseDeltaSha256.length, 5);
  assert.ok(pack.phases.every(({ phasePayloadCommitmentSchema }) => phasePayloadCommitmentSchema === 'agentbattler.mini-ledger-v7.phase-payload-commitment.v1'));
  assert.equal(pack.perPhaseLimitMs, 1_500_000);
  assert.equal(pack.feedbackPolicy, 'self-service-public-only');
  assert.equal(pack.rubricVersion, 'mini-ledger-v7-r1');
  assert.equal(pack.artifactPolicy.maxFiles, 256);
  assert.equal(pack.artifactPolicy.maxBytes, 4 * 1024 * 1024);
  assert.match(pack.requirementMapSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(pack.verifierHashes).every((value) => /^[a-f0-9]{64}$/.test(value)));
  const sealed = sealV7Pack(pack);
  assert.match(sealed.hiddenMerkleRoot, /^[a-f0-9]{64}$/);
  assert.match(sealed.sealSha256, /^[a-f0-9]{64}$/);
});

test('clean and decoy twins preserve canonical/code bytes and exactly match layout, size, and value structure', async () => temporary('v7-twins', async (root) => {
  const cleanRoot = path.join(root, 'clean');
  const decoyRoot = path.join(root, 'decoy');
  const cleanPack = loadV7Pack('dev-02', { variant: 'clean' });
  const decoyPack = loadV7Pack('dev-02', { variant: 'decoy' });
  const cleanMaterialized = await materializeV7Starter({ pack: cleanPack, destination: cleanRoot });
  const decoyMaterialized = await materializeV7Starter({ pack: decoyPack, destination: decoyRoot });
  assert.equal(cleanMaterialized.fileCount, 36);
  assert.equal(decoyMaterialized.fileCount, 36);
  assert.equal(cleanPack.twinRelationSha256, decoyPack.twinRelationSha256);
  const relatives = await files(cleanRoot);
  assert.deepEqual(relatives, await files(decoyRoot));
  for (const relative of relatives) {
    const cleanBytes = await readFile(path.join(cleanRoot, relative));
    const decoyBytes = await readFile(path.join(decoyRoot, relative));
    assert.equal(cleanBytes.length, decoyBytes.length, `${relative} byte length`);
    assert.equal((await stat(path.join(cleanRoot, relative))).mode & 0o777, (await stat(path.join(decoyRoot, relative))).mode & 0o777, relative);
    if (relative.endsWith('.json') || relative.endsWith('.log')) {
      assert.deepEqual(jsonShape(JSON.parse(cleanBytes)), jsonShape(JSON.parse(decoyBytes)), `${relative} JSON structure`);
    }
    if (relative === 'ledger.json' || relative === 'var/acknowledged-events.json' || relative.startsWith('bin/') || relative.startsWith('src/')) {
      assert.deepEqual(cleanBytes, decoyBytes, relative);
    }
  }
  const cleanArchive = JSON.parse(await readFile(path.join(cleanRoot, 'var/archive/snapshot.json'), 'utf8'));
  const decoyArchive = JSON.parse(await readFile(path.join(decoyRoot, 'var/archive/snapshot.json'), 'utf8'));
  assert.deepEqual(Object.keys(cleanArchive), Object.keys(decoyArchive));
  assert.equal(cleanArchive.events.length, decoyArchive.events.length);
  assert.equal(cleanArchive.status, 'superseded');
  assert.equal(decoyArchive.status, 'superseded');
  const cleanControl = path.join(root, 'clean-control');
  const decoyControl = path.join(root, 'decoy-control');
  await Promise.all([
    installV7Phase({ pack: cleanPack, phase: 4, destination: cleanControl }),
    installV7Phase({ pack: decoyPack, phase: 4, destination: decoyControl }),
  ]);
  const cleanEvidence = await readFile(path.join(cleanControl, 'incident-evidence.json'));
  const decoyEvidence = await readFile(path.join(decoyControl, 'incident-evidence.json'));
  assert.equal(cleanEvidence.length, decoyEvidence.length, 'phase-4 incident evidence byte length');
  assert.deepEqual(jsonShape(JSON.parse(cleanEvidence)), jsonShape(JSON.parse(decoyEvidence)), 'phase-4 incident evidence structure');
}));

test('every pack supplies an exact clean twin for each falsifiable auxiliary decoy class', async () => temporary('v7-all-twins', async (root) => {
  const instanceIds = Object.values(V7_POOL_INSTANCES).flat();
  assert.deepEqual(V7_AUXILIARY_TWIN_CLASSES.map(({ id }) => id), [
    'superseded-adrs',
    'deprecated-schema-examples',
    'dead-legacy-module',
    'excluded-legacy-tests',
    'historical-operational-evidence',
  ]);
  for (const instanceId of instanceIds) {
    const cleanPack = loadV7Pack(instanceId, { variant: 'clean' });
    const decoyPack = loadV7Pack(instanceId, { variant: 'decoy' });
    const cleanRoot = path.join(root, `${instanceId}-clean`);
    const decoyRoot = path.join(root, `${instanceId}-decoy`);
    await Promise.all([
      materializeV7Starter({ pack: cleanPack, destination: cleanRoot }),
      materializeV7Starter({ pack: decoyPack, destination: decoyRoot }),
    ]);

    const relatives = await files(cleanRoot);
    assert.deepEqual(relatives, await files(decoyRoot), `${instanceId} layout`);
    for (const relative of relatives) {
      const [cleanBytes, decoyBytes, cleanStat, decoyStat] = await Promise.all([
        readFile(path.join(cleanRoot, relative)),
        readFile(path.join(decoyRoot, relative)),
        stat(path.join(cleanRoot, relative)),
        stat(path.join(decoyRoot, relative)),
      ]);
      assert.equal(cleanBytes.length, decoyBytes.length, `${instanceId}/${relative} byte length`);
      assert.equal(cleanStat.mode & 0o777, decoyStat.mode & 0o777, `${instanceId}/${relative} mode`);
      assert.deepEqual(lineByteShape(cleanBytes), lineByteShape(decoyBytes), `${instanceId}/${relative} line shape`);
      if (relative.endsWith('.json') || relative.endsWith('.log')) {
        assert.deepEqual(jsonShape(JSON.parse(cleanBytes)), jsonShape(JSON.parse(decoyBytes)), `${instanceId}/${relative} value shape`);
      }
      if (relative === 'package.json' || relative.startsWith('bin/') || relative.startsWith('src/') || relative.startsWith('config/')) {
        assert.deepEqual(cleanBytes, decoyBytes, `${instanceId}/${relative} executable bytes`);
      }
    }

    for (const twinClass of V7_AUXILIARY_TWIN_CLASSES) {
      for (const relative of twinClass.variantPaths) {
        assert.notDeepEqual(
          await readFile(path.join(cleanRoot, relative)),
          await readFile(path.join(decoyRoot, relative)),
          `${instanceId}/${twinClass.id}/${relative} must carry a real paired variant`,
        );
        for (const provenancePath of twinClass.provenancePaths) {
          assert.ok(relatives.includes(provenancePath), `${instanceId}/${twinClass.id} provenance ${provenancePath}`);
        }
      }
    }

    assert.equal(cleanPack.seedFingerprint, decoyPack.seedFingerprint, `${instanceId} visible seed`);
    assert.equal(cleanPack.requirementsSha256, decoyPack.requirementsSha256, `${instanceId} requirements`);
    assert.deepEqual(cleanPack.verifierHashes, decoyPack.verifierHashes, `${instanceId} verifier bytes`);
    const seedKey = cleanPack.pool === 'dev' ? undefined : TEST_SEED_KEY;
    assert.equal(
      sealV7Pack(cleanPack, { seedKey }).hiddenMerkleRoot,
      sealV7Pack(decoyPack, { seedKey }).hiddenMerkleRoot,
      `${instanceId} hidden seeds`,
    );

    const cleanControl = path.join(root, `${instanceId}-clean-control`);
    const decoyControl = path.join(root, `${instanceId}-decoy-control`);
    await Promise.all([
      installV7Phase({ pack: cleanPack, phase: 4, destination: cleanControl }),
      installV7Phase({ pack: decoyPack, phase: 4, destination: decoyControl }),
    ]);
    const controlRelatives = await files(cleanControl);
    assert.deepEqual(controlRelatives, await files(decoyControl), `${instanceId} phase-4 control layout`);
    for (const relative of controlRelatives) {
      const [cleanBytes, decoyBytes, cleanStat, decoyStat] = await Promise.all([
        readFile(path.join(cleanControl, relative)),
        readFile(path.join(decoyControl, relative)),
        stat(path.join(cleanControl, relative)),
        stat(path.join(decoyControl, relative)),
      ]);
      assert.equal(cleanBytes.length, decoyBytes.length, `${instanceId}/phase-4/${relative} byte length`);
      assert.equal(cleanStat.mode & 0o777, decoyStat.mode & 0o777, `${instanceId}/phase-4/${relative} mode`);
      if (relative.endsWith('.json')) assert.deepEqual(jsonShape(JSON.parse(cleanBytes)), jsonShape(JSON.parse(decoyBytes)), `${instanceId}/phase-4/${relative} JSON shape`);
      else assert.deepEqual(lineByteShape(cleanBytes), lineByteShape(decoyBytes), `${instanceId}/phase-4/${relative} line shape`);
    }
    assert.notDeepEqual(
      await readFile(path.join(cleanControl, 'incident-evidence.json')),
      await readFile(path.join(decoyControl, 'incident-evidence.json')),
      `${instanceId} phase-4 forensic evidence variant`,
    );

    const decoyAdr = await readFile(path.join(decoyRoot, 'docs/adr/0001-archive-as-primary.md'), 'utf8');
    const activeAdr = await readFile(path.join(decoyRoot, 'docs/adr/0004-manifest-authority.md'), 'utf8');
    assert.match(decoyAdr, /Status: superseded/);
    assert.match(decoyAdr, /Superseded by: ADR 0004/);
    assert.match(activeAdr, /Status: accepted/);
    assert.match(activeAdr, /Replaces: ADR 0001/);

    const deprecatedSchema = JSON.parse(await readFile(path.join(decoyRoot, 'docs/schemas/ledger-v0.deprecated.json')));
    const deprecatedExample = JSON.parse(await readFile(path.join(decoyRoot, 'test/fixtures/legacy-v0.json')));
    assert.equal(deprecatedSchema.status, 'deprecated');
    assert.equal(deprecatedSchema.supersededBy, 'agentbattler.ledger.v1');
    assert.equal(deprecatedExample.status, 'deprecated');

    const activeSources = (await Promise.all(relatives.filter((relative) => relative.startsWith('bin/') || relative.startsWith('src/'))
      .map((relative) => readFile(path.join(decoyRoot, relative), 'utf8')))).join('\n');
    assert.doesNotMatch(activeSources, /legacy\/ledger-v0/);
    assert.match(await readFile(path.join(decoyRoot, 'legacy/README.md'), 'utf8'), /outside the active import graph/);
    const packageManifest = JSON.parse(await readFile(path.join(decoyRoot, 'package.json')));
    const testPolicy = JSON.parse(await readFile(path.join(decoyRoot, 'config/test-policy.json')));
    assert.doesNotMatch(packageManifest.scripts.test, /test\/legacy/);
    assert.ok(testPolicy.excluded.some(({ pattern }) => pattern === 'test/legacy/**'));

    const artifactManifest = JSON.parse(await readFile(path.join(decoyRoot, 'var/artifact-manifest.json')));
    for (const [relative, expected] of [
      ['var/archive/snapshot.json', { role: 'advisory', status: 'superseded' }],
      ['var/logs/worker.log', { role: 'advisory', status: 'historical' }],
      ['var/incidents/closed-import-lag.json', { role: 'advisory-incident', status: 'closed' }],
    ]) {
      const entry = artifactManifest.artifacts.find(({ path: artifactPath }) => artifactPath === relative);
      assert.equal(entry?.role, expected.role, `${instanceId}/${relative} role`);
      assert.equal(entry?.status, expected.status, `${instanceId}/${relative} status`);
      assert.equal(entry?.sha256, sha256(await readFile(path.join(decoyRoot, relative))), `${instanceId}/${relative} provenance hash`);
      assert.notEqual(entry?.deploymentId, artifactManifest.deploymentId, `${instanceId}/${relative} deployment provenance`);
    }
  }
}));

test('scored fixture payload schemas are pack-and-phase-seeded, opaque, and twin-stable', () => {
  const evidence = [];
  for (const instanceId of Object.values(V7_POOL_INSTANCES).flat()) {
    const pack = loadV7Pack(instanceId, { variant: 'decoy' });
    const seedKey = pack.pool === 'dev' ? undefined : TEST_SEED_KEY;
    const sealed = sealV7Pack(pack, { seedKey });
    const clean = sealV7Pack(loadV7Pack(instanceId, { variant: 'clean' }), { seedKey });
    for (let phase = 1; phase <= 5; phase += 1) {
      const actual = v7ScoredFixtureSchemaEvidence({ pack: sealed, phase, seedKey });
      const repeated = v7ScoredFixtureSchemaEvidence({ pack: sealed, phase, seedKey });
      const cleanTwin = v7ScoredFixtureSchemaEvidence({ pack: clean, phase, seedKey });
      assert.deepEqual(actual, repeated, `${instanceId}/phase-${phase} deterministic replay`);
      assert.equal(actual.schemaSha256, cleanTwin.schemaSha256, `${instanceId}/phase-${phase} twin schema`);
      assert.equal(actual.phaseSeedCommitment, cleanTwin.phaseSeedCommitment, `${instanceId}/phase-${phase} twin seed`);
      assert.ok(['flat-record', 'nested-record', 'tuple-record', 'branch-record'].includes(actual.layout));
      assert.equal(actual.fieldNames.length, 4);
      assert.equal(new Set(actual.fieldNames).size, 4);
      assert.ok(actual.fieldNames.every((field) => /^f_[a-f0-9]{14}$/.test(field)));
      assert.notEqual(
        actual.schemaSha256,
        v7ScoredFixtureSchemaEvidence({ pack: sealed, phase, seedKey, verifierSeedIndex: 1 }).schemaSha256,
        `${instanceId}/phase-${phase} verifier seed variation`,
      );
      evidence.push(actual);
    }
  }
  assert.equal(evidence.length, 65);
  assert.equal(new Set(evidence.map(({ schemaSha256 }) => schemaSha256)).size, evidence.length, 'every pack/phase fixture schema must be distinct');
  assert.equal(new Set(evidence.map(({ phaseSeedCommitment }) => phaseSeedCommitment)).size, evidence.length, 'every pack/phase fixture seed must be distinct');
  assert.equal(new Set(evidence.map(({ layout }) => layout)).size, 4, 'all seeded payload shape families must be exercised');
  for (let phase = 1; phase <= 5; phase += 1) {
    const phaseEvidence = evidence.filter((entry) => entry.phase === phase);
    assert.equal(new Set(phaseEvidence.map(({ schemaSha256 }) => schemaSha256)).size, 13, `phase ${phase} schemas across packs`);
  }
});

test('all sealed packs vary opaque payload schemas and crash-boundary assignments deterministically', async () => temporary('v7-pack-diversity', async (root) => {
  const instanceIds = Object.values(V7_POOL_INSTANCES).flat();
  const payloadSchemas = [];
  const crashAssignments = [];
  for (const instanceId of instanceIds) {
    const destination = path.join(root, instanceId);
    await materializeV7Starter({ pack: loadV7Pack(instanceId), destination });
    const ledger = JSON.parse(await readFile(path.join(destination, 'ledger.json'), 'utf8'));
    payloadSchemas.push(canonicalJson(ledger.events.map(({ kind, payload }) => ({ kind, fields: Object.keys(payload).sort() }))));
    crashAssignments.push(canonicalJson(v7CrashBoundaryRoles(instanceId)));
  }
  assert.equal(new Set(payloadSchemas).size, instanceIds.length, 'every pack must have a distinct opaque payload schema');
  assert.equal(new Set(crashAssignments).size, instanceIds.length, 'every pack must have a distinct crash-boundary assignment');
  assert.equal(new Set(V7_POOL_INSTANCES.release.map((instanceId) => canonicalJson(v7CrashBoundaryRoles(instanceId)))).size, 5);
  assert.equal(new Set(V7_POOL_INSTANCES.reserve.map((instanceId) => canonicalJson(v7CrashBoundaryRoles(instanceId)))).size, 5);
}));

test('starter includes selected passing tests and provenance-marked historical depth without entering the active graph', async () => temporary('v7-starter-depth', async (root) => {
  const pack = loadV7Pack('dev-01');
  const materialized = await materializeV7Starter({ pack, destination: root });
  assert.equal(materialized.fileCount, 36);
  assert.equal(materialized.files.filter((relative) => relative === 'bin/ledger.mjs' || relative.startsWith('src/')).length, 15);
  for (const relative of [
    'config/test-policy.json',
    'docs/adr/0001-archive-as-primary.md',
    'docs/adr/0004-manifest-authority.md',
    'docs/schemas/ledger-v0.deprecated.json',
    'legacy/ledger-v0.js',
    'test/legacy/excluded-v0.test.mjs',
    'test/fixtures/legacy-v0.json',
    'var/incidents/closed-import-lag.json',
  ]) assert.ok(materialized.files.includes(relative), relative);
  const manifest = JSON.parse(await readFile(path.join(root, 'var/artifact-manifest.json')));
  assert.ok(manifest.artifacts.some(({ path: artifactPath, role, status }) => artifactPath === 'var/incidents/closed-import-lag.json' && role === 'advisory-incident' && status === 'closed'));
  const legacyModule = await readFile(path.join(root, 'legacy/ledger-v0.js'), 'utf8');
  const activeEntrypoint = await readFile(path.join(root, 'bin/ledger.mjs'), 'utf8');
  const activeCli = await readFile(path.join(root, 'src/cli.mjs'), 'utf8');
  assert.doesNotMatch(`${activeEntrypoint}\n${activeCli}`, /legacy\/ledger-v0/);
  assert.match(legacyModule, /RETIRED: not imported/);
  const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json')));
  assert.doesNotMatch(packageManifest.scripts.test, /test\/legacy/);
  await execFileAsync('npm', ['test'], { cwd: root });
}));

test('phase installation is current-only and phase-4 evidence ignores destination state', async () => temporary('v7-control', async (root) => {
  const pack = loadV7Pack('dev-03');
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  await Promise.all([mkdir(left), mkdir(right)]);
  await writeFile(path.join(left, 'ledger.json'), '{"candidate":"forged"}\n');
  await writeFile(path.join(right, 'ledger.json'), '{"candidate":"different"}\n');
  const first = await installV7Phase({ pack, phase: 4, destination: left });
  const second = await installV7Phase({ pack, phase: 4, destination: right });
  assert.equal(first.contractSha256, second.contractSha256);
  assert.equal(first.incidentEvidenceSha256, second.incidentEvidenceSha256);
  assert.equal(first.installedDeltaSha256, pack.phases[3].phaseDeltaSha256);
  assert.equal(second.installedDeltaSha256, pack.phases[3].phaseDeltaSha256);
  assert.notEqual(first.installedTreeSha256, first.installedDeltaSha256, 'exact installed bytes retain a separate post-binding commitment');
  assert.deepEqual(first.contract, second.contract);
  assert.equal(first.contract.executableSourceSha256, null);
  assert.equal(first.contract.incidentEvidencePath, '.agentbattler/current/incident-evidence.json');
  assert.equal(first.contract.responsePath, 'incident-response.json');
  assert.deepEqual(first.contract.executableSourceHashScope, ['package.json', 'bin/**', 'src/**', 'config/**']);
  assert.equal(first.contract.executableSourceHashAlgorithm, 'sha256-path-null-content-sha256-newline-v1');
  assert.doesNotMatch(JSON.stringify(first.contract), /"(?:private|weight)"/i);
  assert.deepEqual(first.artifacts.map(({ path }) => path), [
    '.agentbattler/current/TASK.md',
    '.agentbattler/current/task-contract.json',
    '.agentbattler/current/smoke.mjs',
    '.agentbattler/current/incident-evidence.json',
  ]);
  assert.equal(first.contract.publicSmokePath, '.agentbattler/current/smoke.mjs');
  assert.equal(first.contract.publicSmokeCommand, 'node .agentbattler/current/smoke.mjs');
  assert.equal(first.publicSmokeSha256, sha256(await readFile(path.join(left, 'smoke.mjs'))));
  assert.equal(sha256(await readFile(path.join(left, 'incident-evidence.json'))), buildV7IncidentEvidence(pack).sha256);
  await installV7Phase({ pack, phase: 5, destination: left });
  await assert.rejects(readFile(path.join(left, 'incident-evidence.json')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(path.join(left, 'TASK.md'), 'utf8'), /data-loss report|migration without breaking/i);
}));

test('ordered phase commitments bind ticket, canonical contract, smoke, and incident evidence', async () => temporary('v7-phase-commitment', async (root) => {
  const pack = loadV7Pack('dev-02');
  const installed = await installV7Phase({ pack, phase: 4, destination: root });
  const payload = {
    pack,
    phase: 4,
    ticketBytes: await readFile(path.join(root, 'TASK.md')),
    contractBytes: await readFile(path.join(root, 'task-contract.json')),
    publicSmokeBytes: await readFile(path.join(root, 'smoke.mjs')),
    incidentEvidenceBytes: await readFile(path.join(root, 'incident-evidence.json')),
  };
  assert.equal(assertV7PhasePayloadCommitment(payload).phaseDeltaSha256, installed.phaseDeltaSha256);

  const corruptions = [
    { field: 'ticketBytes', value: Buffer.concat([payload.ticketBytes, Buffer.from('\nchanged')]) },
    { field: 'publicSmokeBytes', value: Buffer.concat([payload.publicSmokeBytes, Buffer.from('\n// changed')]) },
    { field: 'incidentEvidenceBytes', value: Buffer.concat([payload.incidentEvidenceBytes, Buffer.from(' ')]) },
  ];
  for (const { field, value } of corruptions) {
    assert.throws(() => assertV7PhasePayloadCommitment({ ...payload, [field]: value }), /changed|commitment|canonical|evidence/);
  }

  const changedContract = JSON.parse(payload.contractBytes);
  changedContract.title = 'uncommitted replacement';
  assert.throws(() => assertV7PhasePayloadCommitment({
    ...payload,
    contractBytes: Buffer.from(`${JSON.stringify(changedContract, null, 2)}\n`),
  }), /machine contract changed/);

  const wrongSelfBinding = JSON.parse(payload.contractBytes);
  wrongSelfBinding.phaseDeltaSha256 = '0'.repeat(64);
  assert.throws(() => assertV7PhasePayloadCommitment({
    ...payload,
    contractBytes: Buffer.from(`${JSON.stringify(wrongSelfBinding, null, 2)}\n`),
  }), /machine contract changed/);

  const boundContract = bindV7PhaseEntryContract(installed.contract, 'a'.repeat(64));
  assert.equal(assertV7PhasePayloadCommitment({
    ...payload,
    contractBytes: Buffer.from(`${JSON.stringify(boundContract, null, 2)}\n`),
  }).phaseDeltaSha256, installed.phaseDeltaSha256, 'declared phase-entry binding must preserve the normalized payload commitment');
}));

test('phase-4 executable hash covers every allowed executable-affecting byte and ignores auxiliary docs', async () => temporary('v7-executable-hash', async (root) => {
  const pack = loadV7Pack('dev-01');
  await materializeV7Starter({ pack, destination: root });
  const baseline = await hashV7ExecutableTree(root);
  const cases = [
    ['package.json', '\n '],
    ['config/test-policy.json', '\n '],
    ['src/runtime.js', 'export const runtime = true;\n'],
    ['bin/helper.cjs', 'module.exports = true;\n'],
  ];
  for (const [relative, addition] of cases) {
    const target = path.join(root, relative);
    let original = null;
    try { original = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, original ? Buffer.concat([original, Buffer.from(addition)]) : addition);
    assert.notEqual(await hashV7ExecutableTree(root), baseline, relative);
    if (original) await writeFile(target, original);
    else await rm(target);
  }
  await writeFile(path.join(root, 'docs', 'ignored-note.md'), 'auxiliary documentation\n');
  assert.equal(await hashV7ExecutableTree(root), baseline);
}));

test('current-only public smoke checks are cumulative, useful, and reveal no future phase', async () => temporary('v7-public-smoke', async (root) => {
  const pack = loadV7Pack('dev-01');
  const control = path.join(root, 'control');
  const smokeSources = [];
  for (let phase = 1; phase <= 5; phase += 1) {
    const installed = await installV7Phase({ pack, phase, destination: control });
    const source = await readFile(path.join(control, 'smoke.mjs'), 'utf8');
    smokeSources.push(source);
    assert.equal(installed.contract.publicSmokePath, '.agentbattler/current/smoke.mjs');
    assert.equal(installed.contract.publicSmokeCommand, 'node .agentbattler/current/smoke.mjs');
    assert.equal(sha256(source), pack.phases[phase - 1].publicSmokeSha256);
    assert.doesNotMatch(source, /V7-P\d|private|hidden|weight/i);
    assert.match(source, /phase-1-migration-and-clients/);
    if (phase >= 2) assert.match(source, /phase-2-idempotency-and-pagination/);
    if (phase >= 3) assert.match(source, /phase-3-concurrent-serial-state/);
    if (phase >= 4) assert.match(source, /phase-4-canonical-incident-conclusion/);
    if (phase === 5) assert.match(source, /phase-5-corruption-recovery/);
  }
  assert.doesNotMatch(smokeSources[0], /append-batch|nextCursor|compact|incident-response|recover/);
  assert.doesNotMatch(smokeSources[1], /compact|incident-response|recover/);
  assert.doesNotMatch(smokeSources[2], /incident-response|recover|replay|\['audit'\]/);
  assert.doesNotMatch(smokeSources[3], /ledger\.export\.smoke|recover/);

  const starter = path.join(root, 'starter');
  await materializeV7Starter({ pack, destination: starter });
  await installV7Phase({ pack, phase: 1, destination: path.join(starter, '.agentbattler', 'current') });
  const starterRun = await execFileAsync(process.execPath, ['.agentbattler/current/smoke.mjs'], { cwd: starter }).catch((error) => error);
  assert.notEqual(starterRun.code, 0);
  assert.equal(JSON.parse(starterRun.stdout).ok, false, 'the known migration defect must be visible through public smoke');

  const gold = path.join(root, 'gold');
  await materializeFreshGoldImplementationA({ destination: gold, pack });
  for (let phase = 1; phase <= 5; phase += 1) {
    const current = path.join(gold, '.agentbattler', 'current');
    const installed = await installV7Phase({ pack, phase, destination: current });
    if (phase === 4) {
      const bound = bindV7PhaseEntryContract(installed.contract, await hashV7ExecutableTree(gold));
      await writeFile(path.join(current, 'task-contract.json'), `${JSON.stringify(bound, null, 2)}\n`);
      await respondToGoldAPhase4({ workspace: gold });
    }
    const completed = await execFileAsync(process.execPath, ['.agentbattler/current/smoke.mjs'], { cwd: gold });
    const output = JSON.parse(completed.stdout);
    assert.deepEqual(output, { ok: true, phase, checks: output.checks });
    assert.equal(output.checks.length, phase);
  }
}));

test('phase-4 verifier scores sealed evidence and treats response defects as candidate failures', async () => temporary('v7-phase4', async (root) => {
  const pack = loadV7Pack('dev-01');
  const ticket = await readFile(new URL('../benchmark/challenges/mini-ledger-v7/tickets/phase-04.md', import.meta.url), 'utf8');
  assert.match(ticket, /every supplied evidence record id exactly once in ascending string order/);
  await materializeV7Starter({ pack, destination: root });
  const installed = await installV7Phase({ pack, phase: 4, destination: path.join(root, '.agentbattler', 'current') });
  const executableSourceSha256 = await hashV7ExecutableTree(root);
  const contract = bindV7PhaseEntryContract(installed.contract, executableSourceSha256);
  const incident = buildV7IncidentEvidence(pack).evidence;
  await responseFor(root, incident, executableSourceSha256);
  const passed = await verifyPhase({ pack, phase: 4, candidateTree: root, workspace: root, contract, verifierSeedIndex: 7 });
  assert.equal(passed.passed, true);
  assert.equal(passed.score, 12);
  assert.deepEqual(passed.infrastructureErrors, []);
  assert.equal(passed.verifierSeedIndex, 7);
  assert.equal(passed.requirements.find(({ id }) => id === 'V7-P4-PRIVATE-PROVENANCE').classes.atomic.points, 2);
  assert.equal(passed.requirements.find(({ id }) => id === 'V7-P4-PRIVATE-PROVENANCE').classes.composed.points, 2);
  assert.deepEqual(passed.families.find(({ id }) => id === 'audit-replay-scale').hiddenAtomic, { passed: 3, total: 3 });
  assert.deepEqual(passed.families.find(({ id }) => id === 'audit-replay-scale').hiddenComposed, { passed: 5, total: 5 });
  const incompleteResponse = JSON.parse(await readFile(path.join(root, 'incident-response.json'), 'utf8'));
  incompleteResponse.evidenceIds = incompleteResponse.evidenceIds.slice(0, -1);
  await writeFile(path.join(root, 'incident-response.json'), `${JSON.stringify(incompleteResponse)}\n`);
  const incomplete = await verifyPhase({ pack, phase: 4, candidateTree: root, workspace: root, contract, verifierSeedIndex: 7 });
  const provenance = incomplete.requirements.find(({ id }) => id === 'V7-P4-PRIVATE-PROVENANCE');
  assert.equal(provenance.classes.composed.passed, false);
  await writeFile(path.join(root, 'incident-response.json'), '{malformed');
  const failed = await verifyPhase({ pack, phase: 4, candidateTree: root, workspace: root, contract, verifierSeedIndex: 7 });
  assert.equal(failed.passed, false);
  assert.equal(failed.requirements.every(({ passed: value }) => value === false), true);
  assert.deepEqual(failed.infrastructureErrors, []);
}));

test('durability trace analysis requires data sync, atomic publication, and directory sync', () => {
  const stable = [
    '1000.000001 openat(AT_FDCWD, ".state-abc", O_WRONLY|O_CREAT, 0600) = 5',
    '1000.000002 write(5, "{}", 2) = 2',
    '1000.000003 fdatasync(5) = 0',
    '1000.000004 close(5) = 0',
    '1000.000005 rename(".state-abc", "ledger.json") = 0',
    '1000.000006 openat(AT_FDCWD, ".", O_RDONLY|O_DIRECTORY) = 6',
    '1000.000007 fsync(6) = 0',
  ].join('\n');
  assert.equal(analyzeV7DurabilityTrace(stable, { workspace: '/tmp/candidate' }).stable, true);
  assert.equal(analyzeV7DurabilityTrace(stable.replace('1000.000007 fsync(6) = 0', ''), { workspace: '/tmp/candidate' }).stable, false);
  const noContentMutation = stable.replace('1000.000002 write(5, "{}", 2) = 2\n', '');
  assert.equal(analyzeV7DurabilityTrace(noContentMutation, { workspace: '/tmp/candidate' }).stable, false, 'sync without an observed content mutation proves no replacement bytes');
  const postBarrierWrite = stable.replace(
    '1000.000004 close(5) = 0',
    '1000.000004 write(5, "later", 5) = 5\n1000.0000045 close(5) = 0',
  );
  assert.equal(analyzeV7DurabilityTrace(postBarrierWrite, { workspace: '/tmp/candidate' }).stable, false, 'writes after the selected data barrier are not durable');
  const postBarrierTruncate = stable.replace(
    '1000.000004 close(5) = 0',
    '1000.000004 ftruncate(5, 0) = 0\n1000.0000045 close(5) = 0',
  );
  const truncated = analyzeV7DurabilityTrace(postBarrierTruncate, { workspace: '/tmp/candidate' });
  assert.equal(truncated.stable, false, 'truncation after the selected data barrier is not durable');
  assert.ok(truncated.mutationAttempts.some(({ syscall }) => syscall === 'ftruncate'));
  const overwritten = `${stable}\n1000.000008 openat(AT_FDCWD, "ledger.json", O_WRONLY) = 7\n1000.000009 write(7, "unsafe", 6) = 6`;
  assert.equal(analyzeV7DurabilityTrace(overwritten, { workspace: '/tmp/candidate' }).stable, false);
  const retainedDescriptorMutation = stable
    .replace('1000.000004 close(5) = 0\n', '')
    .replace('1000.000006 openat', '1000.000006 ftruncate(5, 0) = 0\n1000.0000065 close(5) = 0\n1000.000007 openat')
    .replace('1000.000007 fsync', '1000.000008 fsync');
  assert.equal(analyzeV7DurabilityTrace(retainedDescriptorMutation, { workspace: '/tmp/candidate' }).stable, false, 'post-rename mutation through the staged fd invalidates publication');

  const copiedBeforeBarrier = [
    '1200.000001 openat(AT_FDCWD, "source.json", O_RDONLY) = 4',
    '1200.000002 openat(AT_FDCWD, ".state-copy", O_WRONLY|O_CREAT|O_EXCL, 0600) = 5',
    '1200.000003 copy_file_range(4, NULL, 5, NULL, 8, 0) = 8',
    '1200.000004 fsync(5) = 0',
    '1200.000005 rename(".state-copy", "ledger.json") = 0',
    '1200.000006 openat(AT_FDCWD, ".", O_RDONLY|O_DIRECTORY) = 6',
    '1200.000007 fsync(6) = 0',
  ].join('\n');
  const copied = analyzeV7DurabilityTrace(copiedBeforeBarrier, { workspace: '/tmp/candidate' });
  assert.equal(copied.stable, true, 'copy_file_range followed by explicit barriers is a valid alternate byte installation');
  assert.ok(copied.mutationAttempts.some(({ syscall }) => syscall === 'copy_file_range'));
  const copiedAfterBarrier = copiedBeforeBarrier
    .replace('1200.000003 copy_file_range(4, NULL, 5, NULL, 8, 0) = 8\n', '')
    .replace('1200.000004 fsync(5) = 0', '1200.000003 fsync(5) = 0\n1200.000004 copy_file_range(4, NULL, 5, NULL, 8, 0) = 8');
  assert.equal(analyzeV7DurabilityTrace(copiedAfterBarrier, { workspace: '/tmp/candidate' }).stable, false, 'copy after the final data barrier is not durable');

  const synchronousLinkedPublication = [
    '1500.000001 openat(AT_FDCWD, "/workspace/.state-ods", O_WRONLY|O_CREAT|O_EXCL|O_DSYNC, 0600) = 5',
    '1500.000002 write(5, "complete", 8) = 8',
    '1500.000003 close(5) = 0',
    '1500.000004 link("/workspace/.state-ods", "/workspace/.state-published") = 0',
    '1500.000005 rename("/workspace/.state-published", "/workspace/ledger.json") = 0',
    '1500.000006 openat(AT_FDCWD, "/workspace", O_RDONLY|O_DIRECTORY) = 6',
    '1500.000007 fsync(6) = 0',
  ].join('\n');
  const alternate = analyzeV7DurabilityTrace(synchronousLinkedPublication, { workspace: '/workspace' });
  assert.equal(alternate.stable, true, 'O_DSYNC writes followed by hardlink staging and rename are a valid durable publication');
  assert.equal(alternate.dataBarrier.syscall, 'write');
  assert.equal(alternate.linkAttempts.length, 1);
  assert.equal(analyzeV7DurabilityTrace(synchronousLinkedPublication.replace('|O_DSYNC', ''), { workspace: '/workspace' }).stable, false);
  assert.equal(analyzeV7DurabilityTrace(`${synchronousLinkedPublication.replace('1500.000005', '1500.000006').replace('1500.000006 openat', '1500.000007 openat').replace('1500.000007 fsync', '1500.000008 fsync')}\n1500.000005 unlink("/workspace/ledger.json") = 0`, { workspace: '/workspace' }).stable, false, 'unlinking primary before publication is not an accepted alternate');
  assert.equal(buildV7StraceInjection({ syscall: 'write', occurrence: 4 }), 'inject=write:signal=SIGKILL:when=4');

  const exchangePublication = [
    '1600.000001 openat(AT_FDCWD, "/workspace/.state-exchange", O_WRONLY|O_CREAT|O_EXCL, 0600) = 5',
    '1600.000002 write(5, "complete", 8) = 8',
    '1600.000003 fsync(5) = 0',
    '1600.000004 renameat2(AT_FDCWD, "/workspace/.state-exchange", AT_FDCWD, "/workspace/ledger.json", RENAME_EXCHANGE) = 0',
    '1600.000005 openat(AT_FDCWD, "/workspace", O_RDONLY|O_DIRECTORY) = 6',
    '1600.000006 fsync(6) = 0',
  ].join('\n');
  assert.equal(analyzeV7DurabilityTrace(exchangePublication, { workspace: '/workspace' }).stable, true, 'renameat2 exchange is a valid atomic publication alternate');

  const crossThread = analyzeV7DurabilityTrace([
    {
      scope: 'trace.101',
      text: [
        '2000.000001 openat(AT_FDCWD, ".lock-claim", O_WRONLY|O_CREAT, 0600) = 4',
        '2000.000003 openat(AT_FDCWD, ".state-seeded", O_WRONLY|O_CREAT, 0600) = 5',
      ].join('\n'),
    },
    {
      scope: 'trace.102',
      text: [
        '2000.000002 fdatasync(4) = 0',
        '2000.000004 rename(".claim-a", ".claim-b") = 0',
        '2000.0000045 write(5, "complete", 8) = 8',
        '2000.000005 fdatasync(5) = 0',
        '2000.000006 rename(".state-seeded", "ledger.json") = 0',
      ].join('\n'),
    },
    {
      scope: 'trace.103',
      text: [
        '2000.000007 openat(AT_FDCWD, ".", O_RDONLY|O_DIRECTORY) = 6',
        '2000.000008 fsync(6) = 0',
      ].join('\n'),
    },
  ], { workspace: '/tmp/candidate' });
  assert.equal(crossThread.stable, true, 'FileHandle.sync descriptors must correlate across libuv worker TIDs');
  assert.equal(crossThread.dataBarrier.occurrence, 2, 'fault injection must skip the earlier lock fdatasync');
  assert.equal(crossThread.rename.occurrence, 2, 'fault injection must skip the earlier unrelated rename');
  assert.equal(buildV7StraceInjection(crossThread.dataBarrier), 'inject=fdatasync:signal=SIGKILL:when=2');
  assert.equal(buildV7StraceInjection(crossThread.rename), 'inject=rename:signal=SIGKILL:when=2');
  assert.equal(buildV7StraceInjection({ syscall: 'sync', occurrence: 1 }), 'inject=sync:signal=SIGKILL:when=1');

  const compact = [
    '3000.000001 openat(AT_FDCWD, "/workspace/.ledger.snapshot.abc.json.1.tmp", O_WRONLY|O_CREAT, 0600) = 7',
    '3000.000002 write(7, "snapshot", 8) = 8',
    '3000.000003 fdatasync(7) = 0',
    '3000.000004 close(7) = 0',
    '3000.000005 rename("/workspace/.ledger.snapshot.abc.json.1.tmp", "/workspace/ledger.snapshot.abc.json") = 0',
    '3000.000006 openat(AT_FDCWD, "/workspace", O_RDONLY|O_DIRECTORY) = 8',
    '3000.000007 fsync(8) = 0',
    '3000.000008 openat(AT_FDCWD, "/workspace/ledger.json.tmp", O_WRONLY|O_CREAT, 0600) = 9',
    '3000.000009 write(9, "primary", 7) = 7',
    '3000.000010 fdatasync(9) = 0',
    '3000.000011 close(9) = 0',
    '3000.000012 rename("/workspace/ledger.json.tmp", "/workspace/ledger.json") = 0',
    '3000.000013 openat(AT_FDCWD, "/workspace", O_RDONLY|O_DIRECTORY) = 10',
    '3000.000014 fsync(10) = 0',
  ].join('\n');
  const compactDurability = analyzeV7DurabilityTrace(compact, { workspace: '/workspace' });
  assert.equal(compactDurability.stable, true);
  assert.equal(compactDurability.snapshotPublications.length, 1);
  assert.equal(compactDurability.snapshotPublications[0].stable, true);
  assert.ok(compactDurability.snapshotPublications[0].directoryBarrierOrder < compactDurability.publicationOrder);
  const lateSnapshotBarrier = analyzeV7DurabilityTrace(compact.replace('3000.000007 fsync(8) = 0', ''), { workspace: '/workspace' });
  assert.equal(lateSnapshotBarrier.snapshotPublications[0].stable, true, 'a later directory barrier still stabilizes an unreferenced snapshot');
  assert.ok(lateSnapshotBarrier.snapshotPublications[0].directoryBarrierOrder > lateSnapshotBarrier.publicationOrder, 'the primary published before its snapshot became stable');
  assert.equal(analyzeV7DurabilityTrace(compact.replace('3000.000005 rename("/workspace/.ledger.snapshot.abc.json.1.tmp", "/workspace/ledger.snapshot.abc.json") = 0', ''), { workspace: '/workspace' }).snapshotPublications.length, 0, 'a direct snapshot write is not atomic publication');
  assert.equal(analyzeV7DurabilityTrace(stable.replace('"ledger.json"', '"/tmp/outside/ledger.json"'), { workspace: '/tmp/candidate' }).stable, false, 'same-basename publication outside the workspace is not primary durability');
});

test('phase-3 durability never receives points when trace infrastructure is absent', async () => temporary('v7-no-trace', async (root) => {
  const pack = loadV7Pack('dev-01');
  await materializeV7Starter({ pack, destination: root });
  const result = await verifyPhase({ pack, phase: 3, candidateTree: root, verifierSeedIndex: 3 });
  const durability = result.requirements.find(({ id }) => id === 'V7-P3-PRIVATE-TERMINATION');
  assert.equal(durability.passed, false);
  assert.ok(result.infrastructureErrors.some(({ requirementId }) => requirementId === durability.id));
  assert.notEqual(result.score, result.maxScore);
}));

test('candidate overlay rejection produces a normal scoreable phase result', () => {
  const result = createV7CandidateFailureResult({
    pack: loadV7Pack('dev-01'),
    phase: 2,
    verifierSeedIndex: 4,
    diagnostic: 'candidate tree contains a symbolic link',
  });
  assert.equal(result.schemaVersion, V7_VERIFICATION_SCHEMA);
  assert.equal(result.phase, 2);
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.equal(result.requirements.length, V7_REQUIREMENTS.filter(({ phase }) => phase === 2).length);
  assert.ok(result.requirements.every(({ passed }) => passed === false));
  assert.deepEqual(result.infrastructureErrors, []);
  assert.deepEqual(result.adaptability, { passed: 0, total: 1 });
});

test('verifier seed indices are committed variants without exposing raw seeds', async () => temporary('v7-seed-index', async (root) => {
  const pack = loadV7Pack('dev-01');
  await materializeV7Starter({ pack, destination: root });
  const installed = await installV7Phase({ pack, phase: 4, destination: path.join(root, '.agentbattler', 'current') });
  const executableSourceSha256 = await hashV7ExecutableTree(root);
  const contract = bindV7PhaseEntryContract(installed.contract, executableSourceSha256);
  await responseFor(root, buildV7IncidentEvidence(pack).evidence, executableSourceSha256);
  const first = await verifyPhase({ pack, phase: 4, candidateTree: root, contract, verifierSeedIndex: 0 });
  const second = await verifyPhase({ pack, phase: 4, candidateTree: root, contract, verifierSeedIndex: 99 });
  assert.notDeepEqual(first.seedCommitments.map(({ variantCommitment }) => variantCommitment), second.seedCommitments.map(({ variantCommitment }) => variantCommitment));
  assert.doesNotMatch(canonicalJson(first), /hidden-variant\/v1|public-development-key/);
  await assert.rejects(verifyPhase({ pack, phase: 4, candidateTree: root, contract, verifierSeedIndex: 100 }), /\[0, 99\]/);
}));

test('final verification uses phase-5 requirement outcomes while preserving checkpoint adaptability', async () => {
  const pack = loadV7Pack('dev-01');
  const atomicResults = Array.from({ length: 5 }, (_, index) => {
    const phase = index + 1;
    const requirements = V7_REQUIREMENTS.filter((requirement) => requirement.phase === phase).map((requirement) => {
      const catalog = V7_VERIFIER_ASSERTIONS[requirement.id];
      return {
        id: requirement.id,
        family: requirement.family,
        group: requirement.group,
        weight: requirement.weight,
        points: requirement.weight,
        passed: true,
        diagnostic: null,
        ...(requirement.group === 'public'
          ? { assertionId: catalog.public.assertionId, caseCount: catalog.public.caseCount }
          : {
            classes: Object.fromEntries(['atomic', 'composed'].map((caseClass) => [caseClass, {
              assertionId: catalog[caseClass].assertionId,
              caseCount: catalog[caseClass].caseCount,
              weight: requirement.privateClassWeights[caseClass],
              points: requirement.privateClassWeights[caseClass],
              passed: true,
              diagnostic: null,
            }])),
          }),
      };
    });
    const score = requirements.reduce((sum, requirement) => sum + requirement.points, 0);
    return {
      schemaVersion: V7_VERIFICATION_SCHEMA,
      challengeId: pack.challengeId,
      instanceId: pack.instanceId,
      variant: pack.variant,
      phase,
      verifierSeedIndex: 11,
      requirements,
      checks: requirements,
      infrastructureErrors: [],
      score,
      maxScore: score,
      publicScore: requirements.filter(({ group }) => group === 'public').reduce((sum, requirement) => sum + requirement.points, 0),
      privateScore: requirements.filter(({ group }) => group === 'private').reduce((sum, requirement) => sum + requirement.points, 0),
      passed: true,
    };
  });
  const phaseResults = atomicResults.map((result) => ({ ...result }));
  phaseResults[4] = {
    ...phaseResults[4],
    adaptability: { passed: 1, total: 1 },
    regressions: 0,
    regressionGate: { schemaVersion: 'agentbattler.mini-ledger-v7.regression-gate.v1', evaluatedPhases: [1, 2, 3, 4, 5], failedPhases: [], passed: true },
    trajectoryPhases: atomicResults,
  };
  const result = await verifyFinal({ pack, phaseResults, verifierSeedIndex: 11, contract: { phase: 5 } });
  assert.equal(result.score, 100);
  assert.equal(result.passed, true);
  assert.deepEqual(result.adaptability, { passed: 5, total: 5 });
  assert.ok(result.families.every((family) => family.public.total === 4 && family.hidden.total === 16));
  assert.deepEqual(result.infrastructureErrors, []);

  const regressedAtomic = structuredClone(atomicResults);
  regressedAtomic[0].requirements[0].passed = false;
  regressedAtomic[0].requirements[0].points = 0;
  regressedAtomic[0].checks[0].passed = false;
  regressedAtomic[0].checks[0].points = 0;
  regressedAtomic[0].score -= regressedAtomic[0].requirements[0].weight;
  regressedAtomic[0].publicScore -= regressedAtomic[0].requirements[0].weight;
  regressedAtomic[0].passed = false;
  const regressed = structuredClone(phaseResults);
  regressed[4].passed = false;
  regressed[4].adaptability = { passed: 0, total: 1 };
  regressed[4].regressions = 1;
  regressed[4].regressionGate.failedPhases = [1];
  regressed[4].regressionGate.passed = false;
  regressed[4].trajectoryPhases = regressedAtomic;
  const failed = await verifyFinal({ pack, phaseResults: regressed, verifierSeedIndex: 11 });
  assert.equal(failed.passed, false);
  assert.equal(failed.score, 96);
  assert.deepEqual(failed.adaptability, { passed: 4, total: 5 });
});
