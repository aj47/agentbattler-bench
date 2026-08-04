#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isLegalUciMove, parseFen } from '../src/chess.mjs';
import {
  createDroidSettings,
  DROID_CONTEXT_POLICY,
  DROID_HARNESS_ID,
  DROID_MODEL_FAMILIES,
  DROID_REASONING_EFFORT,
  DROID_RESTRICTED_TOOLS,
  DROID_VERSION,
  droidCustomModelId,
  droidExecArgs,
  parseDroidEventStream,
  summarizeDroidEvents,
} from '../src/droid-harness.mjs';
import { droidRouteModel, droidRouterConfig, preflightDroidRoute } from '../src/droid-routing.mjs';
import { verifyDroidRuntime } from '../src/droid-runtime.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const AGENTS_DIR = path.join(ROOT, 'agents/droid-model-suite');
const RESULT_ROOT = path.join(ROOT, 'results/droid-model-suite');
const GENERATIONS_DIR = path.join(RESULT_ROOT, 'generations');
const generationsPerModel = Number.parseInt(process.env.AGENTBATTLER_GENERATIONS_PER_MODEL ?? '5', 10);
const generationConcurrency = Number.parseInt(process.env.AGENTBATTLER_GENERATION_CONCURRENCY ?? '1', 10);
const generationTimeoutMs = Number.parseInt(process.env.AGENTBATTLER_GENERATION_TIMEOUT_MS ?? String(20 * 60_000), 10);
const requestedFamilyIds = new Set((process.env.AGENTBATTLER_MODEL_FAMILIES ?? DROID_MODEL_FAMILIES.map((family) => family.id).join(','))
  .split(',').map((id) => id.trim()).filter(Boolean));
const resume = process.env.AGENTBATTLER_RESUME === '1';

function invariant(condition, message) { if (!condition) throw new Error(message); }

function isolatedEnvironment(home, apiKey) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL'];
  return {
    ...Object.fromEntries(keep.flatMap((key) => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])),
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    NO_COLOR: '1',
    AGENTBATTLER_DROID_API_KEY: apiKey,
  };
}

function run(command, args, { cwd, env, prompt = null, timeoutMs = generationTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 15_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(prompt ?? '', 'utf8');
  });
}

function publicText(content, { suiteRoot, apiKey }) {
  const redacted = content.replaceAll(suiteRoot, '<ephemeral-suite-root>').replaceAll(apiKey, '<redacted-droid-api-key>');
  return sanitizePublicTrace(redacted, { homeDirectory: os.homedir(), username: os.userInfo().username });
}

async function probes(agentPath, positions) {
  return Promise.all(positions.map(async (position) => {
    const attempt = await runAgentMove({ agentPath, fen: position.fen });
    return {
      positionId: position.id,
      status: attempt.status,
      move: attempt.move,
      runtimeMs: attempt.runtimeMs,
      detail: attempt.detail,
      legal: attempt.status === 'ok' && isLegalUciMove(parseFen(position.fen), attempt.move),
    };
  }));
}

