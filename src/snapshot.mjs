import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';

export const SNAPSHOT_SCHEMA = 'agentbattler.snapshot.v1';
const HEX_64 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9.-]*$/;
const HF_REVISION = /^[0-9a-f]{40}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateArtifact(value, label) {
  invariant(value && typeof value === 'object', `${label} is required`);
  invariant(typeof value.path === 'string' && value.path.length > 0, `${label}.path is required`);
  invariant(!path.posix.isAbsolute(value.path) && !value.path.split('/').includes('..'), `${label}.path must be relative and safe`);
  invariant(HEX_64.test(value.sha256), `${label}.sha256 must be lowercase SHA-256`);
  invariant(Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0, `${label}.sizeBytes must be a non-negative integer`);
  return value;
}

export function sealSnapshot(snapshot) {
  const { snapshotSha256: _ignored, ...unsigned } = snapshot;
  return { ...unsigned, snapshotSha256: canonicalJsonSha256(unsigned) };
}

export function validateSnapshot(snapshot, { requirePublished = true } = {}) {
  invariant(snapshot?.schemaVersion === SNAPSHOT_SCHEMA, 'Unsupported snapshot schema');
  invariant(SNAPSHOT_ID.test(snapshot.snapshotId), 'Invalid snapshotId');
  invariant(!Number.isNaN(Date.parse(snapshot.createdAt)), 'Invalid snapshot createdAt');
  invariant(GIT_COMMIT.test(snapshot.source?.gitCommit), 'source.gitCommit must be a full 40-character commit SHA');
  invariant(snapshot.dataset?.repoType === 'dataset', 'dataset.repoType must be dataset');
  invariant(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.dataset?.repoId ?? ''), 'Invalid dataset.repoId');
  if (requirePublished) invariant(HF_REVISION.test(snapshot.dataset?.revision ?? ''), 'dataset.revision must pin a 40-character commit SHA');
  else invariant(snapshot.dataset?.revision == null || HF_REVISION.test(snapshot.dataset.revision), 'Invalid optional dataset.revision');
  validateArtifact(snapshot.dataset?.siteData, 'dataset.siteData');
  validateArtifact(snapshot.dataset?.manifest, 'dataset.manifest');
  invariant(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.release?.repository ?? ''), 'Invalid release.repository');
  invariant(typeof snapshot.release?.tag === 'string' && snapshot.release.tag.length > 0, 'release.tag is required');
  validateArtifact(snapshot.release?.archive, 'release.archive');
  invariant(snapshot.totals && Number.isSafeInteger(snapshot.totals.runs), 'totals.runs is required');
  const { snapshotSha256, ...unsigned } = snapshot;
  invariant(HEX_64.test(snapshotSha256 ?? ''), 'snapshotSha256 must be lowercase SHA-256');
  invariant(snapshotSha256 === canonicalJsonSha256(unsigned), 'Snapshot integrity hash mismatch');
  return snapshot;
}

export function huggingFaceResolveUrl(snapshot, artifact) {
  validateSnapshot(snapshot);
  validateArtifact(artifact, 'artifact');
  const repo = snapshot.dataset.repoId.split('/').map(encodeURIComponent).join('/');
  const objectPath = artifact.path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/datasets/${repo}/resolve/${snapshot.dataset.revision}/${objectPath}`;
}

export function githubReleaseAssetUrl(snapshot, artifact = snapshot.release.archive) {
  validateSnapshot(snapshot);
  validateArtifact(artifact, 'artifact');
  const [owner, repository] = snapshot.release.repository.split('/').map(encodeURIComponent);
  return `https://github.com/${owner}/${repository}/releases/download/${encodeURIComponent(snapshot.release.tag)}/${encodeURIComponent(path.posix.basename(artifact.path))}`;
}

export async function verifyFile(file, artifact) {
  validateArtifact(artifact, 'artifact');
  const info = await stat(file);
  invariant(info.isFile(), `Artifact is not a file: ${file}`);
  invariant(info.size === artifact.sizeBytes, `Size mismatch for ${artifact.path}`);
  invariant(await sha256File(file) === artifact.sha256, `SHA-256 mismatch for ${artifact.path}`);
  return file;
}

export async function fetchVerified(urls, destination, artifact, { fetchImpl = fetch } = {}) {
  invariant(Array.isArray(urls) && urls.length > 0, 'At least one download URL is required');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 12)}`;
  await rm(temporary, { force: true });
  const failures = [];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      invariant(response.ok, `${response.status} ${response.statusText}`);
      invariant(response.body, 'Response body is empty');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
      await verifyFile(temporary, artifact);
      await rename(temporary, destination);
      return { destination, url };
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
      await rm(temporary, { force: true });
    }
  }
  throw new Error(`All snapshot downloads failed:\n${failures.join('\n')}`);
}

export async function readSnapshot(file, options) {
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  return validateSnapshot(snapshot, options);
}

export async function writeSnapshot(file, snapshot) {
  const sealed = sealSnapshot(snapshot);
  validateSnapshot(sealed, { requirePublished: false });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${canonicalJson(sealed, { space: 2 })}\n`);
  return sealed;
}

export async function fileArtifact(file, artifactPath = path.basename(file)) {
  const info = await stat(file);
  invariant(info.isFile(), `Artifact is not a file: ${file}`);
  return { path: artifactPath.split(path.sep).join('/'), sha256: await sha256File(file), sizeBytes: info.size };
}
