#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, canonicalJsonSha256 } from '../src/provenance.mjs';
import {
  configureTerminalV5RuntimeEnvironment,
  reconcileTerminalV5Campaign,
  selectTerminalV5CampaignBatch,
  terminalV5CampaignPolicy,
} from '../src/terminal-v5-campaign.mjs';
import { runTerminalSchedule } from '../src/terminal-runner.mjs';
import { scoreTerminalRun, validateMiniLedgerChallenge, validateTerminalSchedule } from '../src/terminal-challenge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_RESULT_ROOT = path.join(ROOT, 'results/terminal-mini-ledger-v5-r4-reliability');
const R2_RESULT_ROOT = process.env.AGENTBATTLER_V5_R2_RESULT_ROOT
  ?? path.join(homedir(), 'Development/AgentBattlerv2-v5-r2/results/terminal-mini-ledger-v5-r2');
const R3_RESULT_ROOT = process.env.AGENTBATTLER_V5_R3_RESULT_ROOT
  ?? path.join(homedir(), 'Development/AgentBattlerv2-v5-r3-dotagents/results/terminal-mini-ledger-v5-r3-dotagents-v1-1-9');

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function loadSource({ id, protocolRevision, resultRoot, harnesses, required = false }) {
  if (!await exists(path.join(resultRoot, 'schedule.json'))) {
    if (required) throw new Error(`Required V5 campaign source is missing: ${resultRoot}`);
    return null;
  }
  const [challenge, schedule] = await Promise.all([
    readFile(path.join(resultRoot, 'challenge.json'), 'utf8').then(JSON.parse),
    readFile(path.join(resultRoot, 'schedule.json'), 'utf8').then(JSON.parse),
  ]);
  validateMiniLedgerChallenge(challenge);
  validateTerminalSchedule(schedule, challenge);
  const combos = new Map(schedule.coverage.map((entry) => [entry.combo.comboId, entry.combo]));
  const records = [];
  for (const job of schedule.jobs) {
    const combo = combos.get(job.comboId);
    if (harnesses && !harnesses.includes(combo.harness.id)) continue;
    const file = path.join(resultRoot, 'runs', `${job.runKey}.json`);
    if (!await exists(file)) continue;
    const run = JSON.parse(await readFile(file, 'utf8'));
    for (const field of ['runKey', 'challengeId', 'challengeSha256', 'comboId', 'artifactId', 'generationIndex', 'repeat', 'seed']) {
      if (run[field] !== job[field]) throw new Error(`${id} run identity mismatch for ${job.runKey}: ${field}`);
    }
    const { resultSha256, ...unsigned } = run;
    if (resultSha256 !== canonicalJsonSha256(unsigned)) throw new Error(`${id} run hash mismatch for ${job.runKey}`);
    if (run.status === 'completed') scoreTerminalRun(run, challenge);
    else if (run.status !== 'infrastructure-invalid') throw new Error(`${id} unsupported run status ${run.status}`);
    const attemptsRoot = path.join(resultRoot, 'attempts', job.runKey);
    let attemptCount = 0;
    if (await exists(attemptsRoot)) {
      for (const name of await readdir(attemptsRoot)) {
        if (!name.endsWith('.json')) continue;
        const attempt = JSON.parse(await readFile(path.join(attemptsRoot, name), 'utf8'));
        for (const field of ['runKey', 'challengeId', 'challengeSha256', 'comboId', 'artifactId', 'generationIndex', 'repeat', 'seed']) {
          if (attempt[field] !== job[field]) throw new Error(`${id} attempt identity mismatch for ${job.runKey}/${name}: ${field}`);
        }
        const { resultSha256: attemptHash, ...attemptUnsigned } = attempt;
        if (attemptHash !== canonicalJsonSha256(attemptUnsigned)) throw new Error(`${id} attempt hash mismatch for ${job.runKey}/${name}`);
        attemptCount += 1;
      }
    }
    records.push({ job, combo, run, attemptCount, file });
  }
  return { id, protocolRevision, resultRoot, harnesses, challenge, schedule, records };
}