async function existingGeneration(entry, router, droidRuntime) {
  if (!resume) return null;
  try {
    const metadata = JSON.parse(await readFile(path.join(GENERATIONS_DIR, entry.id, 'metadata.json'), 'utf8'));
    const identity = await validateAgent(path.join(AGENTS_DIR, `${entry.id}.js`));
    invariant(metadata.run?.modelRequested === entry.model, `Resume model differs for ${entry.id}`);
    invariant(metadata.run?.provider === router.providerId, `Resume provider differs for ${entry.id}`);
    invariant(metadata.run?.upstreamModel === droidRouteModel(router, entry.model), `Resume upstream model differs for ${entry.id}`);
    invariant(metadata.droid?.version === DROID_VERSION, `Resume Droid version differs for ${entry.id}`);
    invariant(metadata.droid?.binarySha256 === droidRuntime.binarySha256, `Resume Droid binary differs for ${entry.id}`);
    invariant(identity.sourceSha256 === metadata.agent?.sha256, `Resume source hash differs for ${entry.id}`);
    return { entry, metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function generateOne({ entry, prompt, positions, router, droidRuntime, suiteRoot }) {
  const generationDir = path.join(GENERATIONS_DIR, entry.id);
  await rm(generationDir, { recursive: true, force: true });
  const home = path.join(generationDir, 'ephemeral-home');
  const factoryHome = path.join(home, '.factory');
  const workspace = path.join(generationDir, 'workspace');
  await Promise.all([factoryHome, workspace, path.join(home, 'tmp')].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const settings = createDroidSettings({ baseUrl: router.baseUrl, upstreamModelPrefix: router.upstreamModelPrefix });
  const settingsContent = `${canonicalJson(settings, { space: 2 })}\n`;
  await writeFile(path.join(factoryHome, 'settings.json'), settingsContent, { mode: 0o600 });
  const env = isolatedEnvironment(home, router.apiKey);
  try {
    console.log(`Generating ${entry.id} (${entry.model}) with isolated Droid ${DROID_VERSION}...`);
    const started = Date.now();
    const result = await run('droid', droidExecArgs({ workspace, model: entry.model }), { cwd: workspace, env, prompt });
    const trace = publicText(result.stdout, { suiteRoot, apiKey: router.apiKey });
    const stderr = publicText(result.stderr, { suiteRoot, apiKey: router.apiKey });
    await Promise.all([
      writeFile(path.join(generationDir, 'droid-events.jsonl'), trace.content),
      writeFile(path.join(generationDir, 'stderr.txt'), stderr.content),
    ]);
    invariant(!result.timedOut, `${entry.id} exceeded the ${generationTimeoutMs} ms generation timeout`);
    invariant(result.exitCode === 0 && !result.signal, `${entry.id} exited ${result.exitCode ?? result.signal}: ${stderr.content.trim()}`);
    const events = parseDroidEventStream(trace.content);
    const telemetry = summarizeDroidEvents(events);
    const workspaceEntries = await readdir(workspace, { withFileTypes: true });
    invariant(workspaceEntries.length === 1 && workspaceEntries[0].isFile() && workspaceEntries[0].name === 'agent.js', `${entry.id} did not leave exactly agent.js`);
    const target = path.join(AGENTS_DIR, `${entry.id}.js`);
    await copyFile(path.join(workspace, 'agent.js'), target);
    const identity = await validateAgent(target);
    const legality = await probes(target, positions);
    if (!legality.every((probe) => probe.legal)) {
      console.warn(`${entry.id}: ${legality.filter((probe) => probe.legal).length}/${legality.length} legality probes passed; preserving the generation as benchmark evidence.`);
    }
    const metadata = {
      schemaVersion: 'agentbattler.droid-generation-metadata.v1',
      run: {
        modelRequested: entry.model,
        upstreamModel: droidRouteModel(router, entry.model),
        modelFamilyId: entry.familyId,
        generationIndex: entry.generationIndex,
        reasoningEffort: DROID_REASONING_EFFORT,
        harness: DROID_HARNESS_ID,
        harnessVersion: DROID_VERSION,
        provider: router.providerId,
        durationMs: Date.now() - started,
      },
      droid: {
        version: DROID_VERSION,
        binarySha256: droidRuntime.binarySha256,
        customModelId: droidCustomModelId(entry.model),
        contextPolicy: DROID_CONTEXT_POLICY,
        compactionModel: settings.compactionModel,
        modelFallbacks: settings.modelFallbacks,
        restrictedTools: DROID_RESTRICTED_TOOLS,
      },
      routing: {
        kind: router.kind,
        transport: router.provenance,
        baseUrl: settings.customModels[0].baseUrl,
        apiKeyEnvironmentReference: settings.customModels[0].apiKey,
        apiKeyStoredInSettings: false,
      },
      isolation: {
        mechanism: 'empty-temp-home-and-workspace',
        isolatedHome: true,
        emptyGenerationWorkspace: true,
        hostFactorySettingsInherited: false,
        builtinSkillsDisabled: true,
        hooksDisabled: true,
        cloudSessionSync: false,
        externalMcpServers: 0,
      },
      telemetry: {
        sessionId: telemetry.sessionId,
        eventCount: telemetry.eventCount,
        toolCallCount: telemetry.toolCallCount,
        toolCallBreakdown: telemetry.toolCallBreakdown,
        ...telemetry.usage,
      },
      sanitization: { strategy: 'literal-ephemeral-key-and-host-identity-redaction', totalReplacements: trace.totalReplacements + stderr.totalReplacements },
      nativeTrace: { path: `results/droid-model-suite/generations/${entry.id}/droid-events.jsonl`, sha256: sha256(trace.content), sizeBytes: Buffer.byteLength(trace.content) },
      prompt: { path: 'benchmark/challenges/chess-agent-v1.md', sha256: sha256(prompt) },
      agent: { path: `agents/droid-model-suite/${entry.id}.js`, sha256: identity.sourceSha256, sizeBytes: identity.sizeBytes },
      probes: legality,
      probeSummary: { passed: legality.filter((probe) => probe.legal).length, total: legality.length, allPassed: legality.every((probe) => probe.legal) },
    };
    await writeFile(path.join(generationDir, 'metadata.json'), `${canonicalJson(metadata, { space: 2 })}\n`);
    return { entry, metadata };
  } finally {
    await Promise.all([home, workspace].map((directory) => rm(directory, { recursive: true, force: true })));
  }
}

async function main() {
  invariant(Number.isSafeInteger(generationsPerModel) && generationsPerModel > 0, 'AGENTBATTLER_GENERATIONS_PER_MODEL must be positive');
  invariant(Number.isSafeInteger(generationConcurrency) && generationConcurrency > 0, 'AGENTBATTLER_GENERATION_CONCURRENCY must be positive');
  invariant(Number.isSafeInteger(generationTimeoutMs) && generationTimeoutMs >= 60_000, 'AGENTBATTLER_GENERATION_TIMEOUT_MS must be at least 60000');
  const families = DROID_MODEL_FAMILIES.filter((family) => requestedFamilyIds.has(family.id));
  invariant(families.length === requestedFamilyIds.size && families.length > 0, `AGENTBATTLER_MODEL_FAMILIES must contain only: ${DROID_MODEL_FAMILIES.map((family) => family.id).join(', ')}`);
  const droidRuntime = await verifyDroidRuntime(process.env);
  const [prompt, positionsDocument] = await Promise.all([
    readFile(PROMPT_PATH, 'utf8'),
    readFile(POSITIONS_PATH, 'utf8').then(JSON.parse),
  ]);
  const router = droidRouterConfig();
  await Promise.all(families.map((family) => preflightDroidRoute(router, family.model)));
  const entries = Array.from({ length: generationsPerModel }, (_, index) => families.map((family) => ({
    ...family,
    familyId: family.id,
    id: `droid-${family.id}-${String(index + 1).padStart(2, '0')}`,
    generationIndex: index + 1,
    displayName: `Droid / ${family.displayName.replace('AgentBattler ', '')} #${index + 1}`,
  }))).flat();
  if (!resume) {
    await rm(AGENTS_DIR, { recursive: true, force: true });
    await rm(GENERATIONS_DIR, { recursive: true, force: true });
  }
  await Promise.all([AGENTS_DIR, GENERATIONS_DIR].map((directory) => mkdir(directory, { recursive: true })));
  const suiteRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-droid-suite-'));
  const completed = new Array(entries.length); const failures = []; let cursor = 0;
  try {
    async function worker() {
      while (true) {
        const index = cursor; cursor += 1;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          completed[index] = await existingGeneration(entry, router, droidRuntime) ?? await generateOne({ entry, prompt, positions: positionsDocument.positions, router, droidRuntime, suiteRoot });
        } catch (error) {
          failures.push({ entry, error });
          console.error(`${entry.id}: ${error.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(generationConcurrency, entries.length) }, () => worker()));
    if (failures.length) throw new AggregateError(failures.map(({ error }) => error), `${failures.length} Droid generation(s) failed; rerun with AGENTBATTLER_RESUME=1`);
  } finally {
    await rm(suiteRoot, { recursive: true, force: true });
  }

  const promptSha256 = sha256(prompt);
  const manifest = {
    schemaVersion: 'agentbattler.agent-manifest.v1',
    manifestId: `droid-model-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    description: `${generationsPerModel} isolated Droid generations per selected model through the configured ${router.provenance.name} OpenAI-compatible endpoint.`,
    comparison: {
      kind: 'model-comparison', harness: DROID_HARNESS_ID, harnessVersion: DROID_VERSION,
      provider: router.providerId, reasoningEffort: DROID_REASONING_EFFORT,
      generationsPerModel, modelFamilies: families.map((family) => family.id), prompt: 'benchmark/challenges/chess-agent-v1.md', promptSha256,
    },
    agents: completed.map(({ entry, metadata }) => ({
      id: entry.id,
      displayName: entry.displayName,
      modelFamilyId: entry.familyId,
      generationIndex: entry.generationIndex,
      role: 'model-challenger',
      source: metadata.agent.path,
      sourceSha256: metadata.agent.sha256,
      provenance: {
        kind: 'droid-generated', isFixture: false, generatedByHarness: true,
        harness: DROID_HARNESS_ID, harnessVersion: DROID_VERSION,
        provider: router.providerId, modelRequested: entry.model, upstreamModel: droidRouteModel(router, entry.model),
        modelFamilyId: entry.familyId, generationIndex: entry.generationIndex, reasoningEffort: DROID_REASONING_EFFORT,
        contextPolicy: DROID_CONTEXT_POLICY,
        prompt: 'benchmark/challenges/chess-agent-v1.md', promptSha256,
        generationMetadata: `results/droid-model-suite/generations/${entry.id}/metadata.json`,
      },
    })),
  };
  await writeFile(path.join(AGENTS_DIR, 'manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);
  const totals = completed.reduce((sum, item) => ({
    runs: sum.runs + 1,
    durationMs: sum.durationMs + item.metadata.run.durationMs,
    toolCalls: sum.toolCalls + item.metadata.telemetry.toolCallCount,
    inputTokens: sum.inputTokens + item.metadata.telemetry.inputTokens,
    outputTokens: sum.outputTokens + item.metadata.telemetry.outputTokens,
  }), { runs: 0, durationMs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 });
  await writeFile(path.join(RESULT_ROOT, 'generation-suite.json'), `${canonicalJson({
    schemaVersion: 'agentbattler.droid-generation-suite.v1', generatedAt: new Date().toISOString(), generationsPerModel,
    generationConcurrency, generationTimeoutMs, families, harness: { name: DROID_HARNESS_ID, version: DROID_VERSION, binarySha256: droidRuntime.binarySha256 },
    provider: router.providerId, transport: router.provenance, reasoningEffort: DROID_REASONING_EFFORT, contextPolicy: DROID_CONTEXT_POLICY,
    promptSha256, isolation: { isolatedHome: true, builtinSkillsDisabled: true, hooksDisabled: true, externalMcpServers: 0 }, totals,
  }, { space: 2 })}\n`);
  console.log(`Generated ${completed.length} Droid agents; manifest: ${path.join(AGENTS_DIR, 'manifest.json')}`);
}

main().catch((error) => {
  console.error(`AgentBattler Droid generation: ${error.message}`);
  process.exitCode = 1;
});
