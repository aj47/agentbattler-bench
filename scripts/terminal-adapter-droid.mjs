#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDroidSettings,
  DROID_CONTEXT_POLICY,
  DROID_HARNESS_ID,
  DROID_REASONING_EFFORT,
  DROID_RESTRICTED_TOOLS,
  DROID_VERSION,
  droidCustomModelId,
} from '../src/droid-harness.mjs';
import { DroidJsonRpcSession } from '../src/droid-jsonrpc.mjs';
import { droidRouteModel, droidRouterConfig, preflightDroidRoute } from '../src/droid-routing.mjs';
import { verifyDroidRuntime } from '../src/droid-runtime.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';
import { terminalChallengeRuntime } from '../src/terminal-challenge-runtime.mjs';

export const harnesses = [DROID_HARNESS_ID];
const { prompts, publicVerifier, holdoutVerifier } = terminalChallengeRuntime;

function invariant(condition, message) { if (!condition) throw new Error(message); }

function isolatedDroidEnvironment(home, temporaryDirectory, apiKey) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL'];
  return {
    ...Object.fromEntries(keep.flatMap((key) => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])),
    HOME: home,
    TMPDIR: temporaryDirectory,
    NO_COLOR: '1',
    AGENTBATTLER_DROID_API_KEY: apiKey,
  };
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
  const router = droidRouterConfig();
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const workspace = path.join(runDirectory, 'workspace');
  const home = path.join(runDirectory, 'droid-home');
  const factoryHome = path.join(home, '.factory');
  const temporaryDirectory = path.join(home, 'tmp');
  await Promise.all([workspace, factoryHome, temporaryDirectory].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const settings = createDroidSettings({ baseUrl: router.baseUrl, upstreamModelPrefix: router.upstreamModelPrefix });
  const settingsContent = `${canonicalJson(settings, { space: 2 })}\n`;
  const settingsPath = path.join(factoryHome, 'settings.json');
  await writeFile(settingsPath, settingsContent, { mode: 0o600 });
  const env = isolatedDroidEnvironment(home, temporaryDirectory, router.apiKey);
  const droidRuntime = await verifyDroidRuntime(env);
  await preflightDroidRoute(router, model);

  const runStartedAt = new Date().toISOString();
  const timeoutMs = job.maxWallTimeMs ?? null;
  const stages = []; const sessionIds = []; const turns = [];
  const compaction = { count: 0, boundaries: [] };
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let sessionId = null; let toolCalls = 0; let sanitizationReplacements = 0; let settingsEvidence;
  const session = new DroidJsonRpcSession({ workspace, model, env, timeoutMs });
  try {
    const initialized = await session.start();
    sessionId = initialized.sessionId;
    settingsEvidence = initialized.settings;
    for (let index = 0; index < prompts.length; index += 1) {
      const startedAt = new Date().toISOString();
      const turn = await session.turn(prompts[index], timeoutMs);
      const summary = turn.summary;
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
      const stage = await publicVerifier.verifyPublicStage({ workspace, stageId: job.challengeStageIds?.[index] ?? challenge?.stages?.[index]?.id });
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
      });
    }
  } finally {
    await session.close();
    const stderr = publicTrace(session.stderrText(), { runDirectory, apiKey: router.apiKey });
    sanitizationReplacements += stderr.totalReplacements;
    await writeFile(path.join(runDirectory, 'droid.stderr'), stderr.content);
  }
  const holdout = await holdoutVerifier.verifyHoldout({ workspace });
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1',
    status: 'completed',
    validity: 'valid',
    harness: DROID_HARNESS_ID,
    harnessVersion: DROID_VERSION,
    model,
    reasoningEffort: DROID_REASONING_EFFORT,
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
    holdout,
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
      settingsSha256: sha256(settingsContent),
      settingsEvidence,
      contextPolicy: DROID_CONTEXT_POLICY,
      compactionModel: settings.compactionModel,
      modelFallbacks: settings.modelFallbacks,
      restrictedTools: DROID_RESTRICTED_TOOLS,
      builtinSkillsDisabled: true,
      hooksDisabled: true,
      cloudSessionSync: false,
      isolatedHome: true,
      hostFactorySettingsInherited: false,
      apiKeyStoredInSettings: false,
      sanitizationReplacements,
    },
  };
}
