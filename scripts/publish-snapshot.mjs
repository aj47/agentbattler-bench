#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  fetchVerified,
  githubReleaseAssetUrl,
  huggingFaceResolveUrl,
  readSnapshot,
  sealSnapshot,
  validateSnapshot,
  writeSnapshot,
} from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOT_ROOT = path.join(ROOT, '.artifacts/publication/model-suite-2026-07-13');
const API_VERSION = '2026-03-10';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = { snapshotRoot: DEFAULT_SNAPSHOT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot-root') options.snapshotRoot = path.resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

async function run(command, args, { cwd = ROOT, capture = false, allowFailure = false } = {}) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (capture) {
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => chunks.push(chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (code === 0 || allowFailure) resolve({ code, output });
      else reject(new Error(`${command} exited ${code}${output ? `: ${output}` : ''}`));
    });
  });
}

async function huggingFaceRevision(repoId) {
  const response = await fetch(`https://huggingface.co/api/datasets/${repoId}`, { signal: AbortSignal.timeout(30_000) });
  invariant(response.ok, `Hugging Face dataset lookup failed: ${response.status}`);
  const result = await response.json();
  invariant(/^[0-9a-f]{40}$/.test(result.sha ?? ''), 'Hugging Face did not return an immutable dataset revision');
  return result.sha;
}

async function publishDataset(snapshot, datasetRoot) {
  const identity = await run('hf', ['auth', 'whoami'], { capture: true, allowFailure: true });
  invariant(identity.code === 0, 'Hugging Face write authentication is required. Run `hf auth login` with a token that can create and update datasets.');
  const create = await run('hf', ['repo', 'create', snapshot.dataset.repoId, '--repo-type', 'dataset', '--exist-ok'], { capture: true, allowFailure: true });
  invariant(create.code === 0, 'The active Hugging Face credential cannot create or update the target Dataset. Run `hf auth login` with a fine-grained write token.');
  await run('hf', [
    'upload', snapshot.dataset.repoId, datasetRoot, '.',
    '--repo-type', 'dataset',
    '--commit-message', `Publish AgentBattler ${snapshot.snapshotId}`,
  ]);
  return await huggingFaceRevision(snapshot.dataset.repoId);
}

async function verifyDataset(snapshot, scratch) {
  for (const artifact of [snapshot.dataset.siteData, snapshot.dataset.manifest]) {
    const destination = path.join(scratch, 'hf', path.basename(artifact.path));
    await fetchVerified([huggingFaceResolveUrl(snapshot, artifact)], destination, artifact);
  }
}

async function immutableReleasesEnabled(repository) {
  const response = await run('gh', [
    'api',
    '-H', 'Accept: application/vnd.github+json',
    '-H', `X-GitHub-Api-Version: ${API_VERSION}`,
    `repos/${repository}/immutable-releases`,
  ], { capture: true });
  return JSON.parse(response.output).enabled === true;
}

async function ensureImmutableReleases(repository) {
  if (await immutableReleasesEnabled(repository)) return;
  await run('gh', [
    'api', '--method', 'PUT',
    '-H', 'Accept: application/vnd.github+json',
    '-H', `X-GitHub-Api-Version: ${API_VERSION}`,
    `repos/${repository}/immutable-releases`,
  ]);
  invariant(await immutableReleasesEnabled(repository), 'GitHub immutable releases could not be enabled');
}

