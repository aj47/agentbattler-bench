#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertTerminalV7QualityEvidence,
  assertTerminalV7QualityEvidenceArtifacts,
  runTerminalV7QualityGates,
} from '../src/terminal-v7-quality-gates.mjs';
import { canonicalJson } from '../src/provenance.mjs';
import { validateTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';
import {
  terminalV7GoldImplementationDescriptors,
  validateTerminalV7GoldReport,
} from './validate-terminal-v7-golds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const revision = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 quality-gate revision must look like r1');
  const stateRoot = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const options = {
    output: path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${revision}`, 'quality-gates.json'),
    seedKeyFile: path.resolve(process.env.AGENTBATTLER_V7_SEED_KEY_FILE
      ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`)),
    seedCount: 100,
    repetitionsPerFamily: 100,
    concurrency: 1,
    packIds: null,
    sealsPath: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`),
    goldReportPath: path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${revision}`, 'gold', 'gold-report.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--output') options.output = value;
    else if (token === '--work-root') options.workRoot = value;
    else if (token === '--seed-key-file') options.seedKeyFile = value;
    else if (token === '--seed-count') options.seedCount = Number(value);
    else if (token === '--repetitions-per-family') options.repetitionsPerFamily = Number(value);
    else if (token === '--concurrency') options.concurrency = Number(value);
    else if (token === '--pack-ids') options.packIds = value.split(',').filter(Boolean);
    else if (token === '--seals') options.sealsPath = value;
    else if (token === '--gold-report') options.goldReportPath = value;
    else throw new Error(`unknown argument: ${token}`);
    index += 1;
  }
  invariant(path.isAbsolute(options.output), '--output must be an absolute path');
  if (options.workRoot) invariant(path.isAbsolute(options.workRoot), '--work-root must be an absolute path');
  if (options.seedKeyFile) invariant(path.isAbsolute(options.seedKeyFile), '--seed-key-file must be an absolute path');
  invariant(path.isAbsolute(options.sealsPath), '--seals must be an absolute path');
  invariant(path.isAbsolute(options.goldReportPath), '--gold-report must be an absolute path');
  options.revision = revision;
  return options;
}

const options = parseArguments(process.argv.slice(2));
const seedKey = (await readFile(options.seedKeyFile, 'utf8')).trim();
invariant(seedKey.length >= 16, 'V7 evaluator seed key is invalid');
const evidenceRoot = path.dirname(options.output);
const workRoot = path.resolve(options.workRoot ?? path.join(evidenceRoot, 'quality-evidence'));
const workRelation = path.relative(evidenceRoot, workRoot);
invariant(workRelation && workRelation !== '..' && !workRelation.startsWith(`..${path.sep}`) && !path.isAbsolute(workRelation), 'V7 quality raw evidence must stay under the calibration result root');
const [sealManifest, goldReport, implementations, commit] = await Promise.all([
  readFile(options.sealsPath, 'utf8').then(JSON.parse),
  readFile(options.goldReportPath, 'utf8').then(JSON.parse),
  terminalV7GoldImplementationDescriptors({ root: ROOT }),
  execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).then(({ stdout }) => stdout.trim()),
]);
validateTerminalV7SealManifest(sealManifest, { seedKey });
validateTerminalV7GoldReport(goldReport, { revision: options.revision });
invariant(sealManifest.revision === options.revision && /^[0-9a-f]{40}$/.test(commit), 'V7 quality provenance identity is invalid');
const implementationSources = Object.fromEntries(implementations.map(({ implementationId, sourceSha256 }) => [implementationId, sourceSha256]));
invariant(implementations.every((implementation) => goldReport.implementations.some((gold) => gold.implementationId === implementation.implementationId && gold.sourceSha256 === implementation.sourceSha256)), 'V7 current gold source bytes differ from the gold report');
await mkdir(workRoot, { recursive: true, mode: 0o700 });
let lastProgress = '';
const evidence = await runTerminalV7QualityGates({
  workRoot,
  seedKey,
  seedCount: options.seedCount,
  repetitionsPerFamily: options.repetitionsPerFamily,
  concurrency: options.concurrency,
  ...(options.packIds ? { packIds: options.packIds } : {}),
  artifactRootPath: workRelation.split(path.sep).join('/'),
  provenance: {
    protocolRevision: options.revision,
    reviewedCommit: commit,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    goldImplementationSourceSha256: implementationSources,
  },
  onProgress({ kind, completed, total }) {
    const progress = `${kind} ${completed}/${total}`;
    if (progress !== lastProgress) process.stderr.write(`Mini Ledger V7 quality gate: ${progress}\n`);
    lastProgress = progress;
  },
});
const fullRequested = options.seedCount === 100 && options.repetitionsPerFamily === 100 && !options.packIds;
assertTerminalV7QualityEvidence(evidence, { requireFull: fullRequested });
await mkdir(path.dirname(options.output), { recursive: true });
await assertTerminalV7QualityEvidenceArtifacts({
  evidenceRoot,
  evidence,
  revision: options.revision,
  reviewedCommit: commit,
  sealManifestSha256: sealManifest.manifestSha256,
  goldReportSha256: goldReport.reportSha256,
  goldImplementationSourceSha256: implementationSources,
  verifierImage: goldReport.verifierImage,
});
await writeFile(options.output, `${canonicalJson(evidence)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({
  schemaVersion: evidence.schemaVersion,
  evidenceSha256: evidence.evidenceSha256,
  passed: evidence.qualification.passed,
  output: options.output,
  workRoot,
})}\n`);
