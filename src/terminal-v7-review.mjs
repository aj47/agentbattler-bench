import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJsonSha256, sha256File } from './provenance.mjs';
import { TERMINAL_V7_REVIEW_TOPICS } from './terminal-v7-gates.mjs';

export const TERMINAL_V7_REVIEW_SCHEMA = 'agentbattler.terminal-v7-independent-review.v1';
export const TERMINAL_V7_REVIEW_SET_SCHEMA = 'agentbattler.terminal-v7-independent-review-set.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, label) {
  invariant(typeof value === 'string' && value.trim().length > 0, `${label} must be a non-empty string`);
  return value;
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

function validateReviewArtifactInventory(review) {
  invariant(Array.isArray(review.artifacts) && review.artifacts.length > 0, 'V7 independent review has no artifact inventory');
  const seen = new Map();
  for (const [index, artifact] of review.artifacts.entries()) {
    const relative = safeRelative(artifact?.path, `V7 review artifact ${index + 1}`);
    invariant(!seen.has(relative), `V7 independent review repeats artifact ${relative}`);
    invariant(SHA256_RE.test(artifact.sha256 ?? '') && Number.isSafeInteger(artifact.size) && artifact.size >= 0, `V7 review artifact ${relative} descriptor is invalid`);
    seen.set(relative, artifact);
  }
  invariant(review.artifactsSha256 === canonicalJsonSha256(review.artifacts), 'V7 independent-review artifact inventory hash mismatch');
  return seen;
}

export function sealTerminalV7Review(review) {
  invariant(review && typeof review === 'object' && !Array.isArray(review), 'V7 review is required');
  const unsigned = { ...review };
  delete unsigned.reviewSha256;
  return { ...unsigned, reviewSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7Review(review, {
  revision = null,
  reviewedCommit = null,
  sealManifestSha256 = null,
  requirementMapSha256 = null,
} = {}) {
  invariant(review?.schemaVersion === TERMINAL_V7_REVIEW_SCHEMA, 'Unsupported V7 independent-review schema');
  invariant(review.reviewSha256 === canonicalJsonSha256(Object.fromEntries(Object.entries(review).filter(([key]) => key !== 'reviewSha256'))), 'V7 independent-review hash mismatch');
  nonEmpty(review.reviewerId, 'V7 reviewer ID');
  invariant(['human', 'independent-agent'].includes(review.reviewerKind), 'V7 reviewer kind is invalid');
  invariant(SHA256_RE.test(review.reviewerIdentitySha256 ?? ''), 'V7 reviewer identity commitment is invalid');
  invariant(review.independenceDeclaration === true, 'V7 reviewer did not declare independence');
  invariant(review.reviewMethod === 'independent-read-only-audit', 'V7 independent-review method changed');
  invariant(/^r[1-9]\d*$/.test(review.revision ?? ''), 'V7 review revision is invalid');
  invariant(COMMIT_RE.test(review.reviewedCommit ?? ''), 'V7 reviewed commit is invalid');
  invariant(SHA256_RE.test(review.sealManifestSha256 ?? ''), 'V7 review seal-manifest commitment is invalid');
  invariant(SHA256_RE.test(review.requirementMapSha256 ?? ''), 'V7 review requirement-map commitment is invalid');
  invariant(typeof review.reviewedAt === 'string' && Number.isFinite(Date.parse(review.reviewedAt)), 'V7 review timestamp is invalid');
  if (revision !== null) invariant(review.revision === revision, 'V7 review uses another revision');
  if (reviewedCommit !== null) invariant(review.reviewedCommit === reviewedCommit, 'V7 reviews do not cover the same commit');
  if (sealManifestSha256 !== null) invariant(review.sealManifestSha256 === sealManifestSha256, 'V7 review uses another seal manifest');
  if (requirementMapSha256 !== null) invariant(review.requirementMapSha256 === requirementMapSha256, 'V7 review uses another requirement map');
  const artifacts = validateReviewArtifactInventory(review);
  const identityArtifactPath = safeRelative(review.reviewerIdentityArtifactPath, 'V7 reviewer identity artifact');
  const identityArtifact = artifacts.get(identityArtifactPath);
  invariant(identityArtifact && identityArtifact.size > 0, 'V7 reviewer identity commitment does not reference a nonempty sealed artifact');
  invariant(review.reviewerIdentitySha256 === canonicalJsonSha256({
    reviewerId: review.reviewerId,
    reviewerKind: review.reviewerKind,
    artifact: identityArtifact,
  }), 'V7 reviewer identity commitment is not derived from its sealed identity artifact');
  invariant(Array.isArray(review.topics) && review.topics.length === TERMINAL_V7_REVIEW_TOPICS.length, 'V7 review topic set is incomplete');
  invariant(new Set(review.topics.map(({ id }) => id)).size === review.topics.length, 'V7 review repeats a topic');
  for (const topic of TERMINAL_V7_REVIEW_TOPICS) {
    const finding = review.topics.find(({ id }) => id === topic);
    invariant(finding, `V7 review is missing topic ${topic}`);
    invariant(finding.approved === true || finding.approved === false, `V7 review topic ${topic} has no decision`);
    nonEmpty(finding.summary, `V7 review topic ${topic} summary`);
    invariant(Array.isArray(finding.evidence) && finding.evidence.length > 0, `V7 review topic ${topic} has no evidence references`);
    finding.evidence.forEach((reference, index) => {
      const relative = safeRelative(reference, `V7 review topic ${topic} evidence ${index + 1}`);
      invariant(artifacts.has(relative), `V7 review topic ${topic} references an unbound artifact: ${relative}`);
    });
  }
  invariant(Array.isArray(review.blockingFindings), 'V7 blocking findings must be an array');
  invariant(review.approved === review.topics.every(({ approved }) => approved) && review.approved === (review.blockingFindings.length === 0), 'V7 review approval does not match its findings');
  return review;
}

export async function assertTerminalV7ReviewArtifacts({ evidenceRoot, reviews, options = {} } = {}) {
  invariant(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot), 'V7 review evidence root must be absolute');
  invariant(Array.isArray(reviews) && reviews.length === 3, 'V7 review artifact closure requires three reviews');
  for (const review of reviews) {
    validateTerminalV7Review(review, options);
    for (const artifact of review.artifacts) {
      const relative = safeRelative(artifact.path, 'V7 review artifact');
      const file = path.resolve(evidenceRoot, ...relative.split('/'));
      const relation = path.relative(evidenceRoot, file);
      invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), 'V7 review artifact escaped its evidence root');
      const stat = await lstat(file);
      invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === artifact.size, `V7 review artifact is not the sealed regular file: ${relative}`);
      invariant(await sha256File(file) === artifact.sha256, `V7 review artifact hash mismatch: ${relative}`);
    }
  }
  const set = createTerminalV7ReviewSet({ ...options, reviews });
  return {
    schemaVersion: 'agentbattler.terminal-v7-independent-review-artifact-closure.v1',
    reviewSetSha256: set.reviewSetSha256,
    artifactSetsSha256: canonicalJsonSha256(reviews.map(({ reviewerId, reviewerIdentitySha256, artifactsSha256 }) => ({ reviewerId, reviewerIdentitySha256, artifactsSha256 })).sort((left, right) => left.reviewerId.localeCompare(right.reviewerId))),
  };
}

