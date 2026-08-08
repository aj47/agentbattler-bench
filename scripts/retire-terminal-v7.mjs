#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTerminalV7FrontierReleaseIdentity,
  createTerminalV7RetirementRecord,
  terminalV7FrontierReleaseIdentityFromChallenge,
  validateTerminalV7FrontierAnalysis,
  validateTerminalV7FrontierResultSet,
  writeTerminalV7RetirementRecord,
} from '../src/terminal-v7-retirement.mjs';
import { sha256File } from '../src/provenance.mjs';
import { resolveTerminalV7RevisionControlRoot } from '../src/terminal-v7-revision-control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sourcePath(value, evidenceRoot, label) {
  invariant(typeof value === 'string' && value.length > 0 && !value.includes('\0'), `${label} source path is required`);
  return path.resolve(evidenceRoot, value);
}

function safeSystemId(value) {
  invariant(typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value), 'V7 retirement system ID is unsafe for artifact storage');
  return value;
}

async function persistArtifact({ source, controlRoot, relative, expectedSha256 = null, label }) {
  const stat = await lstat(source);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0, `${label} source must be one non-empty regular file`);
  const sha256 = await sha256File(source);
  if (expectedSha256 !== null && expectedSha256 !== undefined) invariant(expectedSha256 === sha256, `${label} declared hash differs from its source bytes`);
  const destination = path.resolve(controlRoot, ...relative.split('/'));
  const relation = path.relative(controlRoot, destination);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} destination escaped revision control`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  return { path: relative, sizeBytes: stat.size, sha256 };
}

export async function main({
  env = process.env,
  argv = process.argv.slice(2),
  root = ROOT,
  now = () => new Date().toISOString(),
  expectedReleaseIdentity = null,
} = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r1';
  const evidenceArgument = argv.find((value) => !value.startsWith('--'));
  const evidencePath = path.resolve(env.AGENTBATTLER_V7_RETIREMENT_EVIDENCE_PATH ?? evidenceArgument ?? '');
  invariant(evidenceArgument || env.AGENTBATTLER_V7_RETIREMENT_EVIDENCE_PATH, 'V7 retirement requires an evidence JSON path');
  const resultRoot = resolveTerminalV7RevisionControlRoot({ root, revision, env });
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const evidenceRoot = path.dirname(evidencePath);
  const frontierInputs = [];
  for (const declaredSystem of evidence.frontierSystems ?? []) {
    const resultSetSource = sourcePath(declaredSystem.resultSetPath ?? declaredSystem.resultSetArtifact?.path, evidenceRoot, 'V7 frontier result set');
    const analysisSource = sourcePath(declaredSystem.analysisPath ?? declaredSystem.analysisArtifact?.path, evidenceRoot, 'V7 frontier analysis');
    const [resultSet, analysis] = await Promise.all([
      readFile(resultSetSource, 'utf8').then(JSON.parse),
      readFile(analysisSource, 'utf8').then(JSON.parse),
    ]);
    validateTerminalV7FrontierResultSet(resultSet, { revision });
    validateTerminalV7FrontierAnalysis(analysis, { resultSet });
    const systemId = safeSystemId(declaredSystem.systemId ?? resultSet.systemId);
    invariant(systemId === resultSet.systemId, 'V7 retirement system ID differs from its result-set evidence');
    frontierInputs.push({ declaredSystem, systemId, resultSetSource, analysisSource, resultSet, analysis });
  }
  if (frontierInputs.length > 0) {
    const authoritativeReleaseIdentity = expectedReleaseIdentity === null
      ? terminalV7FrontierReleaseIdentityFromChallenge(JSON.parse(await readFile(path.resolve(
          env.AGENTBATTLER_V7_RETIREMENT_CHALLENGE_PATH
            ?? path.join(root, 'results', `terminal-mini-ledger-v7-${revision}`, 'challenge.json'),
        ), 'utf8')))
      : createTerminalV7FrontierReleaseIdentity(expectedReleaseIdentity);
    for (const { systemId, resultSet } of frontierInputs) {
      invariant(resultSet.releaseIdentity.releaseIdentitySha256 === authoritativeReleaseIdentity.releaseIdentitySha256,
        `V7 ${systemId} frontier evidence uses another authoritative release identity`);
    }
  }
  let privatePackLeakage = { detected: false };
  if (evidence.privatePackLeakage?.detected === true) {
    const descriptor = await persistArtifact({
      source: sourcePath(evidence.privatePackLeakage.evidencePath ?? evidence.privatePackLeakage.evidenceArtifact?.path, evidenceRoot, 'V7 private-pack leakage evidence'),
      controlRoot: resultRoot,
      relative: 'retirement-evidence/private-pack-leakage.json',
      expectedSha256: evidence.privatePackLeakage.evidenceSha256 ?? evidence.privatePackLeakage.evidenceArtifact?.sha256,
      label: 'V7 private-pack leakage evidence',
    });
    privatePackLeakage = { detected: true, evidenceSha256: descriptor.sha256, evidenceArtifact: descriptor };
  }
  const frontierSystems = [];
  for (const input of frontierInputs) {
    const { declaredSystem, systemId, resultSetSource, analysisSource, resultSet, analysis } = input;
    const resultSetArtifact = await persistArtifact({
      source: resultSetSource,
      controlRoot: resultRoot,
      relative: `retirement-evidence/frontier/${systemId}/result-set.json`,
      expectedSha256: declaredSystem.resultSetFileSha256 ?? declaredSystem.resultSetArtifact?.sha256,
      label: `V7 ${systemId} result set`,
    });
    const analysisArtifact = await persistArtifact({
      source: analysisSource,
      controlRoot: resultRoot,
      relative: `retirement-evidence/frontier/${systemId}/analysis.json`,
      expectedSha256: declaredSystem.analysisFileSha256 ?? declaredSystem.analysisArtifact?.sha256,
      label: `V7 ${systemId} analysis`,
    });
    frontierSystems.push({
      systemId,
      resultSet,
      analysis,
      resultSetArtifact,
      analysisArtifact,
    });
  }
  const record = createTerminalV7RetirementRecord({
    revision,
    detectedAt: evidence.detectedAt ?? now(),
    privatePackLeakage,
    frontierSystems,
  });
  await writeTerminalV7RetirementRecord({ resultRoot, record });
  process.stdout.write(`V7 retired: ${record.action.reason}; record ${record.recordSha256}\n`);
  return record;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 retirement failed closed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
