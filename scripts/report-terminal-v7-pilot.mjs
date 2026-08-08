#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectTerminalV7DevelopmentPilotEvidence,
  createTerminalV7DevelopmentPilotReport,
  createTerminalV7ReleaseGateEvidenceFromPilot,
  writeTerminalV7PilotAndGateReports,
} from '../src/terminal-v7-pilot-report.mjs';
import { assertTerminalV7ScriptedReferenceArtifacts } from '../src/terminal-v7-scripted-references.mjs';
import { assertTerminalV7HumanTwinArtifacts } from '../src/terminal-v7-human-twins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({ env = process.env, root = ROOT, now = () => new Date().toISOString() } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`));
  const referencesPath = path.resolve(env.AGENTBATTLER_V7_SCRIPTED_REFERENCES_PATH
    ?? path.join(resultRoot, 'control', 'scripted-reference-results.json'));
  const humansPath = path.resolve(env.AGENTBATTLER_V7_HUMAN_TWINS_PATH
    ?? path.join(resultRoot, 'control', 'human-twin-validations.json'));
  const baseGatePath = path.resolve(env.AGENTBATTLER_V7_BASE_GATES_PATH
    ?? path.join(resultRoot, 'release-gates-base.json'));
  const sealsPath = path.resolve(env.AGENTBATTLER_V7_SEALS_PATH
    ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`));
  const goldReportPath = path.resolve(env.AGENTBATTLER_V7_GOLD_REPORT_PATH
    ?? path.join(resultRoot, 'gold', 'gold-report.json'));
  const [collected, scriptedReferences, humanTwinValidations, baseEvidence, sealManifest, goldReport] = await Promise.all([
    collectTerminalV7DevelopmentPilotEvidence({ resultRoot }),
    readJson(referencesPath),
    readJson(humansPath),
    readJson(baseGatePath),
    readJson(sealsPath),
    readJson(goldReportPath),
  ]);
  const scriptedReferenceArtifacts = await assertTerminalV7ScriptedReferenceArtifacts({
    evidenceRoot: resultRoot,
    root,
    report: scriptedReferences,
    sealManifest,
    goldReport,
    expectedVerifierImage: goldReport.verifierImage,
  });
  invariant(baseEvidence.sourceArtifacts?.scriptedReferenceReportSha256 === scriptedReferences.reportSha256
    && baseEvidence.sourceArtifacts?.scriptedReferenceClosureSha256 === scriptedReferenceArtifacts.closureSha256,
  'V7 base gates do not bind the executable scripted-reference evidence');
  const humanTwinArtifactClosure = await assertTerminalV7HumanTwinArtifacts({
    evidenceRoot: resultRoot,
    rows: humanTwinValidations,
    options: {
      revision,
      reviewedCommit: baseEvidence.reviewedCommit,
      sealManifestSha256: sealManifest.manifestSha256,
      verifierImage: goldReport.verifierImage,
    },
  });
  const createdAt = now();
  const pilotReport = createTerminalV7DevelopmentPilotReport({
    ...collected,
    scriptedReferences,
    humanTwinValidations,
    humanTwinArtifactClosure,
    createdAt,
  });
  const gate = createTerminalV7ReleaseGateEvidenceFromPilot({ baseEvidence, pilotReport, evaluatedAt: createdAt });
  await writeTerminalV7PilotAndGateReports({ resultRoot, pilotReport, gateEvidence: gate.evidence });
  process.stdout.write(`V7 pilot report: ${pilotReport.accepted ? 'accepted' : 'rejected'}; aggregate release gates: ${gate.evaluation.passed ? 'passed' : 'blocked'}\n`);
  if (!pilotReport.accepted) process.exitCode = 1;
  return { pilotReport, ...gate };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 pilot reporting failed closed: ${String(error?.message ?? error).slice(0, 400)}\n`);
    process.exitCode = 1;
  }
}
