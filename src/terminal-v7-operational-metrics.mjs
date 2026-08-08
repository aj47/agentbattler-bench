const TOKEN_FIELDS = Object.freeze(['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function countValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (Array.isArray(value)) return value.length;
  if (Number.isSafeInteger(value?.count) && value.count >= 0) return value.count;
  if (Number.isSafeInteger(value?.total) && value.total >= 0) return value.total;
  return null;
}

export function terminalV7ObservedAttemptCount(run) {
  for (const value of [run?.observedAttemptCount, run?.observedAttempts, run?.blockedAttemptCount, run?.blockedAttempts]) {
    const count = countValue(value);
    if (count !== null) return count;
  }
  return (run?.turns ?? []).reduce((total, turn) => {
    for (const value of [
      turn.observedAttemptCount,
      turn.observedAttempts,
      turn.blockedAttemptCount,
      turn.blockedAttempts,
      turn.isolation?.observedAttemptCount,
      turn.isolation?.observedAttempts,
      turn.isolation?.blockedAttemptCount,
      turn.isolation?.blockedAttempts,
      turn.isolation?.boundaryAttempts,
    ]) {
      const count = countValue(value);
      if (count !== null) return total + count;
    }
    return total;
  }, 0);
}

function reportedCostUsd(run) {
  for (const value of [run?.costUsd, run?.cost?.usd, run?.usage?.costUsd, run?.adapter?.costUsd]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function terminalV7RunOperationalMetrics(run) {
  invariant(run && typeof run === 'object' && !Array.isArray(run), 'V7 run metrics require a run record');
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonnegative(run.usage?.[field])]));
  tokens.totalTokens = tokens.inputTokens + tokens.outputTokens;
  const costUsd = reportedCostUsd(run);
  return {
    wallTimeMs: nonnegative(run.durationMs),
    tokens,
    timeouts: (run.turns ?? []).filter(({ timedOut }) => timedOut === true).length,
    blockedAttempts: terminalV7ObservedAttemptCount(run),
    cost: costUsd === null
      ? { status: 'unavailable-no-provider-metering', reportedUsd: null }
      : { status: 'provider-reported', reportedUsd: costUsd },
  };
}

export function aggregateTerminalV7OperationalMetrics(runs, {
  expectedRuns = runs?.length ?? 0,
  infrastructureInvalid = 0,
  missing = Math.max(0, expectedRuns - (runs?.length ?? 0) - infrastructureInvalid),
} = {}) {
  invariant(Array.isArray(runs), 'V7 operational aggregate requires run records');
  invariant(Number.isSafeInteger(expectedRuns) && expectedRuns >= runs.length, 'V7 expected-run count is invalid');
  invariant(Number.isSafeInteger(infrastructureInvalid) && infrastructureInvalid >= 0
    && Number.isSafeInteger(missing) && missing >= 0, 'V7 validity counts are invalid');
  const rows = runs.map(terminalV7RunOperationalMetrics);
  const tokens = Object.fromEntries([...TOKEN_FIELDS, 'totalTokens'].map((field) => [field, rows.reduce((sum, row) => sum + row.tokens[field], 0)]));
  const reported = rows.filter(({ cost }) => cost.status === 'provider-reported');
  return {
    runs: runs.length,
    wallTimeMs: rows.reduce((sum, row) => sum + row.wallTimeMs, 0),
    tokens,
    timeouts: rows.reduce((sum, row) => sum + row.timeouts, 0),
    blockedAttempts: rows.reduce((sum, row) => sum + row.blockedAttempts, 0),
    cost: {
      status: reported.length === rows.length && rows.length > 0 ? 'complete-provider-reported' : 'partial-or-unavailable-provider-metering',
      reportedUsd: reported.reduce((sum, { cost }) => sum + cost.reportedUsd, 0),
      reportedRuns: reported.length,
      totalRuns: rows.length,
    },
    infrastructureValidity: {
      expectedRuns,
      validRuns: runs.length,
      invalidRuns: infrastructureInvalid,
      missingRuns: missing,
    },
  };
}
