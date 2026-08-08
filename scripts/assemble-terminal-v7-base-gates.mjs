#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assembleTerminalV7BaseGateEvidence,
  assertTerminalV7BaseGateMatches,
  assertTerminalV7TestReportArtifacts,
  validateTerminalV7BaseGateEvidence,
} from '../src/terminal-v7-release-evidence.mjs';
import { canonicalJson } from '../src/provenance.mjs';
import { assertTerminalV7GoldReportArtifacts } from './validate-terminal-v7-golds.mjs';
import { assertTerminalV7ScriptedReferenceArtifacts } from '../src/terminal-v7-scripted-references.mjs';
import { assertTerminalV7QualityEvidenceArtifacts } from '../src/terminal-v7-quality-gates.mjs';
import { assertTerminalV7ReviewArtifacts } from '../src/terminal-v7-review.mjs';
import { assertTerminalV7RequirementMap } from '../src/terminal-v7-requirement-map.mjs';
import { assertTerminalV7BaseGates } from '../src/terminal-v7-gates.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function privateSeedKey(file) {
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'V7 evaluator key must be one regular file');
  invariant((stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 4096, 'V7 evaluator key permissions or size are invalid');
  const value = (await readFile(file, 'utf8')).trim();
  invariant(value.length >= 16, 'V7 evaluator key is invalid');
  return value;
}

async function cleanCommit(root) {
  const [commit, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }),
  ]);
  invariant(status.stdout.trim() === '', 'V7 base gates require a clean committed source tree');
  invariant(/^[0-9a-f]{40}$/.test(commit.stdout.trim()), 'V7 source commit is invalid');
  return commit.stdout.trim();
}