async function loadCampaign({ requireLegacy = false } = {}) {
  const target = await loadSource({ id: 'R4', protocolRevision: 'r4', resultRoot: TARGET_RESULT_ROOT, required: true });
  const [r3, r2] = await Promise.all([
    loadSource({ id: 'R3', protocolRevision: 'r3', resultRoot: R3_RESULT_ROOT, harnesses: ['dotagents-mono'], required: requireLegacy }),
    loadSource({ id: 'R2', protocolRevision: 'r2', resultRoot: R2_RESULT_ROOT, harnesses: ['claude-code', 'codex-cli', 'pi-coding-agent'], required: requireLegacy }),
  ]);
  const sources = [target, r3, r2].filter(Boolean);
  return { target, sources, campaign: reconcileTerminalV5Campaign({ targetSchedule: target.schedule, sources }) };
}

function campaignDocument(campaign, sources, { maxAttempts = 3, recoveryReason = null } = {}) {
  return {
    schemaVersion: campaign.schemaVersion,
    generatedAt: new Date().toISOString(),
    policy: terminalV5CampaignPolicy({ maxAttempts, recoveryReason }),
    sources: sources.map((source) => ({ id: source.id, protocolRevision: source.protocolRevision, resultRoot: source.resultRoot })),
    phase: campaign.phase,
    counts: campaign.counts,
    next: campaign.next ? {
      logicalKey: campaign.next.logicalKey,
      harness: campaign.next.combo.harness.id,
      model: campaign.next.combo.model.id,
      generation: campaign.next.job.generationIndex,
      attemptCount: campaign.next.attemptCount,
    } : null,
    accepted: campaign.entries.filter((entry) => entry.acceptedSource).map((entry) => ({
      logicalKey: entry.logicalKey,
      harness: entry.combo.harness.id,
      model: entry.combo.model.id,
      generation: entry.job.generationIndex,
      source: entry.acceptedSource,
    })),
    outstanding: campaign.entries.filter((entry) => entry.status !== 'accepted').map((entry) => ({
      logicalKey: entry.logicalKey,
      harness: entry.combo.harness.id,
      model: entry.combo.model.id,
      generation: entry.job.generationIndex,
      status: entry.status,
      attemptCount: entry.attemptCount,
      latestSource: entry.latestSource,
    })),
  };
}

