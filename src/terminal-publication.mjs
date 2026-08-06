import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import { scoreTerminalRun, validateMiniLedgerChallenge, validateTerminalSchedule } from './terminal-challenge.mjs';

const HARNESS_NAMES = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'dotagents-mono': 'DotAgents',
  'factory-droid': 'Droid',
  'pi-coding-agent': 'Pi',
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeHostPaths(value) {
  if (typeof value === 'string') {
    return value.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?=\/|\b)/g, '$HOME');
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeHostPaths(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeHostPaths(child)]));
  }
  return value;
}

export function normalizeTerminalRunForPublication(run) {
  const { resultSha256: sourceResultSha256, ...sourceUnsigned } = run;
  invariant(
    typeof sourceResultSha256 === 'string' && sourceResultSha256 === canonicalJsonSha256(sourceUnsigned),
    `${run.artifactId ?? run.runKey ?? 'Terminal run'} source result hash mismatch`,
  );
  const normalized = normalizeHostPaths(sourceUnsigned);
  const publicUnsigned = {
    ...normalized,
    publicationProjection: {
      sourceResultSha256,
      hostPathNormalization: '/Users/<name> and /home/<name> prefixes are represented as $HOME',
    },
  };
  return { ...publicUnsigned, resultSha256: canonicalJsonSha256(publicUnsigned) };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function durationBetween(startedAt, endedAt) {
  const started = Date.parse(startedAt ?? '');
  const ended = Date.parse(endedAt ?? '');
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
}

function usageFor(run) {
  const usage = run.usage ?? {};
  const inputTokens = Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : null;
  const cachedInputTokens = Number.isSafeInteger(usage.cachedInputTokens) ? usage.cachedInputTokens : null;
  const outputTokens = Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : null;
  const reasoningTokens = Number.isSafeInteger(usage.reasoningTokens) ? usage.reasoningTokens : null;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens == null || outputTokens == null ? null : inputTokens + outputTokens,
    cacheReadRate: inputTokens && cachedInputTokens != null ? round((cachedInputTokens / inputTokens) * 100) : null,
  };
}

function sumNullable(values) {
  const observed = values.filter(Number.isFinite);
  return observed.length === values.length ? observed.reduce((sum, value) => sum + value, 0) : null;
}

function publicAttempt(attempt, index) {
  return {
    attempt: index + 1,
    attemptId: attempt.attemptId ?? null,
    status: attempt.status ?? null,
    validity: attempt.validity ?? null,
    error: attempt.error ?? null,
    startedAt: attempt.startedAt ?? null,
    endedAt: attempt.endedAt ?? null,
    durationMs: Number.isFinite(attempt.durationMs)
      ? attempt.durationMs
      : durationBetween(attempt.startedAt, attempt.endedAt),
    completedTurns: Array.isArray(attempt.turns) ? attempt.turns.length : null,
  };
}

async function loadAttempts(root, runKey) {
  const directory = path.join(root, 'attempts', runKey);
  if (!await exists(directory)) return [];
  const attempts = await Promise.all((await readdir(directory))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(directory, name))));
  return attempts
    .sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')))
    .map(publicAttempt);
}

function protocolFingerprint(challenge) {
  const { challengeId: _id, challengeSha256: _sha256, execution: _execution, ...taskContract } = challenge;
  return canonicalJson(taskContract);
}

export function terminalRunSlug({ harness, model, generation }) {
  const family = model.replace(/^gpt-5\.6-/, '');
  return `${harness}-${family}-g${generation}`;
}

