import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/provenance.mjs';
import { createExhaustiveTerminalSchedule, createMiniLedgerChallenge } from '../src/terminal-challenge.mjs';
import { buildTerminalCampaignSiteData } from '../src/terminal-publication.mjs';

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${canonicalJson(value, { space: 2 })}\n`);
}

function challenge(revision) {
  return createMiniLedgerChallenge({
    challengeId: 'terminal-mini-ledger-v5',
    title: 'Mini Ledger v5',
    promptSha256: '1'.repeat(64),
    publicVerifierSha256: '2'.repeat(64),
    holdoutVerifierSha256: '3'.repeat(64),
    maxWallTimeMs: 1_800_000,
    execution: { amendment: `revision-${revision}` },
  });
}

function schedule(challengeValue) {
  return createExhaustiveTerminalSchedule({
    challenge: challengeValue,
    agents: [{
      id: 'terminal-codex-cli-luna-01',
      generationIndex: 1,
      provenance: {
        harness: 'codex-cli',
        harnessVersion: '1.0.0',
        modelRequested: 'gpt-5.6-luna',
        modelFamilyId: 'luna',
        reasoningEffort: 'high',
        generationSettings: {},
      },
    }],
    expectedHarnesses: ['codex-cli'],
    expectedModels: ['gpt-5.6-luna'],
    generationsPerCombo: 1,
  });
}

test('normalizes a complete multi-revision terminal campaign without relabeling source evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentbattler-terminal-publication-'));
  const roots = Object.fromEntries(['R2', 'R3', 'R4'].map((id) => [id, path.join(root, id)]));
  const descriptors = [];
  for (const id of ['R2', 'R3', 'R4']) {
    const protocolRevision = id.toLowerCase();
    const challengeValue = challenge(protocolRevision);
    const scheduleValue = schedule(challengeValue);
    await writeJson(path.join(roots[id], 'challenge.json'), challengeValue);
    await writeJson(path.join(roots[id], 'schedule.json'), scheduleValue);
    descriptors.push({ id, protocolRevision, resultRoot: roots[id], challengeValue, scheduleValue });
  }
  const acceptedSource = descriptors[0];
  const job = acceptedSource.scheduleValue.jobs[0];
  const run = {
    schemaVersion: 'agentbattler.terminal-run.v1',
    challengeId: acceptedSource.challengeValue.challengeId,
    challengeSha256: acceptedSource.challengeValue.challengeSha256,
    runKey: job.runKey,
    comboId: job.comboId,
    artifactId: job.artifactId,
    generationIndex: 1,
    harness: 'codex-cli',
    harnessVersion: '1.0.0',
    model: 'gpt-5.6-luna',
    modelFamilyId: 'luna',
    reasoningEffort: 'high',
    status: 'completed',
    validity: 'valid',
    startedAt: '2026-07-31T00:00:00.000Z',
    endedAt: '2026-07-31T00:01:00.000Z',
    durationMs: 60_000,
    turns: [{ index: 1 }],
    toolCalls: 4,
    usage: { inputTokens: 100, cachedInputTokens: 75, outputTokens: 20, reasoningTokens: 5 },
    stages: acceptedSource.challengeValue.stages.map((stage) => ({ id: stage.id, passed: true, regressions: 0, durationMs: 1, diagnostic: null })),
    holdout: { passed: acceptedSource.challengeValue.verifiers.holdout.cases, total: acceptedSource.challengeValue.verifiers.holdout.cases },
  };
  await writeJson(path.join(roots.R2, 'runs', `${job.runKey}.json`), run);
  const latestJob = descriptors[2].scheduleValue.jobs[0];
  await writeJson(path.join(roots.R4, 'attempts', latestJob.runKey, 'attempt-1.json'), {
    attemptId: 'attempt-1',
    status: 'infrastructure-invalid',
    validity: 'infrastructure-invalid',
    error: 'upstream disconnected',
    startedAt: '2026-07-30T23:58:00.000Z',
    endedAt: '2026-07-30T23:59:00.000Z',
  });
  const logicalKey = 'codex-cli|gpt-5.6-luna|1|1|1';
  await writeJson(path.join(roots.R4, 'campaign-index.json'), {
    schemaVersion: 'agentbattler.terminal-v5-campaign.v1',
    phase: 'complete',
    generatedAt: '2026-07-31T00:02:00.000Z',
    counts: { accepted: 1, expected: 1, infrastructureInvalid: 0, outstanding: 0, unstarted: 0 },
    policy: { acceptedEvidence: 'preserved-by-reference', concurrency: { lanes: ['legacy'], maxConcurrentRuns: 1, perRun: 1 }, maxAttemptsPerLogicalJob: 3, ordering: 'generation-major-breadth-first', retries: 'bounded-fewest-attempts-first' },
    sources: descriptors.map(({ id, protocolRevision, resultRoot }) => ({ id, protocolRevision, resultRoot })),
    accepted: [{ logicalKey, harness: 'codex-cli', model: 'gpt-5.6-luna', generation: 1, source: { sourceId: 'R2', protocolRevision: 'r2', runKey: job.runKey, file: path.join(roots.R2, 'runs', `${job.runKey}.json`) } }],
    outstanding: [],
  });

  const lane = await buildTerminalCampaignSiteData({ campaignRoot: roots.R4, sourceRoots: roots });
  assert.equal(lane.status, 'complete');
  assert.equal(lane.combos.length, 1);
  assert.equal(lane.combos[0].averageScore, 100);
  assert.equal(lane.combos[0].usage.cacheReadRate, 75);
  assert.equal(lane.combos[0].runs[0].source.id, 'R2');
  assert.equal(lane.combos[0].runs[0].source.protocolRevision, 'r2');
  assert.equal(lane.combos[0].runs[0].attempts[0].error, 'upstream disconnected');
  assert.equal(lane.totals.failedAttempts, 1);
});