async function writeIndex(campaign, sources, policy = {}) {
  const file = path.join(TARGET_RESULT_ROOT, 'campaign-index.json');
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${canonicalJson(campaignDocument(campaign, sources, policy), { space: 2 })}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

async function withCampaignLock(callback) {
  const lock = path.join(TARGET_RESULT_ROOT, 'campaign.lock');
  await mkdir(TARGET_RESULT_ROOT, { recursive: true });
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch { /* malformed locks are stale */ }
    let alive = false;
    if (Number.isSafeInteger(owner?.pid)) {
      try { process.kill(owner.pid, 0); alive = true; } catch { /* stale */ }
    }
    if (alive) throw new Error(`V5 campaign already active under PID ${owner.pid}`);
    await rename(lock, `${lock}.stale-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    handle = await open(lock, 'wx', 0o600);
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  await handle.close();
  try { return await callback(); }
  finally { await rm(lock, { force: true }); }
}

async function runNext() {
  return withCampaignLock(async () => {
    const { target, campaign } = await loadCampaign({ requireLegacy: true });
    if (!campaign.next) return { message: 'V5 campaign is complete', campaign };
    const next = campaign.next;
    // Adapters resolve their prompt and verifier modules at import time. Pin
    // the R4 runtime first so direct coordinator invocations cannot silently
    // fall back to the older default stage registry.
    configureTerminalV5RuntimeEnvironment();
    const adapter = await import('./terminal-adapter-all.mjs');
    const summary = await runTerminalSchedule({
      challenge: target.challenge,
      schedule: target.schedule,
      resultRoot: TARGET_RESULT_ROOT,
      challengeRoot: path.join(ROOT, 'benchmark/challenges/mini-ledger-v4'),
      runTerminalJob: adapter.runTerminalJob,
      onlyHarnesses: [next.combo.harness.id],
      onlyModels: [next.combo.model.id],
      onlyGenerationIndices: [next.job.generationIndex],
      concurrency: 1,
      retryInvalid: true,
      onProgress: ({ job, status, error }) => console.log(`[${status}] ${job.artifactId}${error ? `: ${error}` : ''}`),
    });
    const refreshed = await loadCampaign({ requireLegacy: true });
    const index = await writeIndex(refreshed.campaign, refreshed.sources);
    return { selected: next.logicalKey, summary, index, campaign: refreshed.campaign };
  });
}

async function runCampaignEntry(target, entry, adapter) {
  return runTerminalSchedule({
    challenge: target.challenge,
    schedule: target.schedule,
    resultRoot: TARGET_RESULT_ROOT,
    challengeRoot: path.join(ROOT, 'benchmark/challenges/mini-ledger-v4'),
    runTerminalJob: adapter.runTerminalJob,
    onlyHarnesses: [entry.combo.harness.id],
    onlyModels: [entry.combo.model.id],
    onlyGenerationIndices: [entry.job.generationIndex],
    concurrency: 1,
    retryInvalid: true,
    onProgress: ({ job, status, error }) => console.log(`[${entry.combo.harness.id}] [${status}] ${job.artifactId}${error ? `: ${error}` : ''}`),
  });
}

function finalizeCampaign() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/finalize-terminal-v5-campaign.mjs')], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(path.join(TARGET_RESULT_ROOT, 'campaign-artifacts.json'));
      else reject(new Error(`V5 campaign finalization exited ${code ?? signal}`));
    });
  });
}

async function superviseCampaign({ lanes, maxAttempts, recoveryReason = null }) {
  return withCampaignLock(async () => {
    const policy = { maxAttempts, recoveryReason };
    terminalV5CampaignPolicy(policy);
    configureTerminalV5RuntimeEnvironment();
    const adapter = await import('./terminal-adapter-all.mjs');
    while (true) {
      const loaded = await loadCampaign({ requireLegacy: true });
      const index = await writeIndex(loaded.campaign, loaded.sources, policy);
      const batch = selectTerminalV5CampaignBatch(loaded.campaign, { lanes, maxAttempts });
      if (!batch.length) {
        const blocked = loaded.campaign.counts.outstanding > 0;
        const artifacts = blocked ? null : await finalizeCampaign();
        return {
          message: blocked
            ? `V5 campaign stopped with unresolved jobs at the ${maxAttempts}-attempt ceiling`
            : 'V5 campaign is complete',
          campaign: loaded.campaign,
          index,
          blocked,
          artifacts,
        };
      }
      console.log(`\n=== V5 campaign ${loaded.campaign.phase}: ${batch.map((entry) => entry.logicalKey).join(' + ')} ===`);
      await Promise.all(batch.map((entry) => runCampaignEntry(loaded.target, entry, adapter)));
    }
  });
}

function integerArg(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = Number.parseInt(index >= 0 ? process.argv[index + 1] : String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const shouldRun = process.argv.includes('--run-next');
const shouldSupervise = process.argv.includes('--supervise');
if (shouldRun && shouldSupervise) throw new Error('Choose either --run-next or --supervise');
const result = shouldSupervise
  ? await superviseCampaign({
      lanes: integerArg('--lanes', 2),
      maxAttempts: integerArg('--max-attempts', 3),
      recoveryReason: process.env.AGENTBATTLER_V5_RECOVERY_REASON ?? null,
    })
  : shouldRun ? await runNext() : await loadCampaign();
if (!shouldRun && process.argv.includes('--write-index')) result.index = await writeIndex(result.campaign, result.sources);
const campaign = result.campaign;
console.log(JSON.stringify({
  phase: campaign.phase,
  counts: campaign.counts,
  next: campaign.next ? {
    harness: campaign.next.combo.harness.id,
    model: campaign.next.combo.model.id,
    generation: campaign.next.job.generationIndex,
    attemptCount: campaign.next.attemptCount,
  } : null,
  ...(result.summary ? { runSummary: result.summary } : {}),
  ...(result.index ? { index: result.index } : {}),
  ...(result.message ? { message: result.message } : {}),
  ...(result.blocked !== undefined ? { blocked: result.blocked } : {}),
  ...(result.artifacts ? { artifacts: result.artifacts } : {}),
}, null, 2));