export async function buildTerminalCampaignSiteData({ campaignRoot, sourceRoots = {}, allowIncomplete = false }) {
  const campaign = await readJson(path.join(campaignRoot, 'campaign-index.json'));
  invariant(campaign.schemaVersion === 'agentbattler.terminal-v5-campaign.v1', 'Unsupported terminal campaign schema');
  invariant(campaign.counts?.expected > 0, 'Terminal campaign has no expected runs');
  if (!allowIncomplete) {
    invariant(campaign.phase === 'complete', `Terminal campaign is ${campaign.phase}, not complete`);
    invariant(campaign.counts.accepted === campaign.counts.expected, 'Terminal campaign is not fully accepted');
  }

  const sourceDescriptors = new Map();
  for (const source of campaign.sources) {
    const root = path.resolve(sourceRoots[source.id] ?? source.resultRoot);
    const [challenge, schedule] = await Promise.all([
      readJson(path.join(root, 'challenge.json')),
      readJson(path.join(root, 'schedule.json')),
    ]);
    validateMiniLedgerChallenge(challenge);
    validateTerminalSchedule(schedule, challenge);
    sourceDescriptors.set(source.id, { ...source, root, challenge, schedule });
  }
  invariant(sourceDescriptors.size > 0, 'Terminal campaign has no source revisions');
  const latest = [...sourceDescriptors.values()].sort((left, right) => right.protocolRevision.localeCompare(left.protocolRevision))[0];
  for (const source of sourceDescriptors.values()) {
    invariant(protocolFingerprint(source.challenge) === protocolFingerprint(latest.challenge), `${source.id} changes the scoring or execution contract`);
  }

  const latestCombos = new Map(latest.schedule.coverage.map((entry) => [entry.combo.comboId, entry.combo]));
  const latestJobs = new Map(latest.schedule.jobs.map((job) => {
    const combo = latestCombos.get(job.comboId);
    invariant(combo, `Latest schedule is missing combo ${job.comboId}`);
    return [`${combo.harness.id}|${combo.model.id}|${job.generationIndex}|${job.repeat}|${job.seed}`, job];
  }));
  const traceManifests = new Map();
  for (const source of sourceDescriptors.values()) {
    const file = path.join(source.root, 'trace-manifest.json');
    traceManifests.set(source.id, await exists(file) ? await readJson(file) : null);
  }

  const runs = [];
  for (const entry of campaign.accepted) {
    const source = sourceDescriptors.get(entry.source.sourceId);
    invariant(source, `Unknown campaign source ${entry.source.sourceId}`);
    invariant(entry.source.protocolRevision === source.protocolRevision, `${entry.logicalKey} protocol revision mismatch`);
    const runFile = path.join(source.root, 'runs', `${entry.source.runKey}.json`);
    const run = await readJson(runFile);
    invariant(run.runKey === entry.source.runKey, `${entry.logicalKey} run key mismatch`);
    invariant(run.harness === entry.harness && run.model === entry.model && run.generationIndex === entry.generation, `${entry.logicalKey} run identity mismatch`);
    invariant(run.status === 'completed' && run.validity === 'valid', `${entry.logicalKey} is not a valid completed run`);
    const score = scoreTerminalRun(run, source.challenge);
    const traceEntry = traceManifests.get(source.id)?.traces?.find((trace) => trace.runKey === run.runKey) ?? null;
    const logicalJob = latestJobs.get(entry.logicalKey);
    const sourceAttempts = await loadAttempts(source.root, run.runKey);
    const recoveryAttempts = logicalJob && (source.id !== latest.id || logicalJob.runKey !== run.runKey)
      ? await loadAttempts(latest.root, logicalJob.runKey)
      : [];
    const attempts = [...sourceAttempts, ...recoveryAttempts]
      .sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')))
      .map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
    const trajectoryStageById = new Map(run.stages.map((stage) => [stage.id ?? stage.stageId, stage]));
    const finalStageById = new Map((run.finalPublic?.stages ?? []).map((stage) => [stage.id ?? stage.stageId, stage]));
    const stageById = score.primaryMetric === 'final-correctness' ? finalStageById : trajectoryStageById;
    const usage = usageFor(run);
    runs.push({
      logicalKey: entry.logicalKey,
      slug: terminalRunSlug(entry),
      runKey: run.runKey,
      artifactId: run.artifactId,
      comboId: `${run.harness}|${run.model}`,
      generationIndex: run.generationIndex,
      harness: run.harness,
      harnessDisplayName: HARNESS_NAMES[run.harness] ?? run.harness,
      harnessVersion: run.harnessVersion,
      model: run.model,
      modelFamilyId: run.modelFamilyId,
      reasoningEffort: run.reasoningEffort,
      durationMs: run.durationMs,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      turns: Array.isArray(run.turns) ? run.turns.length : null,
      toolCalls: Number.isSafeInteger(run.toolCalls) ? run.toolCalls : null,
      scorePct: score.scorePct,
      scorePoints: round(score.scorePoints),
      visiblePoints: score.visiblePoints,
      holdoutPoints: round(score.holdoutPoints),
      passedStages: score.passedStages,
      totalStages: score.totalStages,
      holdoutPassed: score.holdoutPassed,
      holdoutTotal: score.holdoutTotal,
      scoreMetric: score.primaryMetric,
      trajectory: score.trajectory,
      final: score.final,
      usage,
      stages: source.challenge.stages.map((definition) => {
        const stage = stageById.get(definition.id);
        return {
          id: definition.id,
          title: definition.title,
          points: definition.points,
          passed: stage?.passed === true,
          durationMs: Number.isFinite(stage?.durationMs) ? stage.durationMs : null,
          diagnostic: stage?.diagnostic ?? null,
        };
      }),
      source: {
        id: source.id,
        protocolRevision: source.protocolRevision,
        challengeId: source.challenge.challengeId,
        challengeSha256: source.challenge.challengeSha256,
        scheduleId: source.schedule.scheduleId,
        scheduleSha256: source.schedule.scheduleSha256,
        amendment: source.challenge.execution?.amendment ?? null,
      },
      attempts,
      evidence: {
        runPath: `snapshots/__SNAPSHOT_ID__/runs/${terminalRunSlug(entry)}.json`,
        tracePath: traceEntry ? `snapshots/__SNAPSHOT_ID__/traces/${terminalRunSlug(entry)}.jsonl.gz` : null,
        traceSha256: traceEntry?.publishedSha256 ?? null,
        traceBytes: traceEntry?.publishedBytes ?? null,
      },
    });
  }

  const groups = new Map();
  for (const run of runs) {
    const group = groups.get(run.comboId) ?? [];
    group.push(run);
    groups.set(run.comboId, group);
  }
  const combos = [...groups.entries()].map(([comboId, comboRuns]) => {
    const ordered = comboRuns.sort((left, right) => left.generationIndex - right.generationIndex);
    const scores = ordered.map((run) => run.scorePct);
    const inputTokens = sumNullable(ordered.map((run) => run.usage.inputTokens));
    const cachedInputTokens = sumNullable(ordered.map((run) => run.usage.cachedInputTokens));
    const outputTokens = sumNullable(ordered.map((run) => run.usage.outputTokens));
    const totalTokens = sumNullable(ordered.map((run) => run.usage.totalTokens));
    return {
      comboId,
      harness: ordered[0].harness,
      harnessDisplayName: ordered[0].harnessDisplayName,
      harnessVersion: ordered[0].harnessVersion,
      model: ordered[0].model,
      modelFamilyId: ordered[0].modelFamilyId,
      acceptedRuns: ordered.length,
      expectedRuns: latest.schedule.matrix.generationsPerCombo,
      averageScore: round(scores.reduce((sum, value) => sum + value, 0) / scores.length),
      medianScore: round(median(scores)),
      minimumScore: Math.min(...scores),
      maximumScore: Math.max(...scores),
      averageDurationMs: Math.round(ordered.reduce((sum, run) => sum + run.durationMs, 0) / ordered.length),
      totalDurationMs: ordered.reduce((sum, run) => sum + run.durationMs, 0),
      usage: {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        cacheReadRate: inputTokens && cachedInputTokens != null ? round((cachedInputTokens / inputTokens) * 100) : null,
      },
      sourceRevisions: [...new Set(ordered.map((run) => run.source.protocolRevision))].sort(),
      stagePassRates: latest.challenge.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        passed: ordered.filter((run) => run.stages.find((candidate) => candidate.id === stage.id)?.passed).length,
        total: ordered.length,
      })),
      runs: ordered,
    };
  }).sort((left, right) => right.averageScore - left.averageScore || left.comboId.localeCompare(right.comboId));

  const completedAt = runs.map((run) => run.endedAt).filter(Boolean).sort().at(-1) ?? campaign.generatedAt;
  const sourceRevisions = [...sourceDescriptors.values()]
    .map((source) => ({
      id: source.id,
      protocolRevision: source.protocolRevision,
      challengeId: source.challenge.challengeId,
      challengeSha256: source.challenge.challengeSha256,
      scheduleId: source.schedule.scheduleId,
      scheduleSha256: source.schedule.scheduleSha256,
      amendment: source.challenge.execution?.amendment ?? null,
      acceptedRuns: runs.filter((run) => run.source.id === source.id).length,
      challengePath: `snapshots/__SNAPSHOT_ID__/sources/${source.id}/challenge.json`,
      schedulePath: `snapshots/__SNAPSHOT_ID__/sources/${source.id}/schedule.json`,
    }))
    .sort((left, right) => left.protocolRevision.localeCompare(right.protocolRevision));
  const failedAttempts = runs.flatMap((run) => run.attempts).filter((attempt) => attempt.status === 'infrastructure-invalid').length;
  const totals = {
    inputTokens: sumNullable(runs.map((run) => run.usage.inputTokens)),
    cachedInputTokens: sumNullable(runs.map((run) => run.usage.cachedInputTokens)),
    outputTokens: sumNullable(runs.map((run) => run.usage.outputTokens)),
    reasoningTokens: sumNullable(runs.map((run) => run.usage.reasoningTokens)),
    totalTokens: sumNullable(runs.map((run) => run.usage.totalTokens)),
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    toolCalls: sumNullable(runs.map((run) => run.toolCalls)),
    failedAttempts,
  };
  totals.cacheReadRate = totals.inputTokens && totals.cachedInputTokens != null
    ? round((totals.cachedInputTokens / totals.inputTokens) * 100)
    : null;

  const status = campaign.phase === 'complete' && campaign.counts.accepted === campaign.counts.expected ? 'complete' : 'provisional';
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-campaign-site.v1',
    id: 'terminal-mini-ledger-v5-campaign',
    title: latest.challenge.title,
    updatedAt: completedAt,
    status,
    campaign: {
      phase: campaign.phase,
      generatedAt: campaign.generatedAt,
      acceptedRuns: campaign.counts.accepted,
      expectedRuns: campaign.counts.expected,
      outstandingRuns: campaign.counts.outstanding,
      infrastructureInvalid: campaign.counts.infrastructureInvalid,
      policy: campaign.policy,
      outstanding: campaign.outstanding.map((entry) => ({
        logicalKey: entry.logicalKey,
        harness: entry.harness,
        model: entry.model,
        generation: entry.generation,
        attemptCount: entry.attemptCount,
        status: entry.status,
        error: entry.latestSource?.error ?? null,
      })),
    },
    matrix: latest.schedule.matrix,
    protocol: latest.challenge.protocol,
    scoring: latest.challenge.scoring,
    stages: latest.challenge.stages,
    sourceRevisions,
    totals,
    combos,
    publication: null,
  };
  return { ...unsigned, siteDataSha256: canonicalJsonSha256(unsigned) };
}