export function createTerminalV7ReviewSet({
  revision,
  reviewedCommit,
  sealManifestSha256,
  requirementMapSha256,
  reviews,
} = {}) {
  invariant(Array.isArray(reviews) && reviews.length === 3, 'V7 release requires exactly three independent reviews');
  const normalized = reviews.map((review) => validateTerminalV7Review(review, {
    revision,
    reviewedCommit,
    sealManifestSha256,
    requirementMapSha256,
  })).sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  invariant(new Set(normalized.map(({ reviewerId }) => reviewerId)).size === 3, 'V7 reviews must have three distinct reviewer IDs');
  invariant(new Set(normalized.map(({ reviewerIdentitySha256 }) => reviewerIdentitySha256)).size === 3, 'V7 reviews must have three distinct reviewer identity commitments');
  invariant(new Set(normalized.map(({ reviewerIdentityArtifactPath }) => reviewerIdentityArtifactPath)).size === 3, 'V7 reviews must have three distinct identity artifacts');
  invariant(new Set(normalized.map(({ artifactsSha256 }) => artifactsSha256)).size === 3, 'V7 reviews must have independently distinct artifact inventories');
  const artifactPaths = normalized.flatMap(({ artifacts }) => artifacts.map(({ path: artifactPath }) => artifactPath));
  invariant(new Set(artifactPaths).size === artifactPaths.length, 'V7 independent reviews may not share review artifacts');
  invariant(normalized.every(({ approved }) => approved === true), 'V7 review set contains a blocking review');
  const unsigned = {
    schemaVersion: TERMINAL_V7_REVIEW_SET_SCHEMA,
    revision,
    reviewedCommit,
    sealManifestSha256,
    requirementMapSha256,
    reviewerIds: normalized.map(({ reviewerId }) => reviewerId),
    reviewerIdentitySha256: normalized.map(({ reviewerIdentitySha256 }) => reviewerIdentitySha256),
    reviewSha256: normalized.map(({ reviewSha256 }) => reviewSha256),
    approved: true,
  };
  return { ...unsigned, reviewSetSha256: canonicalJsonSha256(unsigned) };
}

export function reviewGateEvidence(reviews) {
  invariant(Array.isArray(reviews), 'V7 reviews are required for gate evidence');
  return reviews.map((review) => ({
    reviewerId: review.reviewerId,
    reviewerIdentitySha256: review.reviewerIdentitySha256,
    approved: review.approved,
    topics: review.topics.filter(({ approved }) => approved).map(({ id }) => id),
    reviewSha256: review.reviewSha256,
    artifactsSha256: review.artifactsSha256,
  }));
}
