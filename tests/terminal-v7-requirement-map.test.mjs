import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  V7_FAMILIES,
  V7_PRIVATE_REQUIREMENT_CLASSIFICATION,
  V7_REQUIREMENTS,
} from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';

import {
  assertTerminalV7RequirementMap,
  auditTerminalV7RequirementMap,
  requirementMapGateEvidence,
} from '../src/terminal-v7-requirement-map.mjs';

const MAP_PATH = new URL('../benchmark/challenges/mini-ledger-v7/requirement-map.json', import.meta.url);

async function loadMap() {
  return JSON.parse(await readFile(MAP_PATH, 'utf8'));
}

test('V7 requirement map is bidirectionally complete', async () => {
  const audit = assertTerminalV7RequirementMap(await loadMap());
  assert.equal(audit.requirementCount, 17);
  assert.equal(audit.clauseCount, 19);
  assert.equal(audit.verifierAssertionCount, 28);
  assert.equal(audit.expectedExecutableCaseCount, 99);
  assert.deepEqual(audit.unmappedAssertions, []);
  assert.deepEqual(audit.unmappedVerifierAssertions, []);
  assert.deepEqual(audit.missingExecutableAssertions, []);
  assert.deepEqual(audit.unknownExecutableAssertions, []);
  assert.deepEqual(audit.mismatchedExecutableAssertions, []);
  assert.deepEqual(audit.unverifiedClauses, []);
  assert.deepEqual(requirementMapGateEvidence(audit), {
    scoredAssertionsMapped: true,
    executableAssertionsMapped: true,
    normativeClausesVerified: true,
    unmappedAssertions: 0,
    unmappedExecutableAssertions: 0,
    unverifiedClauses: 0,
    verifierAssertions: 28,
    expectedExecutableCases: 99,
    requirementMapSha256: audit.requirementMapSha256,
    auditSha256: audit.auditSha256,
  });
});

test('V7 requirement map rejects clause linkage without a distinct executable assertion', async () => {
  const map = await loadMap();
  const recovery = map.verifierAssertions.find(({ id }) => id === 'p3.composed.seeded-prior-or-next-recovery');
  recovery.clauseIds = recovery.clauseIds.filter((id) => id !== 'P3-C3');
  const audit = auditTerminalV7RequirementMap(map);
  assert.equal(audit.scoredAssertionsMapped, true);
  assert.equal(audit.executableAssertionsMapped, true);
  assert.equal(audit.normativeClausesVerified, false);
  assert.deepEqual(audit.unverifiedClauses, ['P3-C3']);
  assert.throws(() => assertTerminalV7RequirementMap(map), /unverified clauses: P3-C3/);
});

test('V7 requirement map rejects verifier assertion or executed-case drift', async () => {
  const missing = await loadMap();
  missing.scoredAssertions.find(({ id }) => id === 'V7-P2-PRIVATE-PAGINATION').verifierAssertionIds.pop();
  assert.throws(() => auditTerminalV7RequirementMap(missing), /complete executable verifier coverage/);

  const wrongCount = await loadMap();
  wrongCount.verifierAssertions.find(({ id }) => id === 'p2.public.opaque-ordered-page-strict-limit').expectedCaseCount = 9;
  const audit = auditTerminalV7RequirementMap(wrongCount);
  assert.equal(audit.executableAssertionsMapped, false);
  assert.deepEqual(audit.mismatchedExecutableAssertions, ['p2.public.opaque-ordered-page-strict-limit']);
  assert.throws(() => assertTerminalV7RequirementMap(wrongCount), /unmapped executable assertions/);
});

test('V7 requirement map rejects unmapped requirements and clauses', async () => {
  const map = await loadMap();
  map.scoredAssertions = map.scoredAssertions.slice(1);
  map.clauses.push({ id: 'P1-UNUSED', phase: 1, text: 'Unverified normative behavior.', normative: true });
  const audit = auditTerminalV7RequirementMap(map);
  assert.equal(audit.scoredAssertionsMapped, false);
  assert.equal(audit.normativeClausesVerified, false);
  assert.deepEqual(audit.unmappedAssertions, ['V7-P1-PUBLIC-MIGRATE']);
  assert.ok(audit.unverifiedClauses.includes('P1-UNUSED'));
  assert.throws(() => assertTerminalV7RequirementMap(map), /unmapped assertions/);
});

test('V7 private requirement map explicitly allocates six atomic and ten composed points per family', async () => {
  const map = await loadMap();
  assert.deepEqual(map.privateScoreClasses, {
    atomic: {
      perFamilyWeight: 6,
      totalWeight: 30,
      meaning: 'seeded variants of one disclosed behavioral contract',
    },
    composed: {
      perFamilyWeight: 10,
      totalWeight: 50,
      meaning: 'seeded cross-feature, interleaving, scale, or fault scenarios',
    },
  });
  for (const family of V7_FAMILIES) {
    const classified = V7_PRIVATE_REQUIREMENT_CLASSIFICATION.filter((entry) => entry.family === family);
    assert.equal(classified.reduce((sum, entry) => sum + entry.atomicWeight, 0), 6, `${family} atomic`);
    assert.equal(classified.reduce((sum, entry) => sum + entry.composedWeight, 0), 10, `${family} composed`);
    for (const entry of classified) {
      const mapped = map.scoredAssertions.find(({ id }) => id === entry.requirementId);
      assert.deepEqual(mapped.privateClassWeights, { atomic: entry.atomicWeight, composed: entry.composedWeight });
      assert.equal(entry.atomicWeight + entry.composedWeight, V7_REQUIREMENTS.find(({ id }) => id === entry.requirementId).weight);
    }
  }
});
