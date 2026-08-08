#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDroidSettings,
  DROID_CONTEXT_POLICY,
  DROID_HARNESS_ID,
  DROID_RESTRICTED_TOOLS,
  DROID_V7_RESTRICTED_TOOLS,
  DROID_VERSION,
  droidCustomModelId,
  materializeDroidSettingsCredential,
} from '../src/droid-harness.mjs';
import { DroidJsonRpcSession } from '../src/droid-jsonrpc.mjs';
import {
  assertDroidCredentialAbsent,
  createDroidSandboxProfile,
  createDroidV7SandboxProfile,
  droidSandboxLauncher,
  droidV7SandboxLauncher,
  isolatedDroidEnvironment,
  isolatedDroidV7Environment,
  requireDroidSandboxRuntime,
  resolveDroidV7RuntimeReadPaths,
  retireDroidCredentialSettings,
} from '../src/droid-sandbox.mjs';
import { droidRouteModel, droidRouterConfig, preflightDroidRoute } from '../src/droid-routing.mjs';
import { verifyDroidRuntime } from '../src/droid-runtime.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';
import { terminalChallengeRuntime } from '../src/terminal-challenge-runtime.mjs';
import {
  beginTerminalV7DirectPhase,
  completeTerminalV7DirectPhase,
  createTerminalV7DirectState,
  disposeTerminalV7DirectState,
  finishTerminalV7DirectRun,
} from '../src/terminal-v7-direct.mjs';
import {
  captureTerminalCandidateSnapshot,
  terminalTraceIsolationForChallenge,
  terminalTurnCompletion,
  verifyTerminalFinalPublic,
  verifyTerminalPublicStage,
} from '../src/terminal-run-evidence.mjs';

export const harnesses = [DROID_HARNESS_ID];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { prompts, publicVerifier, holdoutVerifier } = terminalChallengeRuntime;

function invariant(condition, message) { if (!condition) throw new Error(message); }

function redactCredential(value, apiKey) {
  let replacements = 0;
  const visit = (subject) => {
    if (Array.isArray(subject)) return subject.map(visit);
    if (subject && typeof subject === 'object') return Object.fromEntries(Object.entries(subject).map(([key, child]) => [key, visit(child)]));
    if (typeof subject === 'string' && subject.includes(apiKey)) {
      replacements += subject.split(apiKey).length - 1;
      return subject.replaceAll(apiKey, '<redacted-droid-api-key>');
    }
    return subject;
  };
  return { value: visit(value), replacements };
}

