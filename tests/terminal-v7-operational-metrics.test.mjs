import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateTerminalV7OperationalMetrics,
  terminalV7RunOperationalMetrics,
} from '../src/terminal-v7-operational-metrics.mjs';

test('V7 operational metrics report tokens, wall time, timeouts, blocked attempts, and honest cost coverage', () => {
  const first = {
    durationMs: 100,
    usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 7, reasoningTokens: 3, costUsd: 0.25 },
    turns: [
      { timedOut: false, isolation: { observedAttemptCount: 2, observedAttempts: [{}, {}] } },
      { timedOut: true, isolation: { observedAttemptCount: 0, observedAttempts: [] } },
    ],
  };
  assert.deepEqual(terminalV7RunOperationalMetrics(first), {
    wallTimeMs: 100,
    tokens: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 7, reasoningTokens: 3, totalTokens: 27 },
    timeouts: 1,
    blockedAttempts: 2,
    cost: { status: 'provider-reported', reportedUsd: 0.25 },
  });
  const aggregate = aggregateTerminalV7OperationalMetrics([first, { durationMs: 50, usage: {}, turns: [] }], { expectedRuns: 3, infrastructureInvalid: 1, missing: 0 });
  assert.equal(aggregate.wallTimeMs, 150);
  assert.equal(aggregate.tokens.totalTokens, 27);
  assert.equal(aggregate.cost.status, 'partial-or-unavailable-provider-metering');
  assert.deepEqual(aggregate.infrastructureValidity, { expectedRuns: 3, validRuns: 2, invalidRuns: 1, missingRuns: 0 });
});