export function bindTerminalPublication(lane, { snapshotId, snapshotSha256, datasetRepo, datasetRevision, datasetRoot, releaseUrl = null }) {
  const base = `https://huggingface.co/datasets/${datasetRepo}`;
  const replaceSnapshotId = (value) => value?.replace('__SNAPSHOT_ID__', snapshotId) ?? null;
  const bindRun = (run) => ({
    ...run,
    evidence: {
      ...run.evidence,
      runPath: replaceSnapshotId(run.evidence.runPath),
      tracePath: replaceSnapshotId(run.evidence.tracePath),
      runUrl: `${base}/blob/${datasetRevision}/${replaceSnapshotId(run.evidence.runPath)}`,
      runDownloadUrl: `${base}/resolve/${datasetRevision}/${replaceSnapshotId(run.evidence.runPath)}`,
      traceUrl: run.evidence.tracePath ? `${base}/resolve/${datasetRevision}/${replaceSnapshotId(run.evidence.tracePath)}` : null,
    },
  });
  const unsigned = {
    ...lane,
    sourceRevisions: lane.sourceRevisions.map((source) => ({
      ...source,
      challengePath: replaceSnapshotId(source.challengePath),
      schedulePath: replaceSnapshotId(source.schedulePath),
      challengeUrl: `${base}/blob/${datasetRevision}/${replaceSnapshotId(source.challengePath)}`,
      scheduleUrl: `${base}/blob/${datasetRevision}/${replaceSnapshotId(source.schedulePath)}`,
    })),
    combos: lane.combos.map((combo) => ({ ...combo, runs: combo.runs.map(bindRun) })),
    publication: {
      snapshotId,
      snapshotSha256,
      datasetRevision,
      datasetUrl: `${base}/tree/${datasetRevision}/${datasetRoot}`,
      releaseUrl,
    },
  };
  const { siteDataSha256: _oldHash, ...hashable } = unsigned;
  return { ...hashable, siteDataSha256: canonicalJsonSha256(hashable) };
}