async function pathExists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function assertTerminalV7PilotNotStarted(resultRoot) {
  invariant(typeof resultRoot === 'string' && path.isAbsolute(resultRoot), 'V7 pilot result root must be absolute');
  for (const directory of ['runs', 'attempts', 'work', 'work-attempts', 'runner-lock-history']) {
    const entries = await readdir(path.join(resultRoot, directory)).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    invariant(entries.length === 0, `V7 base gates found pre-existing frontier execution evidence under ${directory}`);
  }
  for (const file of ['runner.lock', 'runner.log', 'runner.pid']) {
    invariant(!await pathExists(path.join(resultRoot, file)), `V7 base gates found pre-existing frontier execution evidence at ${file}`);
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
}

export async function assembleTerminalV7BaseGatesFromFiles({
  root = ROOT,
  resultRoot,
  revision,
  sealsPath,
  seedKeyPath,
  goldReportPath,
  scriptedReferencesPath,
  qualityEvidencePath,
  requirementMapPath,
  reviewsPath,
  testReportPath,
  outputPath,
  writeOutput = true,
  requirePilotNotStarted = true,
  expectedEvidence = null,
  evaluatedAt = new Date().toISOString(),
} = {}) {
  invariant(path.isAbsolute(root) && path.isAbsolute(resultRoot), 'V7 base-gate roots must be absolute');
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 base-gate revision must look like r1');
  invariant(typeof requirePilotNotStarted === 'boolean', 'V7 base-gate pilot-start policy must be boolean');
  if (requirePilotNotStarted) await assertTerminalV7PilotNotStarted(resultRoot);
  const reviewedCommit = await cleanCommit(root);
  const [seedKey, sealManifest, goldReport, scriptedReferences, qualityEvidence, requirementMap, reviewDocument, testReport] = await Promise.all([
    privateSeedKey(seedKeyPath),
    readJson(sealsPath),
    readJson(goldReportPath),
    readJson(scriptedReferencesPath),
    readJson(qualityEvidencePath),
    readJson(requirementMapPath),
    readJson(reviewsPath),
    readJson(testReportPath),
  ]);
  const reviews = Array.isArray(reviewDocument) ? reviewDocument : reviewDocument.reviews;
  const requirementAudit = assertTerminalV7RequirementMap(requirementMap);
  const goldArtifacts = await assertTerminalV7GoldReportArtifacts({
    evidenceRoot: path.dirname(goldReportPath),
    root,
    report: goldReport,
    sealManifest,
  });
  const scriptedReferenceArtifacts = await assertTerminalV7ScriptedReferenceArtifacts({
    evidenceRoot: resultRoot,
    root,
    report: scriptedReferences,
    sealManifest,
    goldReport,
    expectedVerifierImage: goldReport.verifierImage,
  });
  await assertTerminalV7QualityEvidenceArtifacts({
    evidenceRoot: resultRoot,
    evidence: qualityEvidence,
    revision,
    reviewedCommit,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    goldImplementationSourceSha256: goldArtifacts.implementationSourceSha256,
    verifierImage: goldReport.verifierImage,
  });
  await assertTerminalV7ReviewArtifacts({
    evidenceRoot: resultRoot,
    reviews,
    options: {
      revision,
      reviewedCommit,
      sealManifestSha256: sealManifest.manifestSha256,
      requirementMapSha256: requirementAudit.requirementMapSha256,
    },
  });
  await assertTerminalV7TestReportArtifacts({ evidenceRoot: resultRoot, report: testReport });
  const evidence = assembleTerminalV7BaseGateEvidence({
    revision,
    evaluatedAt,
    reviewedCommit,
    seedKey,
    sealManifest,
    goldReport,
    goldArtifacts,
    scriptedReferences,
    scriptedReferenceArtifacts,
    qualityEvidence,
    requirementMap,
    reviews,
    testReport,
  });
  validateTerminalV7BaseGateEvidence(evidence);
  assertTerminalV7BaseGates(evidence);
  if (expectedEvidence !== null) assertTerminalV7BaseGateMatches(expectedEvidence, evidence);
  if (writeOutput) {
    invariant(typeof outputPath === 'string' && path.isAbsolute(outputPath), 'V7 base-gate output path must be absolute');
    await atomicWrite(outputPath, evidence);
  }
  return evidence;
}

export async function assertTerminalV7BaseGatesFromFiles(options = {}) {
  invariant(options.expectedEvidence, 'V7 base-gate source validation requires the expected sealed base evidence');
  return assembleTerminalV7BaseGatesFromFiles({ ...options, writeOutput: false, outputPath: null });
}

export async function main({ env = process.env, root = ROOT } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`));
  const stateRoot = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const evidence = await assembleTerminalV7BaseGatesFromFiles({
    root,
    resultRoot,
    revision,
    sealsPath: path.resolve(env.AGENTBATTLER_V7_SEALS_PATH
      ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`)),
    seedKeyPath: path.resolve(env.AGENTBATTLER_V7_SEED_KEY_FILE
      ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`)),
    goldReportPath: path.resolve(env.AGENTBATTLER_V7_GOLD_REPORT_PATH
      ?? path.join(resultRoot, 'gold', 'gold-report.json')),
    scriptedReferencesPath: path.resolve(env.AGENTBATTLER_V7_SCRIPTED_REFERENCES_PATH
      ?? path.join(resultRoot, 'control', 'scripted-reference-results.json')),
    qualityEvidencePath: path.resolve(env.AGENTBATTLER_V7_QUALITY_EVIDENCE_PATH
      ?? path.join(resultRoot, 'quality-gates.json')),
    requirementMapPath: path.resolve(env.AGENTBATTLER_V7_REQUIREMENT_MAP_PATH
      ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'requirement-map.json')),
    reviewsPath: path.resolve(env.AGENTBATTLER_V7_REVIEWS_PATH
      ?? path.join(resultRoot, 'control', 'independent-reviews.json')),
    testReportPath: path.resolve(env.AGENTBATTLER_V7_TEST_REPORT_PATH
      ?? path.join(resultRoot, 'test-preflight-report.json')),
    outputPath: path.resolve(env.AGENTBATTLER_V7_BASE_GATES_PATH
      ?? path.join(resultRoot, 'release-gates-base.json')),
  });
  process.stdout.write(`V7 base release evidence sealed at ${evidence.baseEvidenceSha256}\n`);
  return evidence;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 base-gate assembly failed closed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
