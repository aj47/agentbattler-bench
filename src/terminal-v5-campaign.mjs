const HARNESS_ORDER = new Map(['dotagents-mono', 'pi-coding-agent', 'claude-code', 'codex-cli'].map((value, index) => [value, index]));
const MODEL_ORDER = new Map(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'].map((value, index) => [value, index]));

export function configureTerminalV5RuntimeEnvironment(environment = process.env) {
  environment.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION = 'v5';
  environment.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION = 'r4';
  environment.AGENTBATTLER_TERMINAL_RESULT_TAG = 'v5-r4-reliability';
  return environment;
}

export function logicalTerminalJobKey(job, combo) {
  return [
    combo.harness.id,
    combo.model.id,
    job.generationIndex,
    job.repeat ?? 1,
    job.seed ?? 1,
  ].join('|');
}

export function terminalV5CampaignLane(entry) {
  return entry.combo.harness.id === 'dotagents-mono' ? 'dotagents' : 'legacy';
}

export function terminalV5CampaignPolicy({ maxAttempts = 3, recoveryReason = null } = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('V5 campaign maxAttempts must be positive');
  if (maxAttempts > 3 && (typeof recoveryReason !== 'string' || !recoveryReason.trim())) {
    throw new Error('A documented recovery reason is required above the published three-attempt ceiling');
  }
  return {
    ordering: 'generation-major-breadth-first',
    acceptedEvidence: 'preserved-by-reference',
    retries: 'bounded-fewest-attempts-first',
    maxAttemptsPerLogicalJob: maxAttempts,
    ...(maxAttempts > 3 ? {
      retryCeilingException: {
        publishedMaxAttempts: 3,
        authorizedMaxAttempts: maxAttempts,
        reason: recoveryReason.trim(),
      },
    } : {}),
    concurrency: {
      perRun: 1,
      maxConcurrentRuns: 2,
      lanes: ['dotagents', 'legacy'],
    },
  };
}

export function selectTerminalV5CampaignBatch(campaign, { lanes = 1, maxAttempts = 3 } = {}) {
  if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > 2) throw new Error('V5 campaign lanes must be 1 or 2');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('V5 campaign maxAttempts must be positive');
  const firstCoverage = campaign.entries.filter((entry) => entry.status === 'unstarted');
  let candidates;
  if (firstCoverage.length) {
    const generation = Math.min(...firstCoverage.map((entry) => entry.job.generationIndex));
    candidates = firstCoverage.filter((entry) => entry.job.generationIndex === generation);
  } else {
    candidates = campaign.entries
      .filter((entry) => entry.status === 'infrastructure-invalid' && entry.attemptCount < maxAttempts)
      .sort((left, right) => left.attemptCount - right.attemptCount || left.orderIndex - right.orderIndex);
  }
  if (lanes === 1) return candidates.slice(0, 1);
  const selected = [];
  const occupied = new Set();
  for (const entry of candidates) {
    const lane = terminalV5CampaignLane(entry);
    if (occupied.has(lane)) continue;
    selected.push(entry);
    occupied.add(lane);
    if (selected.length === lanes) break;
  }
  return selected;
}

function sourceMap(source) {
  const map = new Map();
  for (const record of source.records ?? []) {
    const key = logicalTerminalJobKey(record.job, record.combo);
    const records = map.get(key) ?? [];
    records.push({ ...record, sourceId: source.id, protocolRevision: source.protocolRevision });
    map.set(key, records);
  }
  return map;
}

export function reconcileTerminalV5Campaign({ targetSchedule, sources }) {
  const combos = new Map(targetSchedule.coverage.map((entry) => [entry.combo.comboId, entry.combo]));
  const ordered = [...targetSchedule.jobs].sort((left, right) => {
    const leftCombo = combos.get(left.comboId);
    const rightCombo = combos.get(right.comboId);
    return left.generationIndex - right.generationIndex
      || (left.repeat ?? 1) - (right.repeat ?? 1)
      || (HARNESS_ORDER.get(leftCombo.harness.id) ?? Number.MAX_SAFE_INTEGER) - (HARNESS_ORDER.get(rightCombo.harness.id) ?? Number.MAX_SAFE_INTEGER)
      || (MODEL_ORDER.get(leftCombo.model.id) ?? Number.MAX_SAFE_INTEGER) - (MODEL_ORDER.get(rightCombo.model.id) ?? Number.MAX_SAFE_INTEGER)
      || (left.seed ?? 1) - (right.seed ?? 1)
      || left.artifactId.localeCompare(right.artifactId);
  });
  const sourceMaps = sources.map((source) => ({ source, map: sourceMap(source) }));
  const entries = ordered.map((job, orderIndex) => {
    const combo = combos.get(job.comboId);
    const logicalKey = logicalTerminalJobKey(job, combo);
    const records = sourceMaps.flatMap(({ source, map }) => (
      !source.harnesses || source.harnesses.includes(combo.harness.id) ? map.get(logicalKey) ?? [] : []
    ));
    const accepted = records.find((record) => record.run.status === 'completed') ?? null;
    const latest = records[0] ?? null;
    const attemptCount = records.reduce((total, record) => total + Math.max(1, record.attemptCount ?? 1), 0);
    return {
      orderIndex,
      logicalKey,
      job,
      combo,
      status: accepted ? 'accepted' : records.length ? 'infrastructure-invalid' : 'unstarted',
      attemptCount,
      acceptedSource: accepted ? {
        sourceId: accepted.sourceId,
        protocolRevision: accepted.protocolRevision,
        runKey: accepted.run.runKey,
        file: accepted.file,
      } : null,
      latestSource: latest ? {
        sourceId: latest.sourceId,
        protocolRevision: latest.protocolRevision,
        runKey: latest.run.runKey,
        file: latest.file,
        status: latest.run.status,
        error: latest.run.error ?? null,
      } : null,
    };
  });
  const firstCoverage = entries.filter((entry) => entry.status === 'unstarted');
  const retryCandidates = entries.filter((entry) => entry.status === 'infrastructure-invalid')
    .sort((left, right) => left.attemptCount - right.attemptCount || left.orderIndex - right.orderIndex);
  const next = firstCoverage[0] ?? retryCandidates[0] ?? null;
  return {
    schemaVersion: 'agentbattler.terminal-v5-campaign.v1',
    phase: firstCoverage.length ? 'first-coverage' : retryCandidates.length ? 'bounded-retries' : 'complete',
    counts: {
      expected: entries.length,
      accepted: entries.filter((entry) => entry.status === 'accepted').length,
      infrastructureInvalid: retryCandidates.length,
      unstarted: firstCoverage.length,
      outstanding: entries.filter((entry) => entry.status !== 'accepted').length,
    },
    next,
    entries,
  };
}
