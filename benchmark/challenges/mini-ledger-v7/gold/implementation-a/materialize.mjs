import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashV7ExecutableTree, loadV7Pack, materializeV7Starter } from '../../pack.mjs';

export const GOLD_IMPLEMENTATION_A_SCHEMA = 'agentbattler.mini-ledger-v7.gold-implementation.v1';
export const GOLD_IMPLEMENTATION_A_ID = 'implementation-a';
export const GOLD_IMPLEMENTATION_A_FILES = Object.freeze([
  'bin/ledger.mjs',
  'src/reference-ledger.mjs',
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(HERE, 'overlay');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function within(root, candidate) {
  const resolved = path.resolve(root, candidate);
  assert(resolved === root || resolved.startsWith(`${root}${path.sep}`), 'gold materialization path escapes workspace');
  return resolved;
}

export async function hashGoldAExecutableTree(workspace) {
  return hashV7ExecutableTree(path.resolve(workspace));
}

export async function applyGoldImplementationA({ workspace }) {
  const root = path.resolve(workspace);
  const installed = [];
  for (const relative of GOLD_IMPLEMENTATION_A_FILES) {
    const source = path.join(OVERLAY, ...relative.split('/'));
    const metadata = await lstat(source);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `gold overlay entry is not regular: ${relative}`);
    const destination = within(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.gold-a-${process.pid}.tmp`;
    await copyFile(source, temporary);
    await chmod(temporary, relative.startsWith('bin/') ? 0o750 : 0o640);
    await rename(temporary, destination);
    const bytes = await readFile(destination);
    installed.push({ path: relative, sha256: sha256(bytes), size: bytes.length, mode: relative.startsWith('bin/') ? 0o750 : 0o640 });
  }
  return Object.freeze({
    schemaVersion: GOLD_IMPLEMENTATION_A_SCHEMA,
    implementationId: GOLD_IMPLEMENTATION_A_ID,
    workspace: root,
    executableSourceSha256: await hashGoldAExecutableTree(root),
    files: Object.freeze(installed.map(Object.freeze)),
  });
}

export async function materializeFreshGoldImplementationA({ destination, pack }) {
  assert(pack && typeof pack === 'object', 'materializeFreshGoldImplementationA requires a V7 pack');
  const starter = await materializeV7Starter({ destination, pack });
  const applied = await applyGoldImplementationA({ workspace: destination });
  return Object.freeze({ starter, ...applied, pack });
}

async function atomicJson(file, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.gold-a-${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  const handle = await open(temporary, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function respondToGoldAPhase4({ workspace }) {
  const root = path.resolve(workspace);
  const controlRoot = path.join(root, '.agentbattler', 'current');
  const contract = JSON.parse(await readFile(path.join(controlRoot, 'task-contract.json'), 'utf8'));
  assert(contract.schemaVersion === 'agentbattler.mini-ledger-v7.phase-contract.v1' && contract.phase === 4, 'phase-4 contract is unavailable');
  const evidenceFile = within(root, contract.incidentEvidencePath);
  assert(evidenceFile.startsWith(`${controlRoot}${path.sep}`), 'incident evidence is outside the trusted current control directory');
  const evidenceBytes = await readFile(evidenceFile);
  assert(sha256(evidenceBytes) === contract.incidentEvidenceSha256, 'incident evidence commitment does not match');
  const incident = JSON.parse(evidenceBytes);
  assert(incident.schema === 'agentbattler.ledger.incident-evidence.v1' && Array.isArray(incident.evidence), 'incident evidence schema is invalid');
  const byId = new Map(incident.evidence.map((entry) => [entry.id, entry]));
  assert(byId.size === incident.evidence.length, 'incident evidence ids are duplicated');
  const acknowledgement = byId.get('E-ACKNOWLEDGED-IDS');
  const canonical = byId.get('E-CANONICAL-PRIMARY');
  const archive = byId.get('E-ARCHIVE-SNAPSHOT');
  const historicalLog = byId.get('E-HISTORICAL-WORKER-LOG');
  assert(acknowledgement?.authority === 'canonical-receipt-index', 'acknowledgement authority is invalid');
  assert(canonical?.authority === 'canonical', 'canonical primary evidence is missing');
  assert(archive?.authority === 'advisory' && archive.status === 'superseded', 'archive provenance does not disprove authority');
  assert(historicalLog?.authority === 'advisory' && historicalLog.status === 'historical', 'historical log provenance is invalid');
  assert(acknowledgement.deploymentId === canonical.deploymentId, 'canonical deployment lineage does not match acknowledgements');
  assert(Array.isArray(acknowledgement.acknowledgedIds) && acknowledgement.acknowledgedIds.every((id) => canonical.eventIds.includes(id)), 'canonical primary omits an acknowledged event');
  assert(canonical.eventIds.length === canonical.eventCount && new Set(canonical.eventIds).size === canonical.eventIds.length, 'canonical evidence count is inconsistent');

  const artifactManifest = JSON.parse(await readFile(path.join(root, 'var', 'artifact-manifest.json'), 'utf8'));
  assert(artifactManifest.schema === 'mini-ledger.artifact-manifest.v1' && Array.isArray(artifactManifest.artifacts), 'artifact provenance manifest is invalid');
  assert(incident.incidentId === `incident-${artifactManifest.scenarioId}`, 'incident and artifact-manifest scenarios differ');
  const artifacts = new Map(artifactManifest.artifacts.map((entry) => [entry.path, entry]));
  const primaryArtifact = artifacts.get('ledger.json');
  const acknowledgementArtifact = artifacts.get('var/acknowledged-events.json');
  const archiveArtifact = artifacts.get('var/archive/snapshot.json');
  const logArtifact = artifacts.get('var/logs/worker.log');
  assert(primaryArtifact?.role === 'canonical' && primaryArtifact.sha256 === canonical.sha256 && primaryArtifact.deploymentId === canonical.deploymentId, 'canonical primary provenance is inconsistent');
  assert(acknowledgementArtifact?.role === 'canonical-receipt-index' && acknowledgementArtifact.sha256 === acknowledgement.sha256, 'acknowledgement provenance is inconsistent');
  assert(archiveArtifact?.role === 'advisory' && archiveArtifact.status === 'superseded' && archiveArtifact.sha256 === archive.sha256, 'archive provenance is inconsistent');
  assert(logArtifact?.role === 'advisory' && logArtifact.status === 'historical' && logArtifact.sha256 === historicalLog.sha256, 'log provenance is inconsistent');
  for (const [relative, expected] of [
    ['var/acknowledged-events.json', acknowledgement.sha256],
    ['var/archive/snapshot.json', archive.sha256],
    ['var/logs/worker.log', historicalLog.sha256],
  ]) assert(sha256(await readFile(path.join(root, ...relative.split('/')))) === expected, `artifact bytes do not match provenance: ${relative}`);
  const archivedState = JSON.parse(await readFile(path.join(root, 'var', 'archive', 'snapshot.json'), 'utf8'));
  assert(archive.deploymentId === archivedState.deploymentId && archive.status === archivedState.status, 'archive evidence metadata differs from its artifact');
  assert(JSON.stringify(archive.eventIds) === JSON.stringify(archivedState.events.map(({ id }) => id)), 'archive evidence ids differ from its artifact');
  if (incident.claim?.type === 'possible-data-loss') {
    assert(incident.claim.sourceEvidenceId === archive.id, 'data-loss hypothesis is not tied to the advisory archive');
    assert(archive.deploymentId !== canonical.deploymentId, 'contrary archive is not separated from the canonical deployment');
  } else {
    assert(incident.claim?.type === 'integrity-confirmation' && incident.claim.sourceEvidenceId === canonical.id, 'clean incident claim lacks canonical provenance');
  }
  const executableSourceSha256 = await hashGoldAExecutableTree(root);
  assert(executableSourceSha256 === contract.executableSourceSha256, 'phase-entry executable source hash changed');
  const responseFile = within(root, contract.responsePath);
  assert(!responseFile.startsWith(`${path.join(root, 'src')}${path.sep}`) && !responseFile.startsWith(`${path.join(root, 'bin')}${path.sep}`), 'incident response cannot overwrite executable source');
  const response = {
    schema: 'agentbattler.ledger.incident-response.v1',
    conclusion: 'no-canonical-data-loss',
    canonicalEventCount: canonical.eventCount,
    canonicalHeadSha256: canonical.headSha256,
    executableSourceSha256,
    evidenceIds: [...byId.keys()].sort(),
  };
  await atomicJson(responseFile, response);
  assert(await hashGoldAExecutableTree(root) === executableSourceSha256, 'phase-4 response changed executable source');
  return Object.freeze({ response: Object.freeze(response), responsePath: contract.responsePath, executableSourceSha256 });
}

export async function prepareGoldImplementationAPhase({ destination, phase }) {
  assert(phase === 4, 'implementation-a has no out-of-band action for this phase');
  return respondToGoldAPhase4({ workspace: destination });
}

export async function materializeGoldImplementationA({ workspace, action = 'apply' }) {
  if (action === 'apply') return applyGoldImplementationA({ workspace });
  if (action === 'phase4') return respondToGoldAPhase4({ workspace });
  throw new Error(`Unknown implementation-a action: ${action}`);
}

async function cli(argv) {
  const [action, workspace, instanceId = 'dev-01', variant = 'decoy'] = argv;
  assert((action === 'fresh' || action === 'apply' || action === 'phase4') && workspace, 'usage: node materialize.mjs <fresh|apply|phase4> WORKSPACE [INSTANCE_ID] [clean|decoy]');
  const result = action === 'fresh'
    ? await materializeFreshGoldImplementationA({ destination: workspace, pack: loadV7Pack(instanceId, { variant }) })
    : await materializeGoldImplementationA({ workspace, action });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
