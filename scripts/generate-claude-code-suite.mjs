#!/usr/bin/env node
// Experimental third harness. It intentionally accepts an adapter binary only by explicit path.
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
import { canonicalJson, sha256, sha256File } from '../src/provenance.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const AGENTS_DIR = path.join(ROOT, 'agents/claude-code-model-suite');
const RESULT_ROOT = path.join(ROOT, 'results/claude-code-model-suite');
const GENERATIONS_DIR = path.join(RESULT_ROOT, 'generations');
const CODEX_AUTH = path.join(os.homedir(), '.codex/auth.json');
const ADAPTER_COMMIT = 'b5e9f0342a22c3566cd4c11a7ac1dcf58295248b';
const CLAUDE_VERSION = '2.1.211';
const REASONING_EFFORT = 'high';
const FAMILIES = [
  { id: 'terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  { id: 'sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { id: 'luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
];
const generationsPerModel = Number.parseInt(process.env.AGENTBATTLER_GENERATIONS_PER_MODEL ?? '5', 10);
const resume = process.env.AGENTBATTLER_RESUME === '1';
const adapterBinary = process.env.AGENTBATTLER_CLAUDE_ADAPTER_BIN;
const adapterPatchSha256 = process.env.AGENTBATTLER_CLAUDE_ADAPTER_PATCH_SHA256;
if (!adapterBinary || process.env.AGENTBATTLER_CLAUDE_ADAPTER_COMMIT !== ADAPTER_COMMIT || !adapterPatchSha256) {
  throw new Error('Set AGENTBATTLER_CLAUDE_ADAPTER_BIN, AGENTBATTLER_CLAUDE_ADAPTER_COMMIT, and AGENTBATTLER_CLAUDE_ADAPTER_PATCH_SHA256 from the completed local audit');
}
if (!Number.isSafeInteger(generationsPerModel) || generationsPerModel < 1) throw new Error('AGENTBATTLER_GENERATIONS_PER_MODEL must be positive');
const entries = Array.from({ length: generationsPerModel }, (_, index) => FAMILIES.map((family) => ({
  ...family,
  id: `claude-code-${family.id}-${String(index + 1).padStart(2, '0')}`,
  generationIndex: index + 1,
  displayName: `Claude Code / ${family.displayName} #${index + 1}`,
}))).flat();

function invariant(condition, message) { if (!condition) throw new Error(message); }
function run(command, args, { cwd, env, timeoutMs = 10 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 15_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  });
}
function jwtExpiry(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp; } catch { return null; }
}
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function health(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* wait for local process */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Loopback adapter did not become healthy');
}
function traceSummary(content, expectedModel) {
  const events = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = events.find((event) => event.type === 'result');
  invariant(init?.model === expectedModel, `Claude trace model is not ${expectedModel}`);
  invariant(init.analytics_disabled === true && init.product_feedback_disabled === true, 'Claude nonessential traffic was not disabled');
  invariant(Array.isArray(init.mcp_servers) && init.mcp_servers.length === 0, 'Claude trace has MCP servers');
  invariant(Array.isArray(init.plugins) && init.plugins.length === 0, 'Claude trace has plugins');
  invariant(Array.isArray(init.skills) && init.skills.length === 0, 'Claude trace has skills');
  invariant(result?.subtype === 'success' && result.is_error === false, 'Claude generation did not finish successfully');
  const tools = events.flatMap((event) => event.type === 'assistant' ? (event.message?.content ?? []) : [])
    .filter((item) => item.type === 'tool_use').map((item) => item.name);
  invariant(tools.every((name) => name === 'Write'), `Claude used unexpected tools: ${[...new Set(tools)].join(', ')}`);
  const usage = result.modelUsage?.[expectedModel] ?? {};
  return { eventCount: events.length, sessionId: result.session_id, turnCount: result.num_turns, toolCallCount: tools.length, resultText: result.result,
    toolCallBreakdown: Object.fromEntries([...new Set(tools)].map((name) => [name, tools.filter((value) => value === name).length])),
    inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), providerReportedModel: init.model };
}
async function probes(agentPath, positions) {
  return Promise.all(positions.map(async (position) => {
    const attempt = await runAgentMove({ agentPath, fen: position.fen });
    return { positionId: position.id, status: attempt.status, move: attempt.move, runtimeMs: attempt.runtimeMs, detail: attempt.detail,
      legal: attempt.status === 'ok' && isLegalUciMove(parseFen(position.fen), attempt.move) };
  }));
}
async function existingGeneration(entry) {
  if (!resume) return null;
  try {
    const metadata = JSON.parse(await readFile(path.join(GENERATIONS_DIR, entry.id, 'metadata.json'), 'utf8'));
    const identity = await validateAgent(path.join(AGENTS_DIR, `${entry.id}.js`));
    invariant(metadata.run?.modelRequested === entry.model && metadata.probeSummary?.allPassed === true, `Resume evidence is invalid for ${entry.id}`);
    invariant(identity.sourceSha256 === metadata.agent?.sha256, `Resume source hash differs for ${entry.id}`);
    return { entry, metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
async function main() {
  const [auth, prompt, positionsDocument, binarySha256] = await Promise.all([
    readFile(CODEX_AUTH, 'utf8').then(JSON.parse), readFile(PROMPT_PATH, 'utf8'), readFile(POSITIONS_PATH, 'utf8').then(JSON.parse), sha256File(adapterBinary),
  ]);
  invariant(auth?.auth_mode === 'chatgpt', 'Codex must be signed in with ChatGPT');
  invariant(typeof auth?.tokens?.access_token === 'string' && typeof auth?.tokens?.refresh_token === 'string', 'Codex OAuth tokens are unavailable');
  const expiry = jwtExpiry(auth.tokens.access_token);
  invariant(Number.isFinite(expiry) && expiry * 1000 > Date.now() + 10 * 60_000, 'Codex access token expires too soon; run codex login');
  const suiteRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-claude-code-'));
  const home = path.join(suiteRoot, 'home'); const adapterHome = path.join(home, '.claude-adapter');
  const workspace = path.join(suiteRoot, 'workspace'); const config = path.join(suiteRoot, 'adapter.toml');
  const listenPort = await port(); const baseUrl = `http://127.0.0.1:${listenPort}`;
  let adapter;
  try {
    await Promise.all([home, adapterHome, workspace, AGENTS_DIR, GENERATIONS_DIR].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    await writeFile(path.join(adapterHome, 'tokens-chatgpt.json'), `${canonicalJson({ access_token: auth.tokens.access_token, refresh_token: auth.tokens.refresh_token, expires_at: expiry }, { space: 2 })}\n`, { mode: 0o600 });
    await writeFile(config, `[server]\nhost = "127.0.0.1"\nport = ${listenPort}\nlog_level = "error"\nlog_file_enabled = false\nclaude_stream_idle_timeout_ms = 0\n\n[providers.chatgpt]\ntype = "chatgpt"\n\n[models]\ndefault_provider = "chatgpt"\ndefault_model = "gpt-5.6-terra"\n\n[models.routing]\n"gpt-5.6-terra" = { provider = "chatgpt", model = "gpt-5.6-terra" }\n"gpt-5.6-sol" = { provider = "chatgpt", model = "gpt-5.6-sol" }\n"gpt-5.6-luna" = { provider = "chatgpt", model = "gpt-5.6-luna" }\n`, { mode: 0o600 });
    await Promise.all([chmod(path.join(adapterHome, 'tokens-chatgpt.json'), 0o600), chmod(config, 0o600)]);
    adapter = spawn(adapterBinary, ['serve', '--config', config], { cwd: workspace, env: { PATH: process.env.PATH, HOME: home, RUST_LOG: 'error' }, stdio: ['ignore', 'ignore', 'ignore'] });
    await health(baseUrl);
    if (!resume) await rm(GENERATIONS_DIR, { recursive: true, force: true });
    await mkdir(GENERATIONS_DIR, { recursive: true });
    const completed = [];
    for (const entry of entries) {
      const existing = await existingGeneration(entry);
      if (existing) { console.log(`Reusing verified ${entry.id} from the interrupted suite.`); completed.push(existing); continue; }
      const generationDir = path.join(GENERATIONS_DIR, entry.id); await rm(generationDir, { recursive: true, force: true }); await mkdir(generationDir);
      const runWorkspace = path.join(workspace, entry.id); await mkdir(runWorkspace);
      const command = ['--bare', '--safe-mode', '--disable-slash-commands', '-p', '--verbose', '--model', entry.model, '--effort', REASONING_EFFORT, '--max-turns', '12', '--tools', 'Write', '--allowedTools', 'Write', '--no-session-persistence', '--output-format', 'stream-json', '--include-partial-messages', `${prompt}\n\nReturn only one complete executable JavaScript implementation as your final response. Do not use Markdown fences, explanations, or tools; the harness records this exact response as agent.js.`];
      console.log(`Generating ${entry.id} (${entry.model}) through loopback Claude Code gateway...`);
      const started = Date.now();
      const output = await run('claude', command, { cwd: runWorkspace, env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: path.join(home, 'tmp'), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'local-gateway-only',
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_BUG_COMMAND: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      } });
      const scrub = { homeDirectory: os.homedir(), username: os.userInfo().username };
      const trace = sanitizePublicTrace(output.stdout, scrub); const stderr = sanitizePublicTrace(output.stderr, scrub);
      await Promise.all([writeFile(path.join(generationDir, 'claude-events.jsonl'), trace.content), writeFile(path.join(generationDir, 'stderr.txt'), stderr.content)]);
      invariant(!output.timedOut, `${entry.id} exceeded the 10-minute generation timeout`);
      invariant(output.exitCode === 0, `${entry.id} exited ${output.exitCode}`);
      const telemetry = traceSummary(trace.content, entry.model);
      let contents = await readdir(runWorkspace, { withFileTypes: true });
      if (contents.length === 0) {
        invariant(typeof telemetry.resultText === 'string' && telemetry.resultText.length > 0 && !telemetry.resultText.includes('```'), `${entry.id} did not return plain JavaScript source`);
        await writeFile(path.join(runWorkspace, 'agent.js'), telemetry.resultText);
        contents = await readdir(runWorkspace, { withFileTypes: true });
      }
      invariant(contents.length === 1 && contents[0].isFile() && contents[0].name === 'agent.js', `${entry.id} did not leave exactly agent.js`);
      const target = path.join(AGENTS_DIR, `${entry.id}.js`); await copyFile(path.join(runWorkspace, 'agent.js'), target);
      const identity = await validateAgent(target); const legality = await probes(target, positionsDocument.positions);
      const metadata = { schemaVersion: 'agentbattler.claude-code-generation-metadata.v1', run: { modelRequested: entry.model, modelFamilyId: entry.id.split('-').at(-2), generationIndex: entry.generationIndex, reasoningEffort: REASONING_EFFORT, harness: 'claude-code', harnessVersion: CLAUDE_VERSION, provider: 'chatgpt-codex-via-third-party-messages-gateway', durationMs: Date.now() - started, exitCode: output.exitCode, command: ['claude', ...command.slice(0, -1), '<fixed-benchmark-prompt>'], isolation: { mechanism: 'empty-temp-home-and-workspace', loopbackGateway: baseUrl, adapterBindAddress: '127.0.0.1', hostHomeMounted: false, userClaudeMd: false, pluginsEnabled: false, hooksEnabled: false, mcpServers: 0, skillsEnabled: false, sessionsPersisted: false, allowedTools: ['Write'], webSearchEnabled: false } }, telemetry: { ...telemetry, mcpCallCount: 0, cachedInputTokens: 0, reasoningTokens: null }, authentication: { method: 'chatgpt-oauth-reused-ephemerally', subscriptionAccess: true, anthropicCredentialUsed: false, openAiApiKeyUsed: false }, adapter: { sourceCommit: ADAPTER_COMMIT, sourcePatchSha256: adapterPatchSha256, binarySha256, bindAddress: '127.0.0.1', logLevel: 'error', requestBodyLogging: false }, sanitization: { strategy: 'literal-host-identity-redaction', totalReplacements: trace.totalReplacements + stderr.totalReplacements }, nativeTrace: { path: `results/claude-code-model-suite/generations/${entry.id}/claude-events.jsonl`, sha256: sha256(trace.content), sizeBytes: Buffer.byteLength(trace.content) }, prompt: { path: 'benchmark/challenges/chess-agent-v1.md', sha256: sha256(prompt) }, agent: { path: `agents/claude-code-model-suite/${entry.id}.js`, sha256: identity.sourceSha256, sizeBytes: identity.sizeBytes }, probes: legality, probeSummary: { passed: legality.filter((probe) => probe.legal).length, total: legality.length, allPassed: legality.every((probe) => probe.legal) } };
      invariant(metadata.probeSummary.allPassed, `${entry.id} failed legality probes`);
      await writeFile(path.join(generationDir, 'metadata.json'), `${canonicalJson(metadata, { space: 2 })}\n`); completed.push({ entry, metadata });
    }
    const promptSha256 = sha256(prompt);
    const manifest = { schemaVersion: 'agentbattler.agent-manifest.v1', manifestId: `claude-code-model-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`, description: `${generationsPerModel} isolated Claude Code generations per model via a loopback third-party ChatGPT Codex Messages gateway.`, comparison: { kind: 'model-comparison', harness: 'claude-code', harnessVersion: CLAUDE_VERSION, provider: 'chatgpt-codex-via-third-party-messages-gateway', reasoningEffort: REASONING_EFFORT, generationsPerModel, prompt: 'benchmark/challenges/chess-agent-v1.md', promptSha256 }, agents: completed.map(({ entry, metadata }) => ({ id: entry.id, displayName: entry.displayName, modelFamilyId: entry.id.split('-').at(-2), generationIndex: entry.generationIndex, role: 'model-challenger', source: metadata.agent.path, sourceSha256: metadata.agent.sha256, provenance: { kind: 'claude-code-gateway-generated', isFixture: false, generatedByHarness: true, harness: 'claude-code', harnessVersion: CLAUDE_VERSION, provider: 'chatgpt-codex-via-third-party-messages-gateway', modelRequested: entry.model, modelFamilyId: entry.id.split('-').at(-2), generationIndex: entry.generationIndex, reasoningEffort: REASONING_EFFORT, prompt: 'benchmark/challenges/chess-agent-v1.md', promptSha256, generationMetadata: `results/claude-code-model-suite/generations/${entry.id}/metadata.json` } })) };
    await writeFile(path.join(AGENTS_DIR, 'manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);
    const totals = completed.reduce((sum, item) => ({ runs: sum.runs + 1, durationMs: sum.durationMs + item.metadata.run.durationMs, turns: sum.turns + item.metadata.telemetry.turnCount, toolCalls: sum.toolCalls + item.metadata.telemetry.toolCallCount, tokens: sum.tokens + item.metadata.telemetry.totalTokens }), { runs: 0, durationMs: 0, turns: 0, toolCalls: 0, tokens: 0 });
    await writeFile(path.join(RESULT_ROOT, 'generation-suite.json'), `${canonicalJson({ schemaVersion: 'agentbattler.claude-code-generation-suite.v1', generatedAt: new Date().toISOString(), generationsPerModel, families: FAMILIES, harness: { name: 'claude-code', version: CLAUDE_VERSION }, adapter: { sourceCommit: ADAPTER_COMMIT, sourcePatchSha256: adapterPatchSha256, binarySha256 }, reasoningEffort: REASONING_EFFORT, promptSha256, authentication: { method: 'chatgpt-oauth-reused-ephemerally', anthropicCredentialUsed: false, openAiApiKeyUsed: false }, isolation: { loopbackOnly: true, adapterBindAddress: '127.0.0.1', isolatedHome: true, telemetryDisabled: true, autoUpdateDisabled: true, tools: ['Write'] }, totals }, { space: 2 })}\n`);
    console.log(`Generated ${completed.length} Claude Code agents; manifest: ${path.join(AGENTS_DIR, 'manifest.json')}`);
  } finally {
    if (adapter?.pid) adapter.kill('SIGTERM');
    await rm(suiteRoot, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(`AgentBattler Claude Code generation: ${error.message}`); process.exitCode = 1; });
