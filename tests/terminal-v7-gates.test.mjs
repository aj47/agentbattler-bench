import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTerminalV7ReleaseGates,
  evaluateTerminalV7ReleaseGates,
  terminalV7RetirementAction,
  terminalV7SaturationAction,
} from '../src/terminal-v7-gates.mjs';

function passingEvidence() {
  return {
    revision: 'r1',
    packSeals: [
      ...Array.from({ length: 3 }, (_, index) => ({ pool: 'dev', instanceId: `dev-${index}`, sealSha256: 'a'.repeat(64), sealedBeforePilot: true })),
      ...Array.from({ length: 5 }, (_, index) => ({ pool: 'release', instanceId: `release-${index}`, sealSha256: 'b'.repeat(64), sealedBeforePilot: true })),
      ...Array.from({ length: 5 }, (_, index) => ({ pool: 'reserve', instanceId: `reserve-${index}`, sealSha256: 'c'.repeat(64), sealedBeforePilot: true })),
    ],
    gold: { independentImplementations: 2, verifierSeeds: 100, cleanMinCore: 100, decoyMinCore: 100 },
    flake: { executionsPerFamily: 100, failures: 0 },
    mutation: { killRate: 0.96, criticalSurvivors: [], semanticAlternatesPassed: true },
    requirementMap: { scoredAssertionsMapped: true, normativeClausesVerified: true, unmappedAssertions: 0, unverifiedClauses: 0 },
    reviews: ['a', 'b', 'c'].map((reviewerId) => ({ reviewerId, approved: true, topics: ['solvability', 'prompt-verifier-correspondence', 'alternate-solutions', 'decoy-falsifiability', 'infrastructure-cleanliness'] })),
    tests: { existing: true, v7: true, m4Preflights: 5, failures: 0 },
    pilot: { lunaMaxJobs: 12, lunaHighJobs: 3, lunaMaxDecoyMedian: 63, maximumCore: 92, exactCompletions: 1, lunaMaxMinusHigh: 12, scriptedTwinDifference: 0, humanTwinDifference: 4.9, infrastructureInvalid: 0 },
  };
}

test('V7 release gates fail closed and accept complete qualifying evidence', () => {
  const evidence = passingEvidence();
  assert.equal(assertTerminalV7ReleaseGates(evidence).passed, true);
  evidence.pilot.maximumCore = 100;
  const failed = evaluateTerminalV7ReleaseGates(evidence);
  assert.equal(failed.passed, false);
  assert.ok(failed.failures.some(({ id }) => id === 'PILOT-SATURATION'));
  assert.throws(() => assertTerminalV7ReleaseGates(evidence), /PILOT-SATURATION/);
});

test('V7 saturation action pauses new jobs after any Core 100', () => {
  assert.equal(terminalV7SaturationAction([{ runKey: 'a', score: { core: { points: 99 } } }]).pauseAtNextSafeBoundary, false);
  assert.deepEqual(terminalV7SaturationAction([{ runKey: 'b', score: { corePoints: 100 } }]), {
    pauseAtNextSafeBoundary: true,
    reason: 'core-100-saturation-audit',
    runKey: 'b',
  });
});

test('V7 retirement requires leakage or two independently saturated frontier systems', () => {
  assert.deepEqual(terminalV7RetirementAction({ privatePackLeakage: true }), {
    retire: true,
    reason: 'private-pack-leakage',
    qualifyingSystems: [],
  });
  assert.equal(terminalV7RetirementAction({
    frontierSystems: [
      { systemId: 'frontier-a', independenceKeySha256: 'a'.repeat(64), meanCore: 86, lowerConfidenceBound: 81 },
      { systemId: 'frontier-b', independenceKeySha256: 'b'.repeat(64), meanCore: 85, lowerConfidenceBound: 81 },
    ],
  }).retire, false);
  assert.deepEqual(terminalV7RetirementAction({
    frontierSystems: [
      { systemId: 'frontier-b', independenceKeySha256: 'b'.repeat(64), meanCore: 90, lowerConfidenceBound: 84 },
      { systemId: 'frontier-a', independenceKeySha256: 'a'.repeat(64), meanCore: 86, lowerConfidenceBound: 81 },
    ],
  }), {
    retire: true,
    reason: 'frontier-saturation',
    qualifyingSystems: ['frontier-a', 'frontier-b'],
  });
  assert.throws(() => terminalV7RetirementAction({
    frontierSystems: [
      { systemId: 'frontier-a', independenceKeySha256: 'a'.repeat(64), meanCore: 90, lowerConfidenceBound: 84 },
      { systemId: 'frontier-alias', independenceKeySha256: 'a'.repeat(64), meanCore: 90, lowerConfidenceBound: 84 },
    ],
  }), /independently bound/);
});
