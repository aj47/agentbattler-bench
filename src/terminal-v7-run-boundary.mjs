import { canonicalJson } from './provenance.mjs';

const TRACE_AUDIT_SCHEMA = 'agentbattler.terminal-trace-isolation-audit.v1';
const CALIBRATION_CHALLENGE_SCHEMA = 'agentbattler.terminal-v7-calibration-challenge.v1';
const HARBOR_HARNESSES = new Set(['claude-code', 'codex-cli', 'pi-coding-agent']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedSandboxPolicy(harnessId) {
  if (HARBOR_HARNESSES.has(harnessId)) return `${harnessId}-sealed-command-sandbox`;
  if (harnessId === 'dotagents-mono') return 'dotagents-bwrap-v7-r1';
  if (harnessId === 'factory-droid') return 'macos-sandbox-exec-v7-process-separated';
  throw new Error(`Unknown V7 harness boundary: ${harnessId}`);
}

function validateIsolationAudit(isolation, { harnessId, turn }) {
  invariant(isolation?.schemaVersion === TRACE_AUDIT_SCHEMA, `V7 ${harnessId} turn ${turn} isolation audit schema changed`);
  invariant(isolation.turn === turn
    && isolation.passed === true
    && isolation.sandboxEnforced === true
    && isolation.disqualifying === false, `V7 ${harnessId} turn ${turn} did not retain non-disqualifying sandbox evidence`);
  invariant(isolation.sandboxPolicy === expectedSandboxPolicy(harnessId), `V7 ${harnessId} turn ${turn} sandbox policy changed`);
  invariant(Number.isSafeInteger(isolation.checkedToolPayloads) && isolation.checkedToolPayloads >= 0
    && Number.isSafeInteger(isolation.forbiddenMarkers) && isolation.forbiddenMarkers > 0, `V7 ${harnessId} turn ${turn} isolation coverage is invalid`);
  invariant(Array.isArray(isolation.observedAttempts)
    && Number.isSafeInteger(isolation.observedAttemptCount)
    && isolation.observedAttemptCount === isolation.observedAttempts.length, `V7 ${harnessId} turn ${turn} observed-attempt count changed`);
  invariant(Array.isArray(isolation.violations) && isolation.violations.length === 0, `V7 ${harnessId} turn ${turn} converted blocked attempts into disqualification evidence`);
  for (const attempt of isolation.observedAttempts) {
    invariant(typeof attempt?.tool === 'string' && attempt.tool.length > 0
      && typeof attempt?.marker === 'string' && attempt.marker.length > 0, `V7 ${harnessId} turn ${turn} observed-attempt record is invalid`);
  }
}

function validateDroidCredentialBoundaries(adapter) {
  invariant(adapter.credentialSettingsUnlinked === true
    && adapter.apiKeyStoredInPersistentSettings === false
    && adapter.apiKeyInheritedByModelCommands === false
    && adapter.apiKeyDelivery === 'ephemeral-settings-settled-and-retired-before-first-turn', 'V7 Droid credential lifecycle changed');
  const scans = adapter.credentialResidueScans;
  const expected = ['before-first-turn', 'after-turn-1', 'after-turn-2', 'after-turn-3', 'after-turn-4', 'after-turn-5', 'after-session-close'];
  invariant(Array.isArray(scans) && canonicalJson(scans.map(({ boundary }) => boundary)) === canonicalJson(expected), 'V7 Droid credential-residue boundaries are incomplete');
  for (const scan of scans) invariant(Number.isSafeInteger(scan.filesScanned) && scan.filesScanned >= 0, `V7 Droid credential scan is invalid at ${scan.boundary}`);
  invariant(Number.isSafeInteger(scans[0].retirement?.settingsFilesRemoved) && scans[0].retirement.settingsFilesRemoved >= 1, 'V7 Droid credential settings were not retired before its first turn');
  invariant(adapter.filesystemIsolation?.name === 'macos-sandbox-exec-v7-process-separated'
    && adapter.filesystemIsolation?.controlRoot === 'read-only'
    && adapter.filesystemIsolation?.network === 'loopback-router-droid-binary-only-model-children-denied', 'V7 Droid OS sandbox attestation changed');
  invariant(canonicalJson(adapter.restrictedTools) === canonicalJson(['Execute'])
    && adapter.inProcessFilesystemTools === 'disabled'
    && adapter.commandToolBoundary === 'execute-only-child-process', 'V7 Droid exposed a parent-process filesystem tool');
}

function expectedHarborTask(challenge, job) {
  const tasks = challenge.execution?.tasks;
  invariant(tasks && typeof tasks === 'object' && !Array.isArray(tasks), 'V7 Harbor task bindings are missing');
  const calibration = challenge.schemaVersion === CALIBRATION_CHALLENGE_SCHEMA;
  const bindingKey = calibration ? job?.instanceSha256 : job?.instanceId;
  invariant(typeof bindingKey === 'string' && bindingKey.length > 0, `V7 Harbor ${calibration ? 'calibration' : 'release'} task binding key is missing`);
  const task = tasks[bindingKey];
  invariant(task, `V7 Harbor task binding is missing for ${bindingKey}`);
  invariant(task.instanceId === undefined || task.instanceId === job.instanceId, 'V7 Harbor task instance identity changed');
  invariant(task.variant === undefined || task.variant === job.instanceVariant, 'V7 Harbor task variant identity changed');
  return task;
}

export function validateTerminalV7RunBoundaryEvidence({ challenge, job, run } = {}) {
  const harnessId = job?.harness?.id ?? run?.harness;
  invariant(challenge?.id === 'terminal-mini-ledger-v7'
    && challenge.execution?.agentToolRuntimePolicy?.traceAudit === 'sandbox-enforced-attempt-observation'
    && challenge.execution?.agentToolRuntimePolicy?.modelCommandCapabilities === 'fail-closed-zero-mask-guard', 'V7 run boundary policy is not sealed');
  invariant(run?.harness === harnessId && Array.isArray(run.turns) && run.turns.length === 5, 'V7 run boundary identity is invalid');
  invariant(run.adapter?.modelCommandCapabilities === 'exactly-zero', `V7 ${harnessId} run did not attest the zero-capability command boundary`);
  for (let index = 0; index < run.turns.length; index += 1) validateIsolationAudit(run.turns[index].isolation, { harnessId, turn: index + 1 });
  if (harnessId === 'dotagents-mono') {
    const expected = challenge.execution?.runtimeImages?.['dotagents-mono'];
    invariant(expected && canonicalJson(run.adapter.imageIdentity) === canonicalJson(expected), 'V7 DotAgents run used another runtime image identity');
    invariant(run.adapter.image === expected.image, 'V7 DotAgents run recorded another runtime tag');
  } else if (harnessId === 'factory-droid') {
    validateDroidCredentialBoundaries(run.adapter);
  } else {
    invariant(HARBOR_HARNESSES.has(harnessId)
      && run.adapter.name === 'harbor'
      && run.adapter.environment === 'docker'
      && run.adapter.verifierEnvironment === 'separate', `V7 ${harnessId} Harbor boundary evidence changed`);
    const expectedTask = expectedHarborTask(challenge, job);
    const expectedImages = expectedTask.images;
    const expectedTaskReferences = Object.fromEntries(['environment', 'verifier'].map((kind) => [kind, expectedImages?.[kind]?.imageId]));
    invariant(expectedImages
      && canonicalJson(expectedTask.imageReferences) === canonicalJson(expectedTaskReferences)
      && run.adapter.imageExecutionPolicy === 'sealed-prebuilt-task-images'
      && canonicalJson(run.adapter.runtimeImages) === canonicalJson(expectedImages)
      && canonicalJson(run.adapter.taskImageReferences) === canonicalJson(expectedTaskReferences), `V7 ${harnessId} Harbor runtime image identity changed`);
    invariant(Array.isArray(run.adapter.verifierBoundaries) && run.adapter.verifierBoundaries.length === 5, `V7 ${harnessId} verifier boundary evidence is incomplete`);
    for (let index = 0; index < 5; index += 1) {
      const proof = run.adapter.verifierBoundaries[index];
      invariant(proof.phase === index + 1
        && /^0+$/.test(proof.candidateCapabilityMask ?? '')
        && proof.candidateNativeBoundary === 'bubblewrap-v1', `V7 ${harnessId} phase ${index + 1} verifier boundary changed`);
    }
  }
  return run;
}
