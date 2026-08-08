import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { hashV7ExecutableTree } from '../../pack.mjs';
import { canonicalJson, sha256 } from './overlay/src/reference-b/canonical.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveInside(root, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'incident artifact path must be relative');
  const target = path.resolve(root, relative);
  invariant(target.startsWith(`${path.resolve(root)}${path.sep}`), 'incident artifact path escapes the workspace');
  return target;
}

async function readJsonRegular(file) {
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `incident input is not a regular file: ${path.basename(file)}`);
  invariant(stat.size <= 1024 * 1024, `incident input is too large: ${path.basename(file)}`);
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes) };
}

async function writeResponse(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export async function prepareGoldImplementationBIncidentResponse({ destination }) {
  const root = path.resolve(destination);
  const control = path.join(root, '.agentbattler', 'current');
  const { value: contract } = await readJsonRegular(path.join(control, 'task-contract.json'));
  invariant(contract?.schemaVersion === 'agentbattler.mini-ledger-v7.phase-contract.v1' && contract.phase === 4, 'current contract is not Mini Ledger V7 phase 4');
  invariant(contract.incidentEvidencePath === '.agentbattler/current/incident-evidence.json', 'phase-4 evidence path is unexpected');
  invariant(contract.responsePath === 'incident-response.json', 'phase-4 response path is unexpected');
  invariant(/^[0-9a-f]{64}$/.test(contract.executableSourceSha256), 'phase-4 executable source commitment is missing');
  const evidenceFile = resolveInside(root, contract.incidentEvidencePath);
  const { bytes: evidenceBytes, value: evidence } = await readJsonRegular(evidenceFile);
  if (contract.incidentEvidenceSha256) invariant(sha256(evidenceBytes) === contract.incidentEvidenceSha256, 'phase-4 evidence bytes do not match the contract');
  invariant(evidence?.schema === 'agentbattler.ledger.incident-evidence.v1' && Array.isArray(evidence.evidence), 'incident evidence schema is invalid');
  const canonical = evidence.evidence.find(({ id }) => id === 'E-CANONICAL-PRIMARY');
  const acknowledgements = evidence.evidence.find(({ id }) => id === 'E-ACKNOWLEDGED-IDS');
  invariant(canonical?.authority === 'canonical' && Array.isArray(canonical.eventIds), 'canonical primary evidence is missing');
  invariant(acknowledgements?.authority === 'canonical-receipt-index' && Array.isArray(acknowledgements.acknowledgedIds), 'acknowledgement evidence is missing');
  invariant(canonical.deploymentId === acknowledgements.deploymentId, 'canonical evidence has mismatched deployment provenance');
  invariant(acknowledgements.acknowledgedIds.every((id) => canonical.eventIds.includes(id)), 'canonical lineage does not contain every acknowledged id');
  invariant(Number.isSafeInteger(canonical.eventCount) && canonical.eventCount === canonical.eventIds.length, 'canonical evidence event count is inconsistent');
  invariant(/^[0-9a-f]{64}$/.test(canonical.headSha256), 'canonical evidence has no valid head hash');
  const sourceHash = await hashV7ExecutableTree(root);
  invariant(sourceHash === contract.executableSourceSha256, 'executable source differs from the phase-entry commitment');
  const response = {
    schema: 'agentbattler.ledger.incident-response.v1',
    conclusion: 'no-canonical-data-loss',
    canonicalEventCount: canonical.eventCount,
    canonicalHeadSha256: canonical.headSha256,
    executableSourceSha256: sourceHash,
    evidenceIds: evidence.evidence.map(({ id }) => id).sort(),
  };
  invariant(canonicalJson(response.evidenceIds) === canonicalJson([...response.evidenceIds].sort()), 'evidence ids are not sorted');
  const responseFile = resolveInside(root, contract.responsePath);
  await writeResponse(responseFile, response);
  return Object.freeze({ destination: responseFile, response: Object.freeze(response), sha256: sha256(`${JSON.stringify(response)}\n`) });
}
