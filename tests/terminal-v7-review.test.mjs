import assert from 'node:assert/strict';
import test from 'node:test';

import { TERMINAL_V7_REVIEW_TOPICS } from '../src/terminal-v7-gates.mjs';
import {
  createTerminalV7ReviewSet,
  reviewGateEvidence,
  sealTerminalV7Review,
  validateTerminalV7Review,
} from '../src/terminal-v7-review.mjs';
import { canonicalJsonSha256 } from '../src/provenance.mjs';

const identity = {
  revision: 'r1',
  reviewedCommit: 'a'.repeat(40),
  sealManifestSha256: 'b'.repeat(64),
  requirementMapSha256: 'c'.repeat(64),
};

function review(reviewerId) {
  const evidencePath = `reviews/${reviewerId}/audit.md`;
  const identityArtifactPath = `reviews/${reviewerId}/identity.txt`;
  const identityArtifact = { path: identityArtifactPath, sha256: canonicalJsonSha256({ reviewerId, identityArtifactPath }), size: 24 };
  const artifacts = [
    { path: evidencePath, sha256: canonicalJsonSha256({ reviewerId, evidencePath }), size: 42 },
    identityArtifact,
  ];
  return sealTerminalV7Review({
    schemaVersion: 'agentbattler.terminal-v7-independent-review.v1',
    reviewerId,
    reviewerKind: 'independent-agent',
    reviewerIdentityArtifactPath: identityArtifactPath,
    reviewerIdentitySha256: canonicalJsonSha256({ reviewerId, reviewerKind: 'independent-agent', artifact: identityArtifact }),
    independenceDeclaration: true,
    reviewMethod: 'independent-read-only-audit',
    ...identity,
    reviewedAt: '2026-08-08T08:00:00.000Z',
    artifacts,
    artifactsSha256: canonicalJsonSha256(artifacts),
    topics: TERMINAL_V7_REVIEW_TOPICS.map((id) => ({ id, approved: true, summary: `${id} reviewed`, evidence: [evidencePath] })),
    blockingFindings: [],
    approved: true,
  });
}

test('V7 independent reviews are sealed, complete, and identity-bound', () => {
  const reviews = ['reviewer-a', 'reviewer-b', 'reviewer-c'].map(review);
  reviews.forEach((value) => validateTerminalV7Review(value, identity));
  const set = createTerminalV7ReviewSet({ ...identity, reviews });
  assert.equal(set.approved, true);
  assert.equal(set.reviewerIds.length, 3);
  assert.equal(reviewGateEvidence(reviews).every(({ topics }) => topics.length === 5), true);
});

test('V7 review validation rejects missing evidence and duplicate reviewers', () => {
  const invalid = review('reviewer-a');
  invalid.topics[0].evidence = [];
  assert.throws(() => validateTerminalV7Review(invalid, identity), /hash mismatch/);
  const duplicate = ['reviewer-a', 'reviewer-a', 'reviewer-c'].map(review);
  assert.throws(() => createTerminalV7ReviewSet({ ...identity, reviews: duplicate }), /distinct reviewer/);

  const shared = ['reviewer-a', 'reviewer-b', 'reviewer-c'].map(review);
  shared[1].artifacts = structuredClone(shared[0].artifacts);
  shared[1].artifactsSha256 = shared[0].artifactsSha256;
  shared[1].reviewerIdentityArtifactPath = shared[0].reviewerIdentityArtifactPath;
  shared[1].reviewerIdentitySha256 = canonicalJsonSha256({ reviewerId: shared[1].reviewerId, reviewerKind: shared[1].reviewerKind, artifact: shared[1].artifacts[1] });
  shared[1].topics = shared[1].topics.map((topic) => ({ ...topic, evidence: [shared[0].artifacts[0].path] }));
  shared[1] = sealTerminalV7Review(shared[1]);
  assert.throws(() => createTerminalV7ReviewSet({ ...identity, reviews: shared }), /distinct identity artifacts|distinct artifact inventories|share review artifacts/);
});