async function publishRelease(snapshot, releaseRoot) {
  await ensureImmutableReleases(snapshot.release.repository);
  const expected = [
    path.join(releaseRoot, path.basename(snapshot.release.archive.path)),
    path.join(releaseRoot, 'manifest.json'),
    path.join(releaseRoot, 'SHA256SUMS'),
  ];
  const existing = await run('gh', ['release', 'view', snapshot.release.tag, '-R', snapshot.release.repository, '--json', 'isDraft,assets'], { capture: true, allowFailure: true });
  if (existing.code !== 0) {
    const notesPath = path.join(releaseRoot, 'release-notes.md');
    await writeFile(notesPath, [
      `# AgentBattler ${snapshot.snapshotId}`,
      '',
      'Immutable, replayable archive of the exploratory Terra, Sol, and Luna chess benchmark snapshot.',
      '',
      `Source benchmark commit: \`${snapshot.source.gitCommit}\``,
      '',
      'The archive contains normalized run/match/move tables, raw Codex CLI event traces, generated agents, replay inputs, checksums, and the exact website dataset.',
      '',
    ].join('\n'));
    await run('gh', [
      'release', 'create', snapshot.release.tag,
      ...expected,
      '-R', snapshot.release.repository,
      '--target', snapshot.source.gitCommit,
      '--draft',
      '--latest=false',
      '--title', `AgentBattler snapshot · ${snapshot.snapshotId}`,
      '--notes-file', notesPath,
    ]);
  } else {
    const release = JSON.parse(existing.output);
    const uploaded = new Set(release.assets.map((asset) => asset.name));
    const missing = expected.filter((file) => !uploaded.has(path.basename(file)));
    invariant(release.isDraft || missing.length === 0, `Published Release is missing assets: ${missing.map(path.basename).join(', ')}`);
    for (const file of missing) {
      await run('gh', ['release', 'upload', snapshot.release.tag, file, '-R', snapshot.release.repository]);
    }
  }
  const state = JSON.parse((await run('gh', ['release', 'view', snapshot.release.tag, '-R', snapshot.release.repository, '--json', 'isDraft'], { capture: true })).output);
  if (state.isDraft) await run('gh', ['release', 'edit', snapshot.release.tag, '-R', snapshot.release.repository, '--draft=false']);
}

async function verifyRelease(snapshot, scratch) {
  const [owner, repository] = snapshot.release.repository.split('/');
  const response = await run('gh', [
    'api',
    '-H', 'Accept: application/vnd.github+json',
    '-H', `X-GitHub-Api-Version: ${API_VERSION}`,
    `repos/${owner}/${repository}/releases/tags/${snapshot.release.tag}`,
  ], { capture: true });
  const release = JSON.parse(response.output);
  invariant(release.immutable === true, 'Published GitHub Release is not immutable');
  const asset = release.assets.find((item) => item.name === path.basename(snapshot.release.archive.path));
  invariant(asset, `Release is missing ${snapshot.release.archive.path}`);
  invariant(asset.digest === `sha256:${snapshot.release.archive.sha256}`, 'GitHub release asset digest mismatch');
  await fetchVerified(
    [githubReleaseAssetUrl(snapshot, snapshot.release.archive)],
    path.join(scratch, 'github', path.basename(snapshot.release.archive.path)),
    snapshot.release.archive,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const unpublishedPath = path.join(options.snapshotRoot, 'snapshot.unpublished.json');
  const unpublished = await readSnapshot(unpublishedPath, { requirePublished: false });
  const datasetRoot = path.join(options.snapshotRoot, 'dataset');
  const releaseRoot = path.join(options.snapshotRoot, 'release');
  const scratch = path.join(options.snapshotRoot, 'verification');
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  const revision = await publishDataset(unpublished, datasetRoot);
  const published = sealSnapshot({ ...unpublished, dataset: { ...unpublished.dataset, revision } });
  validateSnapshot(published);
  await verifyDataset(published, scratch);
  await publishRelease(published, releaseRoot);
  await verifyRelease(published, scratch);

  const namedPath = path.join(ROOT, 'snapshots', `${published.snapshotId}.json`);
  const latestPath = path.join(ROOT, 'snapshots/latest.json');
  await writeSnapshot(namedPath, published);
  await writeFile(latestPath, await readFile(namedPath));
  console.log(`Published and verified ${published.snapshotId}.`);
  console.log(`Hugging Face revision: ${revision}`);
  console.log(`GitHub Release: https://github.com/${published.release.repository}/releases/tag/${published.release.tag}`);
  console.log(`Committed pointer ready: ${path.relative(ROOT, namedPath)}`);
}

main().catch((error) => {
  console.error(`Snapshot publish: ${error.message}`);
  process.exitCode = 1;
});
