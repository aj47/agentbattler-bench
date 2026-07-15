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
import { validateNativeCodexSession } from '../src/codex-session.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';
import { canonicalJson, sha256, sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v1.json');
const AGENTS_DIR = path.join(ROOT, 'agents/model-suite');
const RESULT_ROOT = path.join(ROOT, 'results/model-suite');
const GENERATIONS_DIR = path.join(RESULT_ROOT, 'generations');
const GLOBAL_CONFIG = path.join(os.homedir(), '.codex/config.toml');
const AUTH_PATH = path.join(os.homedir(), '.codex/auth.json');
const CODEX_VERSION = '0.144.0';
const REASONING_EFFORT = 'high';
const SYSTEM_SKILL_NAMES = ['imagegen', 'openai-docs', 'plugin-creator', 'skill-creator', 'skill-installer'];
const MODELS = [
  { id: 'terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  { id: 'sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { id: 'luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
];

function countBy(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

function chatGptEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  delete environment.CODEX_ACCESS_TOKEN;
  return environment;
}

function isolatedCodexEnvironment(codexHome, overrides = {}) {
  return chatGptEnvironment({
    HOME: codexHome,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(codexHome, 'xdg-config'),
    XDG_DATA_HOME: path.join(codexHome, 'xdg-data'),
    XDG_CACHE_HOME: path.join(codexHome, 'xdg-cache'),
    CODEX_NON_INTERACTIVE: '1',
    ...overrides,
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

async function requireChatGptAuthentication() {
  const auth = JSON.parse(await readFile(AUTH_PATH, 'utf8'));
  if (auth.auth_mode !== 'chatgpt') throw new Error('Benchmark generation requires Codex ChatGPT subscription authentication');
  if (typeof auth.tokens?.access_token !== 'string' || typeof auth.tokens?.refresh_token !== 'string') {
    throw new Error('Codex ChatGPT authentication is incomplete; run `codex login`');
  }
  const preflightHome = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-auth-'));
  try {
    const isolatedAuth = path.join(preflightHome, 'auth.json');
    await copyFile(AUTH_PATH, isolatedAuth);
    await chmod(isolatedAuth, 0o600);
    const child = spawn('codex', ['login', 'status'], {
      env: isolatedCodexEnvironment(preflightHome),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    const status = `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`;
    if (exitCode !== 0 || !/Logged in using ChatGPT/i.test(status)) {
      throw new Error('Isolated Codex authentication did not verify as ChatGPT; run `codex login`');
    }
    return auth.auth_mode;
  } finally {
    await rm(preflightHome, { recursive: true, force: true });
  }
}

async function prepareIsolatedCodexHome(codexHome) {
  await Promise.all(['xdg-config', 'xdg-data', 'xdg-cache'].map((name) => mkdir(path.join(codexHome, name), { recursive: true })));
  const child = spawn('codex', ['login', 'status'], {
    env: isolatedCodexEnvironment(codexHome),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const status = `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`;
  if (exitCode !== 0 || !/Logged in using ChatGPT/i.test(status)) {
    throw new Error('Generation home did not verify as isolated ChatGPT authentication');
  }
  return SYSTEM_SKILL_NAMES.map((name) => path.join(codexHome, 'skills/.system', name, 'SKILL.md'));
}

function disabledSkillsOverride(skillFiles) {
  return `skills.config=[${skillFiles.map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(',')}]`;
}

async function optionalSha256(file) {
  try {
    return await sha256File(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function runCodex({ model, prompt, workspace, codexHome, stdoutPath, stderrPath, skillFiles }) {
  const args = [
    'exec',
    '--model', model,
    '--sandbox', 'workspace-write',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    '-c', `model_reasoning_effort=${JSON.stringify(REASONING_EFFORT)}`,
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', 'features.apps=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.hooks=false',
    '-c', 'features.shell_snapshot=false',
    '-c', 'mcp_servers={}',
    '-c', disabledSkillsOverride(skillFiles),
    '-C', workspace,
    '-',
  ];
  const started = Date.now();
  const child = spawn('codex', args, {
    cwd: workspace,
    env: isolatedCodexEnvironment(codexHome),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(prompt, 'utf8');
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const ended = Date.now();
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  await writeFile(stdoutPath, stdoutText);
  await writeFile(stderrPath, stderrText);
  return { args, durationMs: ended - started, exitCode, stdoutText, stderrText };
}

function telemetryFromJsonl(text) {
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const startedItems = events.filter((event) => event.type === 'item.started').map((event) => event.item);
  const toolItems = startedItems.filter((item) => item?.type !== 'agent_message' && item?.type !== 'reasoning');
  const completed = [...events].reverse().find((event) => event.type === 'turn.completed');
  const usage = completed?.usage ?? {};
  const mcpItems = toolItems.filter((item) => /mcp/i.test(item?.type ?? '') || /mcp/i.test(item?.server ?? ''));
  return {
    sessionId: events.find((event) => event.type === 'thread.started')?.thread_id ?? null,
    eventCount: events.length,
    eventTypes: countBy(events.map((event) => event.type)),
    turnCount: events.filter((event) => event.type === 'turn.started').length,
    cliToolItemCount: toolItems.length,
    cliToolItemBreakdown: countBy(toolItems.map((item) => item.type)),
    mcpCallCount: mcpItems.length,
    inputTokens: usage.input_tokens ?? null,
    cachedInputTokens: usage.cached_input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    reasoningTokens: usage.reasoning_output_tokens ?? null,
    totalTokens: Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? usage.input_tokens + usage.output_tokens
      : null,
  };
}

async function probeAgent(agentPath, positions) {
  const probes = [];
  for (const position of positions) {
    const attempt = await runAgentMove({ agentPath, fen: position.fen });
    const legal = attempt.status === 'ok' && isLegalUciMove(parseFen(position.fen), attempt.move);
    probes.push({
      positionId: position.id,
      status: attempt.status,
      move: attempt.move,
      legal,
      runtimeMs: attempt.runtimeMs,
      detail: attempt.detail,
    });
  }
  return probes;
}

async function generateOne(entry, prompt, promptSha256, positions) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `agentbattler-${entry.id}-`));
  const workspace = path.join(tempRoot, 'workspace');
  const codexHome = path.join(tempRoot, 'codex-home');
  const generationDir = path.join(GENERATIONS_DIR, entry.id);
  await mkdir(workspace, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(generationDir, { recursive: true });
  await copyFile(AUTH_PATH, path.join(codexHome, 'auth.json'));
  await chmod(path.join(codexHome, 'auth.json'), 0o600);
  const skillFiles = await prepareIsolatedCodexHome(codexHome);
  const emptyWorkspaceEntries = await readdir(workspace);
  const stdoutPath = path.join(generationDir, 'codex.jsonl');
  const stderrPath = path.join(generationDir, 'codex-stderr.txt');
  try {
    const run = await runCodex({ ...entry, prompt, workspace, codexHome, stdoutPath, stderrPath, skillFiles });
    const workspaceEntries = (await readdir(workspace, { withFileTypes: true }))
      .map((item) => ({ name: item.name, type: item.isFile() ? 'file' : item.isDirectory() ? 'directory' : 'other' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const workspaceFiles = workspaceEntries.filter((item) => item.type === 'file').map((item) => item.name);
    const sourcePath = path.join(workspace, 'agent.js');
    if (run.exitCode !== 0) throw new Error(`${entry.model} exited ${run.exitCode}; see ${stderrPath}`);
    if (workspaceFiles.length !== 1 || workspaceFiles[0] !== 'agent.js') {
      throw new Error(`${entry.model} left unexpected workspace files: ${workspaceFiles.join(', ') || '(none)'}`);
    }
    const identity = await validateAgent(sourcePath);
    const targetPath = path.join(AGENTS_DIR, `${entry.id}.js`);
    await copyFile(sourcePath, targetPath);
    const probes = await probeAgent(targetPath, positions);
    const isolatedHomeEntries = (await readdir(codexHome)).filter((name) => name !== 'auth.json').sort();
    const telemetry = telemetryFromJsonl(run.stdoutText);
    const sessionFiles = (await walk(path.join(codexHome, 'sessions'))).filter((file) => file.endsWith('.jsonl'));
    if (sessionFiles.length !== 1) throw new Error(`${entry.model} produced ${sessionFiles.length} native session files instead of one`);
    const sessionContent = await readFile(sessionFiles[0], 'utf8');
    const nativeSession = validateNativeCodexSession(sessionContent, {
      sessionId: telemetry.sessionId,
      model: entry.model,
      prompt,
      forbiddenText: [os.homedir()],
    });
    const nativeSessionPath = path.join(generationDir, 'session.jsonl');
    await writeFile(nativeSessionPath, sessionContent);
    const nativeSessionIdentity = {
      path: `results/model-suite/generations/${entry.id}/session.jsonl`,
      sha256: sha256(sessionContent),
      sizeBytes: Buffer.byteLength(sessionContent),
      ...nativeSession,
    };
    const metadata = {
      schemaVersion: 'agentbattler.codex-generation-metadata.v1',
      run: {
        modelRequested: entry.model,
        reasoningEffort: REASONING_EFFORT,
        codexVersion: CODEX_VERSION,
        sessionId: telemetry.sessionId,
        runCount: 1,
        durationMs: run.durationMs,
        exitCode: run.exitCode,
        command: ['codex', ...run.args],
        isolation: {
          codexHome: 'ephemeral-temporary-directory',
          authCopiedIntoEphemeralHome: true,
          ignoreUserConfig: true,
          ignoreRules: true,
          ephemeralSession: false,
          isolatedSessionCapturedBeforeCleanup: true,
          sandbox: 'workspace-write',
          approvalPolicy: 'never',
          emptyWorkspaceAtStart: emptyWorkspaceEntries.length === 0,
          finalWorkspaceEntries: workspaceEntries,
          onlyAgentFileCreated: workspaceFiles.length === 1 && workspaceFiles[0] === 'agent.js',
          appsEnabled: false,
          multiAgentEnabled: false,
          hooksEnabled: false,
          shellSnapshotEnabled: false,
          webSearch: 'disabled',
          configuredMcpServers: 0,
          hostHomeInherited: false,
          disabledSystemSkillFiles: skillFiles.length,
          allSystemSkillsDisabled: true,
          availableSkillCatalogPresent: nativeSession.availableSkillCatalogPresent,
          isolatedHomeEntriesAfterRun: isolatedHomeEntries,
        },
      },
      telemetry: {
        eventCount: telemetry.eventCount,
        eventTypes: telemetry.eventTypes,
        turnCount: telemetry.turnCount,
        toolCallCount: nativeSession.toolCallCount,
        toolCallBreakdown: nativeSession.toolCallBreakdown,
        cliToolItemCount: telemetry.cliToolItemCount,
        cliToolItemBreakdown: telemetry.cliToolItemBreakdown,
        mcpCallCount: nativeSession.mcpCallCount,
        inputTokens: telemetry.inputTokens,
        cachedInputTokens: telemetry.cachedInputTokens,
        outputTokens: telemetry.outputTokens,
        reasoningTokens: telemetry.reasoningTokens,
        totalTokens: telemetry.totalTokens,
      },
      authentication: {
        method: 'chatgpt',
        subscriptionAccess: true,
        apiKeyEnvironmentRemoved: true,
      },
      nativeSession: nativeSessionIdentity,
      prompt: { path: 'benchmark/challenges/chess-agent-v1.md', sha256: promptSha256 },
      agent: {
        path: `agents/model-suite/${entry.id}.js`,
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
  await requireChatGptAuthentication();
  const [prompt, positionsDocument] = await Promise.all([
    readFile(PROMPT_PATH, 'utf8'),
    readFile(POSITIONS_PATH, 'utf8').then(JSON.parse),
  ]);
  const promptSha256 = sha256(prompt);
  const globalConfigHashBefore = await optionalSha256(GLOBAL_CONFIG);
  await mkdir(AGENTS_DIR, { recursive: true });
  await rm(GENERATIONS_DIR, { recursive: true, force: true });
  await mkdir(GENERATIONS_DIR, { recursive: true });
  const generated = await Promise.all(MODELS.map((entry) => generateOne(entry, prompt, promptSha256, positionsDocument.positions)));
  const globalConfigHashAfter = await optionalSha256(GLOBAL_CONFIG);
  const manifest = {
    schemaVersion: 'agentbattler.agent-manifest.v1',
    manifestId: `codex-model-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    description: 'Local Codex model comparison generated from one fixed prompt at high reasoning in isolated empty workspaces.',
    comparison: {
      kind: 'model-comparison',
      harness: 'codex-cli',
      harnessVersion: CODEX_VERSION,
      reasoningEffort: REASONING_EFFORT,
      prompt: 'benchmark/challenges/chess-agent-v1.md',
      promptSha256,
    },
    agents: generated.map(({ entry, metadata }) => ({
      id: entry.id,
      displayName: entry.displayName,
      role: 'model-challenger',
      source: metadata.agent.path,
      sourceSha256: metadata.agent.sha256,
      provenance: {
        kind: 'codex-cli-generated',
        isFixture: false,
        generatedByHarness: true,
        harness: 'codex-cli',
        harnessVersion: CODEX_VERSION,
        modelRequested: entry.model,
        reasoningEffort: REASONING_EFFORT,
        prompt: 'benchmark/challenges/chess-agent-v1.md',
        promptSha256,
        generationMetadata: `results/model-suite/generations/${entry.id}/metadata.json`,
      },
    })),
  };
  await writeFile(path.join(AGENTS_DIR, 'manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);
  const suiteMetadata = {
    schemaVersion: 'agentbattler.codex-generation-suite.v1',
    generatedAt: new Date().toISOString(),
    models: MODELS.map(({ id, model }) => ({ id, model })),
    reasoningEffort: REASONING_EFFORT,
    authentication: {
      method: 'chatgpt',
      subscriptionAccess: true,
      apiKeyEnvironmentRemoved: true,
    },
    promptSha256,
    globalConfigHashBefore,
    globalConfigHashAfter,
    globalConfigUnchanged: globalConfigHashBefore === globalConfigHashAfter,
    totals: {
      runs: generated.length,
      durationMs: generated.reduce((sum, item) => sum + item.metadata.run.durationMs, 0),
      turns: generated.reduce((sum, item) => sum + item.metadata.telemetry.turnCount, 0),
      toolCalls: generated.reduce((sum, item) => sum + item.metadata.telemetry.toolCallCount, 0),
      mcpCalls: generated.reduce((sum, item) => sum + item.metadata.telemetry.mcpCallCount, 0),
      tokens: generated.reduce((sum, item) => sum + (item.metadata.telemetry.totalTokens ?? 0), 0),
    },
  };
  await writeFile(path.join(RESULT_ROOT, 'generation-suite.json'), `${canonicalJson(suiteMetadata, { space: 2 })}\n`);
  if (!suiteMetadata.globalConfigUnchanged) throw new Error('Global Codex config changed during isolated generation');
  for (const { entry, metadata } of generated) {
    console.log(`${entry.id}: ${metadata.agent.sizeBytes} bytes, ${metadata.probeSummary.passed}/${metadata.probeSummary.total} probes, ${metadata.telemetry.totalTokens} tokens, ${metadata.run.durationMs} ms`);
  }
  console.log(`Global Codex config unchanged: ${suiteMetadata.globalConfigUnchanged}`);
  console.log(`Manifest: ${path.join(AGENTS_DIR, 'manifest.json')}`);
}

main().catch((error) => {
  console.error(`AgentBattler generation: ${error.message}`);
  process.exitCode = 1;
});