function publicTrace(content, { runDirectory, apiKey }) {
  const literalRedacted = content
    .replaceAll(runDirectory, '<ephemeral-run-directory>')
    .replaceAll(apiKey, '<redacted-droid-api-key>');
  return sanitizePublicTrace(literalRedacted, { homeDirectory: os.homedir(), username: os.userInfo().username });
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(job.harness === undefined || job.harness === DROID_HARNESS_ID, 'Droid adapter received a non-Droid job');
  const model = job.model ?? job.modelRequested;
  const reasoningEffort = job.reasoningEffort ?? 'high';
  const router = droidRouterConfig();
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const workspace = path.join(runDirectory, 'workspace');
  const home = path.join(runDirectory, 'droid-home');
  const factoryHome = path.join(home, '.factory');
  const temporaryDirectory = path.join(home, 'tmp');
  await Promise.all([workspace, factoryHome, temporaryDirectory].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const settings = createDroidSettings({
    baseUrl: router.baseUrl,
    upstreamModelPrefix: router.upstreamModelPrefix,
    reasoningEffort,
    llmRequestTimeout: job.maxWallTimeMs ?? 1_800_000,
  });
  const settingsTemplateContent = `${canonicalJson(settings, { space: 2 })}\n`;
  const settingsPath = path.join(factoryHome, 'settings.json');
  const verifiedDroidRuntime = await verifyDroidRuntime(process.env);
  const { binaryPath: droidBinary, ...droidRuntime } = verifiedDroidRuntime;
  const isV7 = challenge.id === 'terminal-mini-ledger-v7';
  const runtimeReadPaths = [process.execPath];
  const v7RuntimeReadPaths = isV7 ? await resolveDroidV7RuntimeReadPaths(runtimeReadPaths) : null;
  const env = isV7
    ? isolatedDroidV7Environment(home, temporaryDirectory, { executablePaths: runtimeReadPaths })
    : isolatedDroidEnvironment(home, temporaryDirectory, { executablePaths: runtimeReadPaths });
  await preflightDroidRoute(router, model);

  let launcher = null;
  if (challenge.id === 'terminal-mini-ledger-v6' || isV7) {
    const routeUrl = new URL(router.baseUrl);
    invariant(['127.0.0.1', 'localhost', '::1'].includes(routeUrl.hostname), `${isV7 ? 'V7' : 'V6'} Droid requires a loopback model router so its OS sandbox can deny all other network access`);
    const networkPort = Number(routeUrl.port || (routeUrl.protocol === 'https:' ? 443 : 80));
    const sandboxBinary = await requireDroidSandboxRuntime();
    const profilePath = path.join(runDirectory, 'droid-sandbox.sb');
    if (isV7) {
      await writeFile(profilePath, createDroidV7SandboxProfile({
        runDirectory,
        workspace,
        binaryPath: droidBinary,
        runtimeReadPaths: v7RuntimeReadPaths,
        networkPort,
      }), { mode: 0o600 });
      launcher = droidV7SandboxLauncher({ sandboxBinary, profilePath, droidBinary, runtimeReadPaths: v7RuntimeReadPaths });
    } else {
      await writeFile(profilePath, createDroidSandboxProfile({ runDirectory, binaryPath: droidBinary, allowedReadPaths: runtimeReadPaths, networkPort }), { mode: 0o600 });
      launcher = droidSandboxLauncher({ sandboxBinary, profilePath, droidBinary, allowedReadPaths: runtimeReadPaths });
    }
  }

  const runStartedAt = new Date().toISOString();
  const timeoutMs = job.maxWallTimeMs ?? null;
  const stages = []; const sessionIds = []; const turns = [];
  const compaction = { count: 0, boundaries: [] };
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let sessionId = null; let toolCalls = 0; let sanitizationReplacements = 0; let settingsEvidence;
  let v7State = isV7 ? await createTerminalV7DirectState({ challenge, job, runDirectory, workspace }) : null;
  let v7Final = null;
  let credentialSettingsUnlinked = false;
  const credentialResidueScans = [];
  const allowedTools = isV7 ? DROID_V7_RESTRICTED_TOOLS : DROID_RESTRICTED_TOOLS;
  const session = new DroidJsonRpcSession({ workspace, model, env, timeoutMs, reasoningEffort, launcher, allowedTools });
  try {
    const runtimeSettings = materializeDroidSettingsCredential(settings, router.apiKey);
    await writeFile(settingsPath, `${canonicalJson(runtimeSettings, { space: 2 })}\n`, { mode: 0o600 });
    const initialized = await session.start();
    const retirement = await retireDroidCredentialSettings({ factoryHome, apiKey: router.apiKey });
    invariant(retirement.settingsFilesRemoved >= 1, 'Droid did not retire its credential settings before the first turn');
    credentialSettingsUnlinked = true;
    credentialResidueScans.push({ boundary: 'before-first-turn', retirement, ...await assertDroidCredentialAbsent({ runDirectory, apiKey: router.apiKey }) });
    sessionId = initialized.sessionId;
    const redactedSettingsEvidence = redactCredential(initialized.settings, router.apiKey);
    sanitizationReplacements += redactedSettingsEvidence.replacements;
    settingsEvidence = redactedSettingsEvidence.value;
    for (let index = 0; index < prompts.length; index += 1) {
      const startedAt = new Date().toISOString();
      const prompt = isV7 ? await beginTerminalV7DirectPhase(v7State, index + 1) : prompts[index];
      const turn = await session.turn(prompt, timeoutMs);
      const summary = turn.summary;
      const isolation = challenge.execution?.traceIsolationRequired === true
        ? terminalTraceIsolationForChallenge({ challenge, sandboxPolicy: launcher?.policy?.name, trace: turn.messages, repositoryRoot: REPOSITORY_ROOT, workspace, turn: index + 1 })
        : null;
      const traceContent = `${turn.messages.map((event) => canonicalJson(event)).join('\n')}\n`;
      const trace = publicTrace(traceContent, { runDirectory, apiKey: router.apiKey });
      sanitizationReplacements += trace.totalReplacements;
      await writeFile(path.join(runDirectory, `turn-${index + 1}.jsonl`), trace.content);
      compaction.count += summary.compaction.count;
      compaction.boundaries.push(...summary.compaction.boundaries.map((boundary) => ({ ...boundary, turn: index + 1 })));
      invariant(summary.sessionId === sessionId, `Droid session changed on turn ${index + 1}`);
      sessionIds.push(summary.sessionId);
      toolCalls += summary.toolCallCount;
      for (const key of Object.keys(usage)) usage[key] += summary.usage[key];
      const v7Phase = isV7 ? await completeTerminalV7DirectPhase(v7State, index + 1) : null;
      const candidate = !isV7 && challenge.execution?.candidateSnapshotsRequired === true ? await captureTerminalCandidateSnapshot({ sourcePath: path.join(workspace, 'ledger.mjs'), runDirectory, turn: index + 1 }) : null;
      const stage = isV7 ? v7Phase.stage : await verifyTerminalPublicStage({ workspace, publicVerifier, stageId: job.challengeStageIds?.[index] ?? challenge?.stages?.[index]?.id });
      stages.push({ ...stage, id: stage.id ?? stage.stageId });
      turns.push({
        index: index + 1,
        sessionId: summary.sessionId,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: summary.durationMs,
        eventCount: summary.eventCount,
        toolCalls: summary.toolCallCount,
        toolCallBreakdown: summary.toolCallBreakdown,
        usage: summary.usage,
        compaction: summary.compaction,
        context: { before: summary.beforeContext, after: summary.afterContext },
        completion: terminalTurnCompletion({ nativeReason: summary.stopReason }),
        ...(candidate ? { candidate } : {}),
        ...(v7Phase ? { candidateTree: v7Phase.candidateTree, declaredArtifact: v7Phase.artifact } : {}),
        ...(isolation ? { isolation } : {}),
      });
      credentialResidueScans.push({ boundary: `after-turn-${index + 1}`, ...await assertDroidCredentialAbsent({ runDirectory, apiKey: router.apiKey }) });
    }
    if (isV7) v7Final = await finishTerminalV7DirectRun(v7State);
  } finally {
    await session.close();
    const retirement = await retireDroidCredentialSettings({ factoryHome, apiKey: router.apiKey });
    const stderr = publicTrace(session.stderrText(), { runDirectory, apiKey: router.apiKey });
    sanitizationReplacements += stderr.totalReplacements;
    await writeFile(path.join(runDirectory, 'droid.stderr'), stderr.content);
    credentialResidueScans.push({ boundary: 'after-session-close', retirement, ...await assertDroidCredentialAbsent({ runDirectory, apiKey: router.apiKey }) });
    await disposeTerminalV7DirectState(v7State);
  }
  const finalPublic = !isV7 && challenge.execution?.finalPublicEvaluationRequired === true ? await verifyTerminalFinalPublic({ workspace, challenge, publicVerifier }) : null;
  const holdout = isV7 ? null : await holdoutVerifier.verifyHoldout({ workspace });
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1',
    status: 'completed',
    validity: 'valid',
    harness: DROID_HARNESS_ID,
    harnessVersion: DROID_VERSION,
    model,
    reasoningEffort,
    sessionId,
    sameSessionProof: sessionIds.length === prompts.length && sessionIds.every((id) => id === sessionId),
    startedAt: runStartedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(runStartedAt),
    turns,
    toolCalls,
    usage,
    compaction,
    stages,
    ...(finalPublic ? { finalPublic } : {}),
    holdout,
    ...(v7Final ? { phaseResults: v7State.phaseResults, declaredArtifacts: v7State.declaredArtifacts, declaredArtifactRejections: v7State.declaredArtifactRejections, evaluation: v7Final.evaluation ?? v7Final } : {}),
    humanIntervention: 'none',
    workspace: { path: '<ephemeral-run-workspace>' },
    adapter: {
      execution: 'droid-exec-stream-jsonrpc-single-process',
      runtime: droidRuntime,
      provider: 'openai-responses-compatible-custom-model',
      transport: router.provenance,
      routeKind: router.kind,
      baseUrl: settings.customModels[0].baseUrl,
      upstreamModel: droidRouteModel(router, model),
      customModelId: droidCustomModelId(model),
      settingsSha256: sha256(settingsTemplateContent),
      settingsEvidence,
      contextPolicy: DROID_CONTEXT_POLICY,
      compactionModel: settings.compactionModel,
      modelFallbacks: settings.modelFallbacks,
      restrictedTools: allowedTools,
      ...(isV7 ? { inProcessFilesystemTools: 'disabled', commandToolBoundary: 'execute-only-child-process' } : {}),
      builtinSkillsDisabled: true,
      hooksDisabled: true,
      cloudSessionSync: false,
      isolatedHome: true,
      hostFactorySettingsInherited: false,
      apiKeyStoredInPersistentSettings: false,
      apiKeyInheritedByModelCommands: false,
      apiKeyDelivery: 'ephemeral-settings-settled-and-retired-before-first-turn',
      credentialSettingsUnlinked,
      credentialResidueScans,
      sanitizationReplacements,
      filesystemIsolation: launcher?.policy ?? null,
      ...(isV7 ? {
        modelCommandCapabilities: 'exactly-zero',
        modelCommandCapabilityMechanism: 'macos-no-linux-capability-bitmap-plus-sandbox-exec',
      } : {}),
    },
  };
}
