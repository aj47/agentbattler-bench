import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { V7_REQUIREMENTS } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { validateTerminalV7FinalEvaluation } from '../scripts/verify-terminal-v7-results.mjs';
import { MINI_LEDGER_V7_FAMILIES } from '../src/terminal-v7.mjs';

const REQUIREMENT_MAP = JSON.parse(await readFile(new URL('../benchmark/challenges/mini-ledger-v7/requirement-map.json', import.meta.url), 'utf8'));
const MAPPED_ASSERTIONS = new Map(REQUIREMENT_MAP.verifierAssertions.map((assertion) => [
  `${assertion.requirementId}\0${assertion.caseClass}`,
  assertion,
]));

function requirementRecord(requirement) {
  const common = {
    id: requirement.id,
    family: requirement.family,
    group: requirement.group,
    weight: requirement.weight,
    points: requirement.weight,
    passed: true,
  };
  if (requirement.group === 'public') {
    const assertion = MAPPED_ASSERTIONS.get(`${requirement.id}\0public`);
    return { ...common, assertionId: assertion.id, caseCount: assertion.expectedCaseCount };
  }
  return {
    ...common,
    classes: Object.fromEntries(['atomic', 'composed'].map((caseClass) => {
      const assertion = MAPPED_ASSERTIONS.get(`${requirement.id}\0${caseClass}`);
      const weight = requirement.privateClassWeights[caseClass];
      return [caseClass, {
        assertionId: assertion.id,
        caseCount: assertion.expectedCaseCount,
        weight,
        points: weight,
        passed: true,
      }];
    })),
  };
}

function completeEvaluation() {
  const requirements = V7_REQUIREMENTS.map(requirementRecord);
  const families = MINI_LEDGER_V7_FAMILIES.map((id) => {
    const records = requirements.filter(({ family }) => family === id);
    const publicPassed = records.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0);
    const privateRecords = records.filter(({ group }) => group === 'private');
    const atomicPassed = privateRecords.reduce((sum, record) => sum + record.classes.atomic.points, 0);
    const composedPassed = privateRecords.reduce((sum, record) => sum + record.classes.composed.points, 0);
    return {
      id,
      public: { passed: publicPassed, total: 4 },
      hiddenAtomic: { passed: atomicPassed, total: 6 },
      hiddenComposed: { passed: composedPassed, total: 10 },
      hidden: { passed: atomicPassed + composedPassed, total: 16 },
    };
  });
  return {
    infrastructureErrors: [],
    requirements,
    checks: structuredClone(requirements),
    families,
    score: 100,
    maxScore: 100,
    publicScore: 20,
    privateScore: 80,
    passed: true,
    adaptability: { passed: 5, total: 5 },
  };
}

test('strict V7 evaluation validates mapped assertion identities, cases, classes, points, and family partitions', () => {
  assert.doesNotThrow(() => validateTerminalV7FinalEvaluation(completeEvaluation(), REQUIREMENT_MAP));

  const assertionTamper = completeEvaluation();
  assertionTamper.requirements.find(({ group }) => group === 'public').assertionId = 'p1.public.substituted';
  assertionTamper.checks.find(({ group }) => group === 'public').assertionId = 'p1.public.substituted';
  assert.throws(() => validateTerminalV7FinalEvaluation(assertionTamper, REQUIREMENT_MAP), /assertion ID changed/);

  const caseCountTamper = completeEvaluation();
  caseCountTamper.requirements.find(({ group }) => group === 'private').classes.atomic.caseCount += 1;
  caseCountTamper.checks.find(({ group }) => group === 'private').classes.atomic.caseCount += 1;
  assert.throws(() => validateTerminalV7FinalEvaluation(caseCountTamper, REQUIREMENT_MAP), /case count changed/);

  const classPointTamper = completeEvaluation();
  classPointTamper.requirements.find(({ group }) => group === 'private').classes.composed.points -= 1;
  classPointTamper.checks.find(({ group }) => group === 'private').classes.composed.points -= 1;
  assert.throws(() => validateTerminalV7FinalEvaluation(classPointTamper, REQUIREMENT_MAP), /points disagree/);

  const familyTamper = completeEvaluation();
  familyTamper.families[0].hiddenAtomic.passed -= 1;
  assert.throws(() => validateTerminalV7FinalEvaluation(familyTamper, REQUIREMENT_MAP), /hidden atomic score/);

  const identity = { challengeId: 'terminal-mini-ledger-v7', instanceId: 'dev-01', variant: 'clean', verifierSeedIndex: 0 };
  const identityBound = {
    ...completeEvaluation(),
    schemaVersion: 'agentbattler.mini-ledger-v7.verification.v1',
    ...identity,
  };
  assert.doesNotThrow(() => validateTerminalV7FinalEvaluation(identityBound, REQUIREMENT_MAP, identity));
  const transplanted = { ...identityBound, instanceId: 'dev-02' };
  assert.throws(() => validateTerminalV7FinalEvaluation(transplanted, REQUIREMENT_MAP, identity), /pack identity changed/);
});
