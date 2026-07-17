#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isLegalUciMove, parseFen } from '../src/chess.mjs';
import {
  DOTAGENTS_COMMIT,
  DOTAGENTS_IMAGE,
  DOTAGENTS_PROFILE_ID,
  DOTAGENTS_VERSION,
  buildDotAgentsDockerArgs,
  createDotAgentsConfig,
  summarizeDotAgentsTrace,
} from '../src/dotagents-harness.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const AGENTS_DIR = path.join(ROOT, 'agents/dotagents-model-suite');
const RESULT_ROOT = path.join(ROOT, 'results/dotagents-model-suite');
const GENERATIONS_DIR = path.join(RESULT_ROOT, 'generations');
const CODEX_AUTH = path.join(os.homedir(), '.codex/auth.json');
const REASONING_EFFORT = 'high';
const FAMILIES = [
  { id: 'terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  { id: 'sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { id: 'luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
];
const generationsPerModel = Number.parseInt(process.env.AGENTBATTLER_GENERATIONS_PER_MODEL ?? '5', 10);
const generationConcurrency = Number.parseInt(process.env.AGENTBATTLER_GENERATION_CONCURRENCY ?? '1', 10);
const generationTimeoutMs = Number.parseInt(process.env.AGENTBATTLER_GENERATION_TIMEOUT_MS ?? String(20 * 60_000), 10);
const requestedFamilyIds = new Set((process.env.AGENTBATTLER_MODEL_FAMILIES ?? FAMILIES.map((family) => family.id).join(','))
  .split(',').map((id) => id.trim()).filter(Boolean));
const resume = process.env.AGENTBATTLER_RESUME === '1';
const image = process.env.AGENTBATTLER_DOTAGENTS_IMAGE ?? DOTAGENTS_IMAGE;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, { cwd = ROOT, env = process.env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const result = { exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (!allowFailure && exitCode !== 0) reject(new Error(`${command} exited ${exitCode}: ${result.stderr || result.stdout}`));
      else resolve(result);
    });
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function writeConfig(configRoot, config) {
  const agentsRoot = path.join(configRoot, '.agents');
  for (const [relative, content] of Object.entries(config.files)) {
    const destination = path.join(agentsRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: 0o600 });
  }
}

async function inspectImage() {
  const result = await run('docker', ['image', 'inspect', image]);
  const document = JSON.parse(result.stdout)[0];
  invariant(document?.Config?.Labels?.['org.opencontainers.image.revision'] === DOTAGENTS_COMMIT, `DotAgents image is not pinned to ${DOTAGENTS_COMMIT}`);
  invariant(document?.Config?.Labels?.['org.opencontainers.image.version'] === DOTAGENTS_VERSION, `DotAgents image is not version ${DOTAGENTS_VERSION}`);
  return { id: document.Id, repoDigests: document.RepoDigests ?? [], architecture: document.Architecture, os: document.Os };
}

async function waitForHealth(port, apiKey, childState) {
  const url = `http://127.0.0.1:${port}/v1/operator/health`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (childState.closed) throw new Error(`DotAgents container exited before health check (${childState.exitCode})`);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* wait for Electron and the remote server */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('DotAgents container did not become healthy within 60 seconds');
}

async function streamGeneration(port, apiKey, prompt) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `agent:${DOTAGENTS_PROFILE_ID}`,
      profile_id: DOTAGENTS_PROFILE_ID,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      send_push_notification: false,
    }),
    signal: AbortSignal.timeout(generationTimeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error(`DotAgents request failed (${response.status}): ${await response.text()}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      events.push(JSON.parse(payload));
    }
    if (done) break;
  }
  invariant(events.some((event) => event?.type === 'done'), 'DotAgents stream ended without a done event');
  return events;
}

function publicText(content, { suiteRoot, apiKey }) {
  const literalRedacted = content.replaceAll(suiteRoot, '<ephemeral-suite-root>').replaceAll(apiKey, '<redacted-api-key>');
  return sanitizePublicTrace(literalRedacted, { homeDirectory: os.homedir(), username: os.userInfo().username });
}

async function stopContainer(child, containerName, childState) {
  if (!childState.closed && child.stdin.writable) child.stdin.write('/quit\n');
  for (let attempt = 0; attempt < 20 && !childState.closed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!childState.closed) await run('docker', ['stop', '--time', '5', containerName], { allowFailure: true });
}

async function runContainer({ entry, home, configRoot, workspace, hostPort, apiKey, prompt, suiteRoot }) {
  const containerName = `agentbattler-dotagents-${entry.id}-${process.pid}`.toLowerCase();
  const args = buildDotAgentsDockerArgs({ image, name: containerName, hostPort, home, configRoot, workspace });
  const child = spawn('docker', args, { cwd: ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  const childState = { closed: false, exitCode: null };
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('close', (exitCode) => { childState.closed = true; childState.exitCode = exitCode; });
  const childError = new Promise((_, reject) => child.once('error', reject));
  try {
    await Promise.race([waitForHealth(hostPort, apiKey, childState), childError]);
    const events = await Promise.race([streamGeneration(hostPort, apiKey, prompt), childError]);
    return { events, stdout, stderr, args };
  } finally {
    await stopContainer(child, containerName, childState);
    const logs = {
      stdout: publicText(Buffer.concat(stdout).toString('utf8'), { suiteRoot, apiKey }),
      stderr: publicText(Buffer.concat(stderr).toString('utf8'), { suiteRoot, apiKey }),
    };
    await writeFile(path.join(path.dirname(workspace), 'container-stdout.txt'), logs.stdout.content);
    await writeFile(path.join(path.dirname(workspace), 'container-stderr.txt'), logs.stderr.content);
  }
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

async function existingGeneration(entry) {
  if (!resume) return null;
  try {
    const metadata = JSON.parse(await readFile(path.join(GENERATIONS_DIR, entry.id, 'metadata.json'), 'utf8'));
    const identity = await validateAgent(path.join(AGENTS_DIR, `${entry.id}.js`));
    invariant(metadata.run?.modelRequested === entry.model && metadata.probeSummary?.total === metadata.probes?.length, `Resume evidence is invalid for ${entry.id}`);
    invariant(metadata.dotagents?.commit === DOTAGENTS_COMMIT, `Resume DotAgents commit differs for ${entry.id}`);
    invariant(identity.sourceSha256 === metadata.agent?.sha256, `Resume source hash differs for ${entry.id}`);
    return { entry, metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function generateOne({ entry, auth, prompt, positions, imageIdentity, suiteRoot }) {
  const generationDir = path.join(GENERATIONS_DIR, entry.id);
  await rm(generationDir, { recursive: true, force: true });
  const home = path.join(generationDir, 'ephemeral-home');
  const configRoot = path.join(generationDir, 'config-workspace');
  const workspace = path.join(generationDir, 'workspace');
  await Promise.all([home, configRoot, workspace].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await mkdir(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, '.codex/auth.json'), `${canonicalJson(auth, { space: 2 })}\n`, { mode: 0o600 });
  await chmod(path.join(home, '.codex/auth.json'), 0o600);
  const apiKey = randomBytes(32).toString('hex');
  const config = createDotAgentsConfig({ model: entry.model, remoteApiKey: apiKey, remotePort: 3210 });
  await writeConfig(configRoot, config);
  try {
    const hostPort = await availablePort();
    console.log(`Generating ${entry.id} (${entry.model}) with isolated DotAgents ${DOTAGENTS_VERSION}...`);
    const started = Date.now();
    const result = await runContainer({ entry, home, configRoot, workspace, hostPort, apiKey, prompt, suiteRoot });
    const telemetry = summarizeDotAgentsTrace(result.events, entry.model);
    const traceContent = `${result.events.map((event) => canonicalJson(event)).join('\n')}\n`;
    const trace = publicText(traceContent, { suiteRoot, apiKey });
    await writeFile(path.join(generationDir, 'dotagents-events.jsonl'), trace.content);

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
    schemaVersion: 'agentbattler.dotagents-generation-metadata.v1',
    run: {
      modelRequested: entry.model,
      modelFamilyId: entry.familyId,
      generationIndex: entry.generationIndex,
      reasoningEffort: REASONING_EFFORT,
      harness: 'dotagents-mono',
      harnessVersion: DOTAGENTS_VERSION,
      provider: 'chatgpt-codex-direct',
      durationMs: Date.now() - started,
      generationSettings: config.generationSettings,
    },
    dotagents: {
      repository: 'https://github.com/aj47/dotagents-mono',
      commit: DOTAGENTS_COMMIT,
      version: DOTAGENTS_VERSION,
      image,
      imageId: imageIdentity.id,
      imageArchitecture: imageIdentity.architecture,
      imageOs: imageIdentity.os,
    },
    isolation: {
      mechanism: 'read-only-docker-container-with-ephemeral-mounts',
      hostHomeMounted: false,
      isolatedHome: true,
      isolatedConfigWorkspace: true,
      emptyGenerationWorkspace: true,
      hostPublishedAddress: '127.0.0.1',
      containerCapabilities: [],
      noNewPrivileges: true,
      skillsEnabled: false,
      externalMcpServers: 0,
      runtimeTools: config.generationSettings.runtimeTools,
      commandNetworkUseAudited: true,
    },
    authentication: {
      method: 'codex-chatgpt-oauth-copied-ephemerally',
      subscriptionAccess: true,
      openAiApiKeyUsed: false,
      hostCredentialStoreMounted: false,
    },
    telemetry: {
      eventCount: telemetry.eventCount,
      modelIds: telemetry.modelIds,
      toolCallCount: telemetry.toolCallCount,
      toolCallBreakdown: telemetry.toolCallBreakdown,
      conversationMessageCount: telemetry.conversationMessageCount,
      assistantMessageCount: telemetry.assistantMessageCount,
      inputTokens: telemetry.sessionCost?.inputTokens ?? null,
      outputTokens: telemetry.sessionCost?.outputTokens ?? null,
      reasoningTokens: telemetry.sessionCost?.reasoningTokens ?? null,
      cachedInputTokens: telemetry.sessionCost?.cacheReadTokens ?? null,
    },
    sanitization: {
      strategy: 'literal-ephemeral-and-host-identity-redaction',
      totalReplacements: trace.totalReplacements,
    },
    nativeTrace: {
      path: `results/dotagents-model-suite/generations/${entry.id}/dotagents-events.jsonl`,
      sha256: sha256(trace.content),
      sizeBytes: Buffer.byteLength(trace.content),
    },
    prompt: { path: 'benchmark/challenges/chess-agent-v1.md', sha256: sha256(prompt) },
    agent: { path: `agents/dotagents-model-suite/${entry.id}.js`, sha256: identity.sourceSha256, sizeBytes: identity.sizeBytes },
    probes: legality,
    probeSummary: { passed: legality.filter((probe) => probe.legal).length, total: legality.length, allPassed: legality.every((probe) => probe.legal) },
    };
    await writeFile(path.join(generationDir, 'metadata.json'), `${canonicalJson(metadata, { space: 2 })}\n`);
    return { entry, metadata };
  } finally {
    await Promise.all([home, configRoot, workspace].map((directory) => rm(directory, { recursive: true, force: true })));
  }
}

async function main() {
  invariant(Number.isSafeInteger(generationsPerModel) && generationsPerModel > 0, 'AGENTBATTLER_GENERATIONS_PER_MODEL must be positive');
  invariant(Number.isSafeInteger(generationConcurrency) && generationConcurrency > 0, 'AGENTBATTLER_GENERATION_CONCURRENCY must be positive');
  invariant(Number.isSafeInteger(generationTimeoutMs) && generationTimeoutMs >= 60_000, 'AGENTBATTLER_GENERATION_TIMEOUT_MS must be at least 60000');
  const families = FAMILIES.filter((family) => requestedFamilyIds.has(family.id));
  invariant(families.length === requestedFamilyIds.size && families.length > 0, `AGENTBATTLER_MODEL_FAMILIES must contain only: ${FAMILIES.map((family) => family.id).join(', ')}`);
  const [auth, prompt, positionsDocument, imageIdentity] = await Promise.all([
    readFile(CODEX_AUTH, 'utf8').then(JSON.parse),
    readFile(PROMPT_PATH, 'utf8'),
    readFile(POSITIONS_PATH, 'utf8').then(JSON.parse),
    inspectImage(),
  ]);
  invariant(auth?.auth_mode === 'chatgpt', 'Codex must be signed in with ChatGPT');
  invariant(typeof auth?.tokens?.access_token === 'string' && typeof auth?.tokens?.refresh_token === 'string' && typeof auth?.tokens?.account_id === 'string', 'Codex ChatGPT OAuth is incomplete');
  const entries = Array.from({ length: generationsPerModel }, (_, index) => families.map((family) => ({
    ...family,
    familyId: family.id,
    id: `dotagents-${family.id}-${String(index + 1).padStart(2, '0')}`,
    generationIndex: index + 1,
    displayName: `DotAgents / ${family.displayName} #${index + 1}`,
  }))).flat();
  if (!resume) {
    await rm(AGENTS_DIR, { recursive: true, force: true });
    await rm(GENERATIONS_DIR, { recursive: true, force: true });
  }
  await Promise.all([AGENTS_DIR, GENERATIONS_DIR].map((directory) => mkdir(directory, { recursive: true })));
  const suiteRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-dotagents-'));
  const completed = new Array(entries.length);
  const failures = [];
  let cursor = 0;
  try {
    async function worker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          const existing = await existingGeneration(entry);
          if (existing) {
            console.log(`Reusing verified ${entry.id} from the interrupted suite.`);
            completed[index] = existing;
          } else {
            completed[index] = await generateOne({ entry, auth, prompt, positions: positionsDocument.positions, imageIdentity, suiteRoot });
          }
        } catch (error) {
          failures.push({ entry, error });
          console.error(`${entry.id}: ${error.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(generationConcurrency, entries.length) }, () => worker()));
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ error }) => error), `${failures.length} DotAgents generation(s) failed; rerun with AGENTBATTLER_RESUME=1`);
    }
  } finally {
    await rm(suiteRoot, { recursive: true, force: true });
  }

  const promptSha256 = sha256(prompt);
  const manifest = {
    schemaVersion: 'agentbattler.agent-manifest.v1',
    manifestId: `dotagents-model-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    description: `${generationsPerModel} isolated DotAgents generations per selected model using direct ChatGPT Codex OAuth.`,
    comparison: {
      kind: 'model-comparison', harness: 'dotagents-mono', harnessVersion: DOTAGENTS_VERSION,
      harnessCommit: DOTAGENTS_COMMIT, provider: 'chatgpt-codex-direct', reasoningEffort: REASONING_EFFORT,
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
        kind: 'dotagents-generated', isFixture: false, generatedByHarness: true,
        harness: 'dotagents-mono', harnessVersion: DOTAGENTS_VERSION, harnessCommit: DOTAGENTS_COMMIT,
        provider: 'chatgpt-codex-direct', modelRequested: entry.model, modelFamilyId: entry.familyId,
        generationIndex: entry.generationIndex, reasoningEffort: REASONING_EFFORT,
        generationSettings: metadata.run.generationSettings,
        prompt: 'benchmark/challenges/chess-agent-v1.md', promptSha256,
        generationMetadata: `results/dotagents-model-suite/generations/${entry.id}/metadata.json`,
      },
    })),
  };
  await writeFile(path.join(AGENTS_DIR, 'manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);
  const totals = completed.reduce((sum, item) => ({
    runs: sum.runs + 1,
    durationMs: sum.durationMs + item.metadata.run.durationMs,
    toolCalls: sum.toolCalls + item.metadata.telemetry.toolCallCount,
    inputTokens: sum.inputTokens + (item.metadata.telemetry.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (item.metadata.telemetry.outputTokens ?? 0),
  }), { runs: 0, durationMs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 });
  await writeFile(path.join(RESULT_ROOT, 'generation-suite.json'), `${canonicalJson({
    schemaVersion: 'agentbattler.dotagents-generation-suite.v1', generatedAt: new Date().toISOString(), generationsPerModel, generationConcurrency, generationTimeoutMs,
    families, harness: { name: 'dotagents-mono', version: DOTAGENTS_VERSION, commit: DOTAGENTS_COMMIT },
    image: imageIdentity, reasoningEffort: REASONING_EFFORT, promptSha256,
    authentication: { method: 'codex-chatgpt-oauth-copied-ephemerally', openAiApiKeyUsed: false },
    isolation: { mechanism: 'read-only-docker-container-with-ephemeral-mounts', skillsEnabled: false, externalMcpServers: 0, runtimeTools: ['execute_command', 'mark_work_complete'] },
    totals,
  }, { space: 2 })}\n`);
  console.log(`Generated ${completed.length} DotAgents agents; manifest: ${path.join(AGENTS_DIR, 'manifest.json')}`);
}

main().catch((error) => {
  console.error(`AgentBattler DotAgents generation: ${error.message}`);
  process.exitCode = 1;
});
