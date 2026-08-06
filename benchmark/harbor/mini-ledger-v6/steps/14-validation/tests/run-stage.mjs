#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicStage } from './mini-ledger-v4/public-verifier.mjs';
import { verifyHoldout } from './mini-ledger-v4/holdout-verifier.mjs';

const workspace = '/app';
const logs = '/logs/verifier';
const stageId = process.env.AGENTBATTLER_STAGE_ID;
const stagePoints = Number(process.env.AGENTBATTLER_STAGE_POINTS);
const finalStep = process.env.AGENTBATTLER_FINAL_STEP === '1';
const candidateSnapshotsRequired = true;
const finalPublicRequired = true;
const stageDefinitions = [{"id":"foundation","points":3},{"id":"batch","points":3},{"id":"pagination","points":3},{"id":"migration","points":3},{"id":"atomicity","points":3},{"id":"recovery","points":3},{"id":"concurrency","points":3},{"id":"compaction","points":3},{"id":"roundtrip","points":3},{"id":"replay","points":3},{"id":"audit","points":5},{"id":"scale","points":5},{"id":"stress-concurrency","points":10},{"id":"validation","points":10},{"id":"scale-stress","points":10}];
await mkdir(logs, { recursive: true });
await chmod('/tests', 0o700);
await chmod(workspace, 0o777);
process.env.AGENTBATTLER_CANDIDATE_UID = '1000';
process.env.AGENTBATTLER_CANDIDATE_GID = '1000';

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else total += (await lstat(file)).size;
  }
  return total;
}

async function captureCandidateSnapshot() {
  const source = path.join(workspace, 'ledger.mjs');
  try {
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return { schemaVersion: 'agentbattler.terminal-candidate-snapshot.v1', entryPoint: 'ledger.mjs', present: true, kind: sourceStat.isSymbolicLink() ? 'symbolic-link' : sourceStat.isDirectory() ? 'directory' : 'other', archived: false };
    const bytes = await readFile(source);
    const mode = sourceStat.mode & 0o777;
    await writeFile(path.join(logs, 'candidate-ledger.mjs'), bytes, { mode });
    return { schemaVersion: 'agentbattler.terminal-candidate-snapshot.v1', entryPoint: 'ledger.mjs', present: true, kind: 'regular-file', archived: true, bytes: sourceStat.size, sha256: createHash('sha256').update(bytes).digest('hex'), mode: mode.toString(8).padStart(4, '0'), executable: (mode & 0o111) !== 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 'agentbattler.terminal-candidate-snapshot.v1', entryPoint: 'ledger.mjs', present: false, kind: 'missing', archived: false };
    throw error;
  }
}

let stage = { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: 0, diagnostic: 'verifier did not run' };
let holdout = null;
let finalPublic = null;
let candidateSnapshot = null;
let workspaceBytes = null;
let infrastructureError = null;
try {
  workspaceBytes = await directoryBytes(workspace);
  if (candidateSnapshotsRequired) candidateSnapshot = await captureCandidateSnapshot();
  stage = candidateSnapshotsRequired && (!candidateSnapshot.present || candidateSnapshot.kind !== 'regular-file')
    ? { ...stage, diagnostic: candidateSnapshot.present ? 'candidate ledger.mjs is not a regular file' : 'candidate ledger.mjs is missing' }
    : workspaceBytes > 50 * 1024 * 1024
    ? { ...stage, diagnostic: `workspace exceeds 50 MiB limit: ${workspaceBytes} bytes` }
    : await verifyPublicStage({ workspace, ledgerPath: path.join(workspace, 'ledger.mjs'), stageId });
} catch (error) {
  infrastructureError = String(error?.stack ?? error).slice(0, 2000);
  stage = { ...stage, diagnostic: 'verifier infrastructure failed before the candidate could be judged' };
}
if (finalStep) {
  if (finalPublicRequired) {
    const finalStages = [];
    if (!candidateSnapshot?.present || candidateSnapshot.kind !== 'regular-file') {
      const diagnostic = candidateSnapshot?.present ? 'candidate ledger.mjs is not a regular file' : 'candidate ledger.mjs is missing';
      for (const definition of stageDefinitions) finalStages.push({ id: definition.id, passed: false, regressions: 1, exitCode: 1, durationMs: 0, diagnostic });
    } else {
      try {
        for (const definition of stageDefinitions) finalStages.push(await verifyPublicStage({ workspace, ledgerPath: path.join(workspace, 'ledger.mjs'), stageId: definition.id }));
      } catch (error) {
        infrastructureError ??= String(error?.stack ?? error).slice(0, 2000);
      }
    }
    if (finalStages.length === stageDefinitions.length) finalPublic = {
      schemaVersion: 'agentbattler.terminal-final-public.v1',
      evaluator: 'all-public-stages-from-final-source-only-candidate',
      stages: finalStages,
      passed: finalStages.filter((entry) => entry.passed === true).length,
      total: stageDefinitions.length,
      visiblePoints: stageDefinitions.reduce((sum, definition) => sum + (finalStages.find((entry) => (entry.id ?? entry.stageId) === definition.id)?.passed === true ? definition.points : 0), 0),
      maxVisiblePoints: stageDefinitions.reduce((sum, definition) => sum + definition.points, 0),
    };
  }
  try { holdout = await verifyHoldout({ workspace }); }
  catch (error) { infrastructureError ??= String(error?.stack ?? error).slice(0, 2000); holdout = { passed: 0, total: 11, cases: [{ name: 'holdout-verifier-infrastructure-error', passed: false, diagnostic: 'holdout verifier infrastructure failed' }] }; }
}
const reward = {
  reward: stage.passed ? 1 : 0,
  visible_points: stage.passed ? stagePoints : 0,
  regressions: Number(stage.regressions ?? (stage.passed ? 0 : 1)),
  stage_duration_ms: Number(stage.durationMs ?? 0),
  holdout_passed: Number(holdout?.passed ?? 0),
  holdout_total: Number(holdout?.total ?? 0),
};
let isolationProbe = null;
try { isolationProbe = JSON.parse(await readFile(path.join(workspace, 'isolation-probe.json'), 'utf8')); } catch { /* Normal candidates do not emit a probe. */ }
await writeFile(path.join(logs, 'reward.json'), JSON.stringify(reward));
await writeFile(path.join(logs, 'stage-result.json'), JSON.stringify({ stage, holdout, finalPublic, candidateSnapshot, isolationProbe, workspaceBytes, infrastructureError, verifierWorkspace: { policy: 'source-only-per-stage-and-holdout-case', sourceEntryPoint: 'ledger.mjs', candidateUid: 1000, candidateGid: 1000, candidateRuntime: { nodePermissionModel: true, filesystem: 'working-directory-only', network: 'denied', childProcess: 'denied' } } }, null, 2));
if (infrastructureError) process.exitCode = 2;
