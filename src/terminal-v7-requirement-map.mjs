import { V7_REQUIREMENTS } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { V7_VERIFIER_ASSERTION_CATALOG } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { canonicalJsonSha256 } from './provenance.mjs';

export const TERMINAL_V7_REQUIREMENT_MAP_SCHEMA = 'agentbattler.mini-ledger-v7.requirement-map.v1';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, label) {
  invariant(typeof value === 'string' && value.trim().length > 0, `${label} must be a non-empty string`);
  return value;
}

function sameMembers(left, right) {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

export function auditTerminalV7RequirementMap(map, {
  requirements = V7_REQUIREMENTS,
  verifierAssertions = V7_VERIFIER_ASSERTION_CATALOG,
} = {}) {
  invariant(map?.schemaVersion === TERMINAL_V7_REQUIREMENT_MAP_SCHEMA, 'Unsupported V7 requirement-map schema');
  invariant(map.challengeId === 'terminal-mini-ledger-v7', 'V7 requirement-map challenge changed');
  invariant(Array.isArray(map.clauses) && map.clauses.length > 0, 'V7 requirement map has no clauses');
  invariant(Array.isArray(map.scoredAssertions) && map.scoredAssertions.length > 0, 'V7 requirement map has no scored assertions');
  invariant(Array.isArray(map.verifierAssertions) && map.verifierAssertions.length > 0, 'V7 requirement map has no executable verifier assertions');

  const clauses = new Map();
  for (const clause of map.clauses) {
    nonEmpty(clause?.id, 'V7 clause ID');
    invariant(!clauses.has(clause.id), `Duplicate V7 clause: ${clause.id}`);
    invariant(Number.isSafeInteger(clause.phase) && clause.phase >= 1 && clause.phase <= 5, `V7 clause ${clause.id} has an invalid phase`);
    nonEmpty(clause.text, `V7 clause ${clause.id} text`);
    invariant(clause.normative === true, `V7 clause ${clause.id} is not marked normative`);
    clauses.set(clause.id, clause);
  }

  const definitions = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  invariant(definitions.size === requirements.length, 'V7 requirement definitions contain duplicate IDs');
  invariant(Array.isArray(verifierAssertions) && verifierAssertions.length > 0, 'V7 executable verifier assertion catalog is unavailable');
  const executableCatalog = new Map();
  for (const assertion of verifierAssertions) {
    nonEmpty(assertion?.assertionId, 'V7 executable verifier assertion ID');
    invariant(!executableCatalog.has(assertion.assertionId), `Duplicate executable V7 verifier assertion: ${assertion.assertionId}`);
    invariant(definitions.has(assertion.requirementId), `Executable V7 verifier assertion ${assertion.assertionId} names an unknown requirement`);
    invariant(['public', 'atomic', 'composed'].includes(assertion.caseClass), `Executable V7 verifier assertion ${assertion.assertionId} has an invalid case class`);
    invariant(Number.isSafeInteger(assertion.caseCount) && assertion.caseCount > 0, `Executable V7 verifier assertion ${assertion.assertionId} has an invalid case count`);
    executableCatalog.set(assertion.assertionId, assertion);
  }

  const declaredVerifierAssertions = new Map();
  for (const assertion of map.verifierAssertions) {
    nonEmpty(assertion?.id, 'V7 mapped verifier assertion ID');
    invariant(!declaredVerifierAssertions.has(assertion.id), `Duplicate mapped V7 verifier assertion: ${assertion.id}`);
    const definition = definitions.get(assertion.requirementId);
    invariant(definition, `Mapped V7 verifier assertion ${assertion.id} names an unknown requirement`);
    invariant(['public', 'atomic', 'composed'].includes(assertion.caseClass), `Mapped V7 verifier assertion ${assertion.id} has an invalid case class`);
    invariant(definition.group === 'public' ? assertion.caseClass === 'public' : ['atomic', 'composed'].includes(assertion.caseClass), `Mapped V7 verifier assertion ${assertion.id} has the wrong visibility or class`);
    invariant(Number.isSafeInteger(assertion.expectedCaseCount) && assertion.expectedCaseCount > 0, `Mapped V7 verifier assertion ${assertion.id} has an invalid expected case count`);
    invariant(Array.isArray(assertion.clauseIds) && assertion.clauseIds.length > 0, `Mapped V7 verifier assertion ${assertion.id} has no concrete contract clause`);
    invariant(new Set(assertion.clauseIds).size === assertion.clauseIds.length, `Mapped V7 verifier assertion ${assertion.id} repeats a contract clause`);
    for (const clauseId of assertion.clauseIds) {
      const clause = clauses.get(clauseId);
      invariant(clause, `Mapped V7 verifier assertion ${assertion.id} names unknown clause ${clauseId}`);
      invariant(clause.phase === definition.phase, `Mapped V7 verifier assertion ${assertion.id} crosses phase boundaries`);
    }
    declaredVerifierAssertions.set(assertion.id, assertion);
  }

  const assertions = new Map();
  const referencedClauses = new Set();
  const referencedVerifierAssertions = new Set();
  for (const assertion of map.scoredAssertions) {
    nonEmpty(assertion?.id, 'V7 scored assertion ID');
    invariant(!assertions.has(assertion.id), `Duplicate V7 scored assertion: ${assertion.id}`);
    const definition = definitions.get(assertion.id);
    invariant(definition, `V7 scored assertion is not a declared requirement: ${assertion.id}`);
    invariant(Array.isArray(assertion.clauseIds) && assertion.clauseIds.length > 0, `V7 scored assertion ${assertion.id} has no contract clause`);
    invariant(new Set(assertion.clauseIds).size === assertion.clauseIds.length, `V7 scored assertion ${assertion.id} repeats a contract clause`);
    for (const clauseId of assertion.clauseIds) {
      const clause = clauses.get(clauseId);
      invariant(clause, `V7 scored assertion ${assertion.id} maps unknown clause ${clauseId}`);
      invariant(clause.phase === definition.phase, `V7 scored assertion ${assertion.id} crosses phase boundaries`);
    }
    invariant(Array.isArray(assertion.verifierAssertionIds) && assertion.verifierAssertionIds.length > 0, `V7 scored assertion ${assertion.id} has no executable verifier assertion`);
    invariant(new Set(assertion.verifierAssertionIds).size === assertion.verifierAssertionIds.length, `V7 scored assertion ${assertion.id} repeats an executable verifier assertion`);
    const expectedVerifierAssertionIds = [...declaredVerifierAssertions.values()]
      .filter(({ requirementId }) => requirementId === assertion.id)
      .map(({ id }) => id);
    invariant(sameMembers(assertion.verifierAssertionIds, expectedVerifierAssertionIds), `V7 scored assertion ${assertion.id} does not bind its complete executable verifier coverage`);
    for (const verifierAssertionId of assertion.verifierAssertionIds) {
      const verifierAssertion = declaredVerifierAssertions.get(verifierAssertionId);
      invariant(verifierAssertion?.requirementId === assertion.id, `V7 scored assertion ${assertion.id} maps unrelated executable assertion ${verifierAssertionId}`);
      invariant(verifierAssertion.clauseIds.every((clauseId) => assertion.clauseIds.includes(clauseId)), `Executable V7 verifier assertion ${verifierAssertionId} maps a clause outside requirement ${assertion.id}`);
      verifierAssertion.clauseIds.forEach((clauseId) => referencedClauses.add(clauseId));
      referencedVerifierAssertions.add(verifierAssertionId);
    }
    assertions.set(assertion.id, assertion);
  }

  const unmappedAssertions = [...definitions.keys()].filter((id) => !assertions.has(id));
  const unknownAssertions = [...assertions.keys()].filter((id) => !definitions.has(id));
  const unmappedVerifierAssertions = [...declaredVerifierAssertions.keys()].filter((id) => !referencedVerifierAssertions.has(id));
  const missingExecutableAssertions = [...executableCatalog.keys()].filter((id) => !declaredVerifierAssertions.has(id));
  const unknownExecutableAssertions = [...declaredVerifierAssertions.keys()].filter((id) => !executableCatalog.has(id));
  const mismatchedExecutableAssertions = [...declaredVerifierAssertions.values()].filter((declared) => {
    const executable = executableCatalog.get(declared.id);
    return executable && (
      executable.requirementId !== declared.requirementId
      || executable.caseClass !== declared.caseClass
      || executable.caseCount !== declared.expectedCaseCount
    );
  }).map(({ id }) => id);
  const unverifiedClauses = [...clauses.keys()].filter((id) => !referencedClauses.has(id));
  const unsigned = {
    schemaVersion: 'agentbattler.mini-ledger-v7.requirement-map-audit.v1',
    challengeId: map.challengeId,
    requirementMapSha256: canonicalJsonSha256(map),
    requirementCount: definitions.size,
    clauseCount: clauses.size,
    verifierAssertionCount: executableCatalog.size,
    expectedExecutableCaseCount: [...executableCatalog.values()].reduce((sum, { caseCount }) => sum + caseCount, 0),
    scoredAssertionsMapped: unmappedAssertions.length === 0 && unknownAssertions.length === 0,
    executableAssertionsMapped: unmappedVerifierAssertions.length === 0
      && missingExecutableAssertions.length === 0
      && unknownExecutableAssertions.length === 0
      && mismatchedExecutableAssertions.length === 0,
    normativeClausesVerified: unverifiedClauses.length === 0,
    unmappedAssertions,
    unknownAssertions,
    unmappedVerifierAssertions,
    missingExecutableAssertions,
    unknownExecutableAssertions,
    mismatchedExecutableAssertions,
    unverifiedClauses,
  };
  return { ...unsigned, auditSha256: canonicalJsonSha256(unsigned) };
}

export function assertTerminalV7RequirementMap(map, options) {
  const audit = auditTerminalV7RequirementMap(map, options);
  invariant(audit.scoredAssertionsMapped, `V7 requirement map has unmapped assertions: ${audit.unmappedAssertions.join(', ')}`);
  invariant(audit.executableAssertionsMapped, `V7 requirement map has unmapped executable assertions: ${[
    ...audit.unmappedVerifierAssertions,
    ...audit.missingExecutableAssertions,
    ...audit.unknownExecutableAssertions,
    ...audit.mismatchedExecutableAssertions,
  ].join(', ')}`);
  invariant(audit.normativeClausesVerified, `V7 requirement map has unverified clauses: ${audit.unverifiedClauses.join(', ')}`);
  return audit;
}

export function requirementMapGateEvidence(audit) {
  invariant(audit?.schemaVersion === 'agentbattler.mini-ledger-v7.requirement-map-audit.v1', 'V7 requirement-map audit evidence is invalid');
  return {
    scoredAssertionsMapped: audit.scoredAssertionsMapped,
    executableAssertionsMapped: audit.executableAssertionsMapped,
    normativeClausesVerified: audit.normativeClausesVerified,
    unmappedAssertions: audit.unmappedAssertions.length + audit.unknownAssertions.length,
    unmappedExecutableAssertions: audit.unmappedVerifierAssertions.length
      + audit.missingExecutableAssertions.length
      + audit.unknownExecutableAssertions.length
      + audit.mismatchedExecutableAssertions.length,
    unverifiedClauses: audit.unverifiedClauses.length,
    verifierAssertions: audit.verifierAssertionCount,
    expectedExecutableCases: audit.expectedExecutableCaseCount,
    requirementMapSha256: audit.requirementMapSha256,
    auditSha256: audit.auditSha256,
  };
}
