#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isLegalUciMove, parseFen } from '../src/chess.mjs';
import {
  buildPiDockerArgs,
  parsePiEventStream,
  PI_HARNESS_VERSION,
  PI_IMAGE,
  piSubscriptionAuthFromCodex,
  validateNativePiSession,
  validatePiSubscriptionAuth,
} from '../src/pi-harness.mjs';
import { canonicalJson, sha256, sha256File } from '../src/provenance.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const DOCKER_CONTEXT = path.join(ROOT, 'harnesses/pi');
const AGENTS_DIR = process.env.AGENTBATTLER_AGENTS_DIR
  ? path.resolve(process.env.AGENTBATTLER_AGENTS_DIR)
  : path.join(ROOT, 'agents/pi-model-suite');
const RESULT_ROOT = process.env.AGENTBATTLER_RESULT_ROOT
  ? path.resolve(process.env.AGENTBATTLER_RESULT_ROOT)
  : path.join(ROOT, 'results/pi-model-suite');
const GENERATIONS_DIR = path.join(RESULT_ROOT, 'generations');
const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex/auth.json');
const HOST_STATE_PATHS = {
  codexConfig: path.join(os.homedir(), '.codex/config.toml'),
  piAuth: path.join(os.homedir(), '.pi/agent/auth.json'),
  piSettings: path.join(os.homedir(), '.pi/agent/settings.json'),
  piModels: path.join(os.homedir(), '.pi/agent/models.json'),
  piTrust: path.join(os.homedir(), '.pi/agent/trust.json'),
};
const IMAGE = process.env.AGENTBATTLER_PI_IMAGE ?? PI_IMAGE;
const REASONING_EFFORT = 'high';
const MODEL_FAMILIES = [
  { id: 'terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  { id: 'sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { id: 'luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
];
const GENERATIONS_PER_MODEL = Number.parseInt(process.env.AGENTBATTLER_GENERATIONS_PER_MODEL ?? '5', 10);
if (!Number.isSafeInteger(GENERATIONS_PER_MODEL) || GENERATIONS_PER_MODEL < 1) {
  throw new Error('AGENTBATTLER_GENERATIONS_PER_MODEL must be a positive integer');
}
const FAMILY_FILTER = new Set((process.env.AGENTBATTLER_MODEL_FAMILIES ?? MODEL_FAMILIES.map(({ id }) => id).join(','))
  .split(',').map((value) => value.trim()).filter(Boolean));
const UNKNOWN_FAMILIES = [...FAMILY_FILTER].filter((id) => !MODEL_FAMILIES.some((family) => family.id === id));
if (UNKNOWN_FAMILIES.length > 0) throw new Error(`Unknown AGENTBATTLER_MODEL_FAMILIES: ${UNKNOWN_FAMILIES.join(', ')}`);
const SELECTED_FAMILIES = MODEL_FAMILIES.filter(({ id }) => FAMILY_FILTER.has(id));
if (SELECTED_FAMILIES.length === 0) throw new Error('AGENTBATTLER_MODEL_FAMILIES selected no models');
const MODELS = Array.from({ length: GENERATIONS_PER_MODEL }, (_, index) => SELECTED_FAMILIES.map((family) => ({
  ...family,
  id: `pi-${family.id}-${String(index + 1).padStart(2, '0')}`,
  displayName: `Pi / ${family.displayName} #${index + 1}`,
  modelFamilyId: family.id,
  generationIndex: index + 1,
}))).flat();

function runProcess(command, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({
      exitCode,
      stdoutText: Buffer.concat(stdout).toString('utf8'),
      stderrText: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

async function optionalSha256(file) {
  try {
    return await sha256File(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshotHostState() {
  return Object.fromEntries(await Promise.all(Object.entries(HOST_STATE_PATHS).map(async ([name, file]) => [name, await optionalSha256(file)])));
}

function compareHostState(before, after) {
  return Object.fromEntries(Object.keys(before).map((name) => [`${name}Unchanged`, before[name] === after[name]]));
}

async function ensurePiImage() {
  let inspected;
  if (process.env.AGENTBATTLER_PI_IMAGE) {
    inspected = await runProcess('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
    if (inspected.exitCode !== 0) throw new Error(`Configured Pi image is unavailable: ${IMAGE}`);
  } else {
    console.log(`Building ${IMAGE}...`);
    const built = await runProcess('docker', [
      'build', '--tag', IMAGE,
      '--build-arg', `PI_VERSION=${PI_HARNESS_VERSION}`,
      DOCKER_CONTEXT,
    ]);
    if (built.exitCode !== 0) throw new Error(`Pi image build failed: ${built.stderrText || built.stdoutText}`);
    inspected = await runProcess('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
  }
  if (inspected.exitCode !== 0) throw new Error(`Could not inspect Pi image ${IMAGE}`);
  const version = await runProcess('docker', ['run', '--rm', '--network', 'none', '--read-only', IMAGE, '--version']);
  if (version.exitCode !== 0 || version.stdoutText.trim() !== PI_HARNESS_VERSION) {
    throw new Error(`Pi image must contain version ${PI_HARNESS_VERSION}; got ${version.stdoutText.trim() || 'unknown'}`);
  }
  return { name: IMAGE, id: inspected.stdoutText.trim(), version: version.stdoutText.trim() };
}

async function prepareSubscriptionCredential(suiteAuthPath) {
  const codexAuth = await readFile(CODEX_AUTH_PATH, 'utf8').then(JSON.parse);
  const { authentication, document } = piSubscriptionAuthFromCodex(codexAuth);
  await writeFile(suiteAuthPath, `${canonicalJson(document, { space: 2 })}\n`, { mode: 0o600 });
  await chmod(suiteAuthPath, 0o600);
  return { authentication, codexAuth };
}

async function probeAgent(agentPath, positions) {
  const probes = [];
  for (const position of positions) {
    const attempt = await runAgentMove({ agentPath, fen: position.fen });
    probes.push({
      positionId: position.id,
      status: attempt.status,
      move: attempt.move,
      legal: attempt.status === 'ok' && isLegalUciMove(parseFen(position.fen), attempt.move),
      runtimeMs: attempt.runtimeMs,
      detail: attempt.detail,
    });
  }
  return probes;
}

function publicDockerCommand(args, workspace, piHome) {
  return ['docker', ...args.map((value) => value
    .replace(workspace, '<ephemeral-workspace>')
    .replace(piHome, '<ephemeral-pi-home>'))];
}

async function generateOne(entry, prompt, promptSha256, positions, suiteAuthPath, codexAuth, image) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `agentbattler-${entry.id}-`));
  const workspace = path.join(tempRoot, 'workspace');
  const piHome = path.join(tempRoot, 'pi-home');
  const sessions = path.join(piHome, 'sessions');
  const generationDir = path.join(GENERATIONS_DIR, entry.id);
  await Promise.all([workspace, piHome, sessions, generationDir].map((directory) => mkdir(directory, { recursive: true })));
  await copyFile(suiteAuthPath, path.join(piHome, 'auth.json'));
  await chmod(path.join(piHome, 'auth.json'), 0o600);
  const emptyWorkspaceEntries = await readdir(workspace);
  const eventsPath = path.join(generationDir, 'pi-events.jsonl');
  const stderrPath = path.join(generationDir, 'pi-stderr.txt');
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? `${process.getuid()}:${process.getgid()}`
    : '1000:1000';
  const args = buildPiDockerArgs({ image: image.name, model: entry.model, prompt, workspace, piHome, user });
  try {
    const started = Date.now();
    const run = await runProcess('docker', args, { cwd: workspace });
    const durationMs = Date.now() - started;
    const scrubContext = { homeDirectory: os.homedir(), username: os.userInfo().username };
    const sanitizedEvents = sanitizePublicTrace(run.stdoutText, scrubContext);
    const sanitizedStderr = sanitizePublicTrace(run.stderrText, scrubContext);
    await Promise.all([
      writeFile(eventsPath, sanitizedEvents.content),
      writeFile(stderrPath, sanitizedStderr.content),
    ]);
    if (run.exitCode !== 0) throw new Error(`${entry.model} exited ${run.exitCode}; see ${stderrPath}`);

    const workspaceEntries = (await readdir(workspace, { withFileTypes: true }))
      .map((item) => ({ name: item.name, type: item.isFile() ? 'file' : item.isDirectory() ? 'directory' : 'other' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (workspaceEntries.length !== 1 || workspaceEntries[0].name !== 'agent.js' || workspaceEntries[0].type !== 'file') {
      throw new Error(`${entry.model} left unexpected workspace entries: ${workspaceEntries.map(({ name, type }) => `${name} (${type})`).join(', ') || '(none)'}`);
    }
    const sourcePath = path.join(workspace, 'agent.js');
    const identity = await validateAgent(sourcePath);
    const targetPath = path.join(AGENTS_DIR, `${entry.id}.js`);
    await copyFile(sourcePath, targetPath);
    const probes = await probeAgent(targetPath, positions);

    const telemetry = parsePiEventStream(sanitizedEvents.content);
    const sessionFiles = (await walk(sessions)).filter((file) => file.endsWith('.jsonl'));
    if (sessionFiles.length !== 1) throw new Error(`${entry.model} produced ${sessionFiles.length} native Pi session files instead of one`);
    const sanitizedSession = sanitizePublicTrace(await readFile(sessionFiles[0], 'utf8'), scrubContext);
    const sessionContent = sanitizedSession.content;
    const nativeSession = validateNativePiSession(sessionContent, {
      sessionId: telemetry.sessionId,
      model: entry.model,
      prompt,
      forbiddenText: [os.homedir(), os.userInfo().username],
    });
    if (telemetry.toolCallCount !== nativeSession.toolCallCount) {
      throw new Error(`Pi event/native session tool-call mismatch: ${telemetry.toolCallCount} != ${nativeSession.toolCallCount}`);
    }
    if (telemetry.totalTokens !== nativeSession.totalTokens) {
      throw new Error(`Pi event/native session token mismatch: ${telemetry.totalTokens} != ${nativeSession.totalTokens}`);
    }
    const nativeSessionPath = path.join(generationDir, 'session.jsonl');
    await writeFile(nativeSessionPath, sessionContent);

    const refreshedAuth = JSON.parse(await readFile(path.join(piHome, 'auth.json'), 'utf8'));
    validatePiSubscriptionAuth(codexAuth, refreshedAuth);
    await writeFile(suiteAuthPath, `${canonicalJson({ 'openai-codex': refreshedAuth['openai-codex'] }, { space: 2 })}\n`, { mode: 0o600 });
    await chmod(suiteAuthPath, 0o600);

    const piHomeEntries = (await readdir(piHome)).sort();
    const metadata = {
      schemaVersion: 'agentbattler.pi-generation-metadata.v1',
      run: {
        modelRequested: entry.model,
        modelFamilyId: entry.modelFamilyId,
        generationIndex: entry.generationIndex,
        reasoningEffort: REASONING_EFFORT,
        harness: 'pi-coding-agent',
        harnessVersion: PI_HARNESS_VERSION,
        provider: 'openai-codex',
        sessionId: telemetry.sessionId,
        runCount: 1,
        durationMs,
        exitCode: run.exitCode,
        command: publicDockerCommand(args, workspace, piHome),
        isolation: {
          mechanism: 'docker',
          image: image.name,
          imageId: image.id,
          imageFilesystemReadOnly: true,
          linuxCapabilities: [],
          noNewPrivileges: true,
          network: 'bridge-provider-access-required',
          hostHomeMounted: false,
          writableMounts: ['/workspace', '/pi-home'],
          emptyWorkspaceAtStart: emptyWorkspaceEntries.length === 0,
          finalWorkspaceEntries: workspaceEntries,
          onlyAgentFileCreated: true,
          ephemeralPiHome: true,
          onlyOpenAiCodexCredentialCopied: true,
          hostPiSettingsCopied: false,
          extensionsEnabled: false,
          skillsEnabled: false,
          promptTemplatesEnabled: false,
          themesEnabled: false,
          contextFilesEnabled: false,
          projectTrust: 'denied',
          configuredMcpServers: 0,
          allowedTools: ['read', 'bash', 'edit', 'write'],
          piHomeEntriesAfterRun: piHomeEntries,
        },
      },
      telemetry: {
        eventCount: telemetry.eventCount,
        eventTypes: telemetry.eventTypes,
        turnCount: nativeSession.turnCount,
        toolCallCount: nativeSession.toolCallCount,
        toolCallBreakdown: nativeSession.toolCallBreakdown,
        mcpCallCount: nativeSession.mcpCallCount,
        inputTokens: nativeSession.inputTokens,
        cachedInputTokens: nativeSession.cacheReadTokens,
        cacheWriteTokens: nativeSession.cacheWriteTokens,
        outputTokens: nativeSession.outputTokens,
        reasoningTokens: null,
        totalTokens: nativeSession.totalTokens,
      },
      authentication: {
        method: 'chatgpt',
        provider: 'openai-codex',
        subscriptionAccess: true,
        sameAccountAsCodex: true,
        apiKeyEnvironmentRemoved: true,
        hostCredentialMutated: false,
      },
      sanitization: {
        strategy: 'literal-host-identity-redaction',
        placeholders: ['<redacted-home>', '<redacted-user>'],
        eventStream: sanitizedEvents.replacements,
        stderr: sanitizedStderr.replacements,
        nativeSession: sanitizedSession.replacements,
        totalReplacements: sanitizedEvents.totalReplacements + sanitizedStderr.totalReplacements + sanitizedSession.totalReplacements,
      },
      nativeSession: {
        path: `results/pi-model-suite/generations/${entry.id}/session.jsonl`,
        sha256: sha256(sessionContent),
        sizeBytes: Buffer.byteLength(sessionContent),
        ...nativeSession,
      },
      prompt: { path: 'benchmark/challenges/chess-agent-v1.md', sha256: promptSha256 },
      agent: {
        path: `agents/pi-model-suite/${entry.id}.js`,
        sizeBytes: identity.sizeBytes,
        sha256: identity.sourceSha256,
      },
      probes,
      probeSummary: {
        passed: probes.filter((probe) => probe.legal).length,
        total: probes.length,
        allPassed: probes.every((probe) => probe.legal),
      },
    };
    await writeFile(path.join(generationDir, 'metadata.json'), `${canonicalJson(metadata, { space: 2 })}\n`);
    return { entry, metadata };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const hostStateBefore = await snapshotHostState();
  const suiteTempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-pi-suite-'));
  const suiteAuthPath = path.join(suiteTempRoot, 'auth.json');
  try {
    const [{ authentication, codexAuth }, image, prompt, positionsDocument] = await Promise.all([
      prepareSubscriptionCredential(suiteAuthPath),
      ensurePiImage(),
      readFile(PROMPT_PATH, 'utf8'),
      readFile(POSITIONS_PATH, 'utf8').then(JSON.parse),
    ]);
    const promptSha256 = sha256(prompt);
    await mkdir(AGENTS_DIR, { recursive: true });
    await rm(GENERATIONS_DIR, { recursive: true, force: true });
    await mkdir(GENERATIONS_DIR, { recursive: true });

    const generated = [];
    for (const entry of MODELS) {
      console.log(`Generating ${entry.id} (${entry.model}) with Pi...`);
      generated.push(await generateOne(entry, prompt, promptSha256, positionsDocument.positions, suiteAuthPath, codexAuth, image));
    }

    const manifest = {
      schemaVersion: 'agentbattler.agent-manifest.v1',
      manifestId: `pi-model-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      description: `${GENERATIONS_PER_MODEL} independent Pi generations per selected model from one fixed prompt at high reasoning in isolated Docker workspaces.`,
      comparison: {
        kind: 'model-comparison',
        harness: 'pi-coding-agent',
        harnessVersion: PI_HARNESS_VERSION,
        provider: 'openai-codex',
        reasoningEffort: REASONING_EFFORT,
        generationsPerModel: GENERATIONS_PER_MODEL,
        prompt: 'benchmark/challenges/chess-agent-v1.md',
        promptSha256,
      },
      agents: generated.map(({ entry, metadata }) => ({
        id: entry.id,
        displayName: entry.displayName,
        modelFamilyId: entry.modelFamilyId,
        generationIndex: entry.generationIndex,
        role: 'model-challenger',
        source: metadata.agent.path,
        sourceSha256: metadata.agent.sha256,
        provenance: {
          kind: 'pi-generated',
          isFixture: false,
          generatedByHarness: true,
          harness: 'pi-coding-agent',
          harnessVersion: PI_HARNESS_VERSION,
          provider: 'openai-codex',
          modelRequested: entry.model,
          modelFamilyId: entry.modelFamilyId,
          generationIndex: entry.generationIndex,
          reasoningEffort: REASONING_EFFORT,
          prompt: 'benchmark/challenges/chess-agent-v1.md',
          promptSha256,
          generationMetadata: `results/pi-model-suite/generations/${entry.id}/metadata.json`,
        },
      })),
    };
    await writeFile(path.join(AGENTS_DIR, 'manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);

    const hostStateAfter = await snapshotHostState();
    const hostState = compareHostState(hostStateBefore, hostStateAfter);
    const suiteMetadata = {
      schemaVersion: 'agentbattler.pi-generation-suite.v1',
      generatedAt: new Date().toISOString(),
      generationsPerModel: GENERATIONS_PER_MODEL,
      families: SELECTED_FAMILIES,
      generationOrder: MODELS.map(({ id }) => id),
      models: MODELS.map(({ id, model, modelFamilyId, generationIndex }) => ({ id, model, modelFamilyId, generationIndex })),
      harness: { name: 'pi-coding-agent', version: PI_HARNESS_VERSION, image: image.name, imageId: image.id },
      reasoningEffort: REASONING_EFFORT,
      authentication,
      promptSha256,
      isolation: {
        mechanism: 'docker',
        hostHomeMounted: false,
        hostState,
        allHostStateUnchanged: Object.values(hostState).every(Boolean),
      },
      totals: {
        runs: generated.length,
        durationMs: generated.reduce((sum, item) => sum + item.metadata.run.durationMs, 0),
        turns: generated.reduce((sum, item) => sum + item.metadata.telemetry.turnCount, 0),
        toolCalls: generated.reduce((sum, item) => sum + item.metadata.telemetry.toolCallCount, 0),
        mcpCalls: generated.reduce((sum, item) => sum + item.metadata.telemetry.mcpCallCount, 0),
        tokens: generated.reduce((sum, item) => sum + item.metadata.telemetry.totalTokens, 0),
      },
    };
    await writeFile(path.join(RESULT_ROOT, 'generation-suite.json'), `${canonicalJson(suiteMetadata, { space: 2 })}\n`);
    if (!suiteMetadata.isolation.allHostStateUnchanged) throw new Error('Host Codex or Pi state changed during isolated generation');
    for (const { entry, metadata } of generated) {
      console.log(`${entry.id}: ${metadata.agent.sizeBytes} bytes, ${metadata.probeSummary.passed}/${metadata.probeSummary.total} probes, ${metadata.telemetry.totalTokens} tokens, ${metadata.run.durationMs} ms`);
    }
    console.log(`Host Codex/Pi state unchanged: ${suiteMetadata.isolation.allHostStateUnchanged}`);
    console.log(`Manifest: ${path.join(AGENTS_DIR, 'manifest.json')}`);
  } finally {
    await rm(suiteTempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`AgentBattler Pi generation: ${error.message}`);
  process.exitCode = 1;
});
