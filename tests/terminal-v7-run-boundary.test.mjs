import assert from 'node:assert/strict';
import test from 'node:test';

import { validateTerminalV7RunBoundaryEvidence } from '../src/terminal-v7-run-boundary.mjs';

function challenge() {
  return {
    id: 'terminal-mini-ledger-v7',
    execution: {
      agentToolRuntimePolicy: {
        traceAudit: 'sandbox-enforced-attempt-observation',
        modelCommandCapabilities: 'fail-closed-zero-mask-guard',
      },
      runtimeImages: {
        'dotagents-mono': { schemaVersion: 'agentbattler.dotagents-v7-image.v1', image: 'dot:v7', imageId: `sha256:${'1'.repeat(64)}` },
      },
      tasks: {
        'release-01': {
          images: {
            environment: { kind: 'environment', image: 'env:v7', imageId: `sha256:${'2'.repeat(64)}`, sourceSha256: '3'.repeat(64) },
            verifier: { kind: 'verifier', image: 'verifier:v7', imageId: `sha256:${'4'.repeat(64)}`, sourceSha256: '5'.repeat(64) },
          },
          imageReferences: {
            environment: `sha256:${'2'.repeat(64)}`,
            verifier: `sha256:${'4'.repeat(64)}`,
          },
        },
      },
    },
  };
}

function isolation(turn, sandboxPolicy) {
  return {
    schemaVersion: 'agentbattler.terminal-trace-isolation-audit.v1',
    turn,
    checkedToolPayloads: 3,
    forbiddenMarkers: 9,
    passed: true,
    sandboxEnforced: true,
    sandboxPolicy,
    disqualifying: false,
    observedAttemptCount: turn === 2 ? 1 : 0,
    observedAttempts: turn === 2 ? [{ tool: 'execute', marker: '<network-capable-tool-input>' }] : [],
    violations: [],
  };
}

function dotRun() {
  const imageIdentity = challenge().execution.runtimeImages['dotagents-mono'];
  return {
    harness: 'dotagents-mono',
    turns: Array.from({ length: 5 }, (_, index) => ({ isolation: isolation(index + 1, 'dotagents-bwrap-v7-r1') })),
    adapter: { modelCommandCapabilities: 'exactly-zero', image: imageIdentity.image, imageIdentity },
  };
}

test('V7 run boundary accepts blocked attempts as scoreable evidence and binds Dot image identity', () => {
  const run = dotRun();
  assert.equal(validateTerminalV7RunBoundaryEvidence({ challenge: challenge(), job: { harness: { id: 'dotagents-mono' } }, run }), run);
  const changed = structuredClone(run);
  changed.adapter.imageIdentity.imageId = `sha256:${'2'.repeat(64)}`;
  assert.throws(() => validateTerminalV7RunBoundaryEvidence({ challenge: challenge(), job: { harness: { id: 'dotagents-mono' } }, run: changed }), /runtime image identity/);
});

test('V7 run boundary rejects missing isolation and nonzero-capability attestations', () => {
  const run = dotRun();
  delete run.turns[3].isolation;
  assert.throws(() => validateTerminalV7RunBoundaryEvidence({ challenge: challenge(), job: { harness: { id: 'dotagents-mono' } }, run }), /isolation audit schema/);
  const privileged = dotRun();
  privileged.adapter.modelCommandCapabilities = 'unknown';
  assert.throws(() => validateTerminalV7RunBoundaryEvidence({ challenge: challenge(), job: { harness: { id: 'dotagents-mono' } }, run: privileged }), /zero-capability/);
});

test('V7 Harbor boundary binds five native verifier probes and exact prebuilt image IDs', () => {
  const descriptor = challenge();
  const run = {
    harness: 'claude-code',
    turns: Array.from({ length: 5 }, (_, index) => ({ isolation: isolation(index + 1, 'claude-code-sealed-command-sandbox') })),
    adapter: {
      modelCommandCapabilities: 'exactly-zero',
      name: 'harbor',
      environment: 'docker',
      verifierEnvironment: 'separate',
      imageExecutionPolicy: 'sealed-prebuilt-task-images',
      runtimeImages: descriptor.execution.tasks['release-01'].images,
      taskImageReferences: Object.fromEntries(['environment', 'verifier'].map((kind) => [kind, descriptor.execution.tasks['release-01'].images[kind].imageId])),
      verifierBoundaries: Array.from({ length: 5 }, (_, index) => ({
        phase: index + 1,
        candidateCapabilityMask: '0000000000000000',
        candidateNativeBoundary: 'bubblewrap-v1',
      })),
    },
  };
  const job = { harness: { id: 'claude-code' }, instanceId: 'release-01' };
  assert.equal(validateTerminalV7RunBoundaryEvidence({ challenge: descriptor, job, run }), run);
  const changedImage = structuredClone(run);
  changedImage.adapter.runtimeImages.verifier.imageId = `sha256:${'6'.repeat(64)}`;
  assert.throws(() => validateTerminalV7RunBoundaryEvidence({ challenge: descriptor, job, run: changedImage }), /runtime image identity/);
  const changedReference = structuredClone(run);
  changedReference.adapter.taskImageReferences.environment = descriptor.execution.tasks['release-01'].images.environment.image;
  assert.throws(() => validateTerminalV7RunBoundaryEvidence({ challenge: descriptor, job, run: changedReference }), /runtime image identity/);
  const privileged = structuredClone(run);
  privileged.adapter.verifierBoundaries[2].candidateCapabilityMask = '0000000000000001';
  assert.throws(() => validateTerminalV7RunBoundaryEvidence({ challenge: descriptor, job, run: privileged }), /phase 3 verifier boundary/);
});
