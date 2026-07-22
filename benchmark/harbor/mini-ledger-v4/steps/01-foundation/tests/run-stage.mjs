#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPublicStage } from './mini-ledger-v4/public-verifier.mjs';
import { verifyHoldout } from './mini-ledger-v4/holdout-verifier.mjs';

const workspace = '/app';
const logs = '/logs/verifier';
const stageId = process.env.AGENTBATTLER_STAGE_ID;
const stagePoints = Number(process.env.AGENTBATTLER_STAGE_POINTS);
const finalStep = process.env.AGENTBATTLER_FINAL_STEP === '1';
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

let stage = { id: stageId, passed: false, regressions: 1, exitCode: 1, durationMs: 0, diagnostic: 'verifier did not run' };
let holdout = null;
let workspaceBytes = null;
try {
  workspaceBytes = await directoryBytes(workspace);
  stage = workspaceBytes > 50 * 1024 * 1024
    ? { ...stage, diagnostic: `workspace exceeds 50 MiB limit: ${workspaceBytes} bytes` }
    : await verifyPublicStage({ workspace, ledgerPath: path.join(workspace, 'ledger.mjs'), stageId });
} catch (error) {
  stage = { ...stage, diagnostic: String(error?.stack ?? error).slice(0, 2000) };
}
if (finalStep) {
  try { holdout = await verifyHoldout({ workspace }); }
  catch (error) { holdout = { passed: 0, total: 11, cases: [{ name: 'holdout-verifier-error', passed: false, diagnostic: String(error?.message ?? error).slice(0, 500) }] }; }
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
await writeFile(path.join(logs, 'stage-result.json'), JSON.stringify({ stage, holdout, isolationProbe, workspaceBytes }, null, 2));