export function materializeTerminalSnapshotPaths(lane, snapshotId) {
  const replace = (value) => value?.replace('__SNAPSHOT_ID__', snapshotId) ?? null;
  const { siteDataSha256: _oldHash, ...unsigned } = {
    ...lane,
    sourceRevisions: lane.sourceRevisions.map((source) => ({
      ...source,
      challengePath: replace(source.challengePath),
      schedulePath: replace(source.schedulePath),
    })),
    combos: lane.combos.map((combo) => ({
      ...combo,
      runs: combo.runs.map((run) => ({
        ...run,
        evidence: {
          ...run.evidence,
          runPath: replace(run.evidence.runPath),
          tracePath: replace(run.evidence.tracePath),
        },
      })),
    })),
  };
  return { ...unsigned, siteDataSha256: canonicalJsonSha256(unsigned) };
}

function sumPublishedTotals(lanes, field) {
  const values = lanes.map((lane) => lane.totals[field]);
  return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function mergeTerminalCampaignLanes(lanes) {
  invariant(Array.isArray(lanes) && lanes.length > 0, 'At least one terminal campaign lane is required');
  for (const lane of lanes) {
    const { siteDataSha256, ...unsigned } = lane;
    invariant(lane.schemaVersion === 'agentbattler.terminal-campaign-site.v1', 'Unsupported terminal campaign site-data schema');
    invariant(siteDataSha256 === canonicalJsonSha256(unsigned), `Terminal campaign site-data hash mismatch for ${lane.id}`);
  }
  if (lanes.length === 1) return lanes[0];

  const primary = lanes[0];
  const taskContract = canonicalJson({
    id: primary.id,
    title: primary.title,
    protocol: primary.protocol,
    scoring: primary.scoring,
    stages: primary.stages,
    models: primary.matrix.models,
    generationsPerCombo: primary.matrix.generationsPerCombo,
    repeats: primary.matrix.repeats,
    seeds: primary.matrix.seeds,
  });
  for (const lane of lanes.slice(1)) {
    invariant(canonicalJson({
      id: lane.id,
      title: lane.title,
      protocol: lane.protocol,
      scoring: lane.scoring,
      stages: lane.stages,
      models: lane.matrix.models,
      generationsPerCombo: lane.matrix.generationsPerCombo,
      repeats: lane.matrix.repeats,
      seeds: lane.matrix.seeds,
    }) === taskContract, `${lane.id} changes the active terminal leaderboard contract`);
  }

  const combos = lanes.flatMap((lane) => lane.combos);
  invariant(new Set(combos.map((combo) => combo.comboId)).size === combos.length, 'Terminal publication lanes contain duplicate combos');
  const runs = combos.flatMap((combo) => combo.runs);
  invariant(new Set(runs.map((run) => run.logicalKey)).size === runs.length, 'Terminal publication lanes contain duplicate logical runs');
  const sourceRevisions = lanes.flatMap((lane) => lane.sourceRevisions);
  invariant(new Set(sourceRevisions.map((source) => source.id)).size === sourceRevisions.length, 'Terminal publication lanes contain duplicate source revision IDs');
  const publications = lanes.flatMap((lane) => lane.publications ?? (lane.publication ? [lane.publication] : []));
  const inputTokens = sumPublishedTotals(lanes, 'inputTokens');
  const cachedInputTokens = sumPublishedTotals(lanes, 'cachedInputTokens');
  const mergedUnsigned = {
    ...primary,
    updatedAt: lanes.map((lane) => lane.updatedAt).sort().at(-1),
    status: lanes.every((lane) => lane.status === 'complete') ? 'complete' : 'provisional',
    campaign: {
      ...primary.campaign,
      phase: lanes.every((lane) => lane.campaign.phase === 'complete') ? 'complete' : 'running',
      generatedAt: lanes.map((lane) => lane.campaign.generatedAt).sort().at(-1),
      acceptedRuns: lanes.reduce((sum, lane) => sum + lane.campaign.acceptedRuns, 0),
      expectedRuns: lanes.reduce((sum, lane) => sum + lane.campaign.expectedRuns, 0),
      outstandingRuns: lanes.reduce((sum, lane) => sum + lane.campaign.outstandingRuns, 0),
      infrastructureInvalid: lanes.reduce((sum, lane) => sum + lane.campaign.infrastructureInvalid, 0),
      outstanding: lanes.flatMap((lane) => lane.campaign.outstanding),
    },
    matrix: {
      ...primary.matrix,
      harnesses: uniqueSorted(lanes.flatMap((lane) => lane.matrix.harnesses)),
      models: uniqueSorted(lanes.flatMap((lane) => lane.matrix.models)),
      expectedRuns: lanes.reduce((sum, lane) => sum + lane.matrix.expectedRuns, 0),
    },
    sourceRevisions: sourceRevisions.sort((left, right) => left.protocolRevision.localeCompare(right.protocolRevision)),
    totals: {
      inputTokens,
      cachedInputTokens,
      outputTokens: sumPublishedTotals(lanes, 'outputTokens'),
      reasoningTokens: sumPublishedTotals(lanes, 'reasoningTokens'),
      totalTokens: sumPublishedTotals(lanes, 'totalTokens'),
      durationMs: lanes.reduce((sum, lane) => sum + lane.totals.durationMs, 0),
      toolCalls: sumPublishedTotals(lanes, 'toolCalls'),
      failedAttempts: lanes.reduce((sum, lane) => sum + lane.totals.failedAttempts, 0),
      cacheReadRate: inputTokens && cachedInputTokens != null ? round((cachedInputTokens / inputTokens) * 100) : null,
    },
    combos: combos.sort((left, right) => right.averageScore - left.averageScore || left.comboId.localeCompare(right.comboId)),
    publication: primary.publication,
    publications,
  };
  const { siteDataSha256: _oldHash, ...hashable } = mergedUnsigned;
  return { ...hashable, siteDataSha256: canonicalJsonSha256(hashable) };
}
