import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';

import * as all from '../scripts/terminal-adapter-all.mjs';
import * as claude from '../scripts/terminal-adapter-claude.mjs';
import * as dotagents from '../scripts/terminal-adapter-dotagents.mjs';
import * as droid from '../scripts/terminal-adapter-droid.mjs';
import * as harbor from '../scripts/terminal-adapter-harbor.mjs';
import { CANDIDATE_NODE_OPTIONS, candidateSpawnOptions } from '../benchmark/challenges/candidate-process.mjs';
import { isContextOverflowResponse, normalizeContextOverflow, startAnthropicOverflowCompat } from '../src/anthropic-overflow-compat.mjs';
import { claudeCompactionPolicy, claudeCompactionTelemetry } from '../src/claude-compaction.mjs';
import { bindTerminalHarnessRuntime, SEALED_TERMINAL_HARNESS_VERSIONS } from '../src/terminal-harness-versions.mjs';

test('all terminal harness adapters advertise the exhaustive matrix roster', () => {
  assert.deepEqual(all.harnesses, ['claude-code', 'codex-cli', 'dotagents-mono', 'factory-droid', 'pi-coding-agent']);
  assert.deepEqual(claude.harnesses, ['claude-code']);
  assert.deepEqual(harbor.harnesses, ['claude-code', 'codex-cli', 'pi-coding-agent']);
  assert.deepEqual(dotagents.harnesses, ['dotagents-mono']);
  assert.deepEqual(droid.harnesses, ['factory-droid']);
});

test('Harbor V4 invocation is pinned, containerized, and resumable', () => {
  const args = harbor.buildHarborArgs({
    job: { harness: 'codex-cli', model: 'gpt-5.6-sol', maxWallTimeMs: 1_800_000 },
    trialsDir: '/tmp/trials',
    trialName: 'isolation-check',
  });
  assert.deepEqual(args.slice(0, 3), ['--from', 'harbor==0.20.0', 'harbor']);
  assert.ok(args.includes('--resume-trajectory'));
  assert.equal(args[args.indexOf('--env') + 1], 'docker');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(args[args.indexOf('--agent-timeout') + 1], '1800');
  assert.ok(args.some((value) => value.endsWith('/.codex/auth.json') && value.startsWith('CODEX_AUTH_JSON_PATH=')));
  assert.ok(!args.includes('CODEX_FORCE_AUTH_JSON=true'));
  assert.ok(args.includes('reasoning_effort=high'));
});

test('Harbor maps the sealed max reasoning level into every native harness', () => {
  for (const [harness, expected] of [
    ['claude-code', 'reasoning_effort=max'],
    ['codex-cli', 'reasoning_effort=max'],
    ['pi-coding-agent', 'thinking=max'],
  ]) {
    const args = harbor.buildHarborArgs({
      job: { harness, model: 'gpt-5.6-luna', reasoningEffort: 'max', maxWallTimeMs: 3_600_000 },
      trialsDir: '/tmp/trials',
      trialName: `max-${harness}`,
    });
    assert.ok(args.includes(expected));
    assert.equal(args[args.indexOf('--model') + 1], harness === 'pi-coding-agent' ? 'openai-codex/gpt-5.6-luna' : 'gpt-5.6-luna');
    assert.equal(args[args.indexOf('--agent-timeout') + 1], '3600');
  }
});

test('terminal schedules bind declared harness versions to launched runtimes', () => {
  assert.deepEqual(SEALED_TERMINAL_HARNESS_VERSIONS, {
    'claude-code': '2.1.220',
    'codex-cli': '0.144.0',
    'dotagents-mono': '1.1.9',
    'factory-droid': '0.186.0',
    'pi-coding-agent': '0.80.7',
  });
  const rebound = bindTerminalHarnessRuntime({ provenance: { harness: 'claude-code', harnessVersion: '2.1.211' } });
  assert.equal(rebound.provenance.harnessVersion, '2.1.220');
  assert.equal(rebound.provenance.sourceArtifactHarnessVersion, '2.1.211');
  assert.throws(() => bindTerminalHarnessRuntime({ provenance: { harness: 'new-harness', harnessVersion: '1.0.0' } }), /No sealed terminal runtime version/);
});

test('Harbor Pi uses the pinned AgentBattler fork and native session adapter', async () => {
  const args = harbor.buildHarborArgs({
    job: { harness: 'pi-coding-agent', model: 'gpt-5.6-sol', maxWallTimeMs: 1_800_000 },
    trialsDir: '/tmp/trials',
    trialName: 'pi-check',
  });
  assert.equal(args[args.indexOf('--agent') + 1], 'benchmark.harbor.pi_agent:AgentBattlerPi');
  assert.equal(args[args.indexOf('--model') + 1], 'openai-codex/gpt-5.6-sol');
  assert.ok(args.includes('version=0.80.7'));
  assert.ok(args.some((value) => value.endsWith('/.codex/auth.json') && value.startsWith('CODEX_AUTH_JSON_PATH=')));
  const source = await readFile(path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'pi_agent.py'), 'utf8');
  assert.match(source, /@earendil-works\/pi-coding-agent/);
  assert.match(source, /--session/);
  assert.match(source, /--continue/);
  assert.match(source, /"max"/);
  assert.match(source, /self\.build_cli_flags\(\)/);
  assert.match(source, /upload_file/);
  assert.doesNotMatch(source, /! grep -q .*stopReason/);
});

test('Harbor Claude terminates the native CLI after a terminal result event', async () => {
  const args = harbor.buildHarborArgs({
    job: { harness: 'claude-code', model: 'gpt-5.6-sol', maxWallTimeMs: 1_800_000 },
    trialsDir: '/tmp/trials',
    trialName: 'claude-check',
  });
  assert.equal(args[args.indexOf('--agent') + 1], 'benchmark.harbor.claude_agent:AgentBattlerClaude');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.ok(args.includes('version=2.1.220'));
  assert.ok(!args.includes('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=4'));
  assert.ok(!args.includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000'));
  assert.ok(!args.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000'));
  assert.ok(!args.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80'));
  const source = await readFile(path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'claude_agent.py'), 'utf8');
  assert.match(source, /CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY="4"/);
  assert.match(source, /CLAUDE_CODE_MAX_CONTEXT_TOKENS="200000"/);
  assert.match(source, /CLAUDE_CODE_AUTO_COMPACT_WINDOW="200000"/);
  assert.match(source, /CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="80"/);
  assert.match(source, /claude-agentbattler-real/);
  assert.match(source, /event\.type === "result"/);
  assert.match(source, /kill -TERM -- "-\$agent_pid"/);
  assert.match(source, /result\.is_error !== true/);
  assert.match(source, /trap 'exit 143' TERM/);
  assert.match(source, /wait "\$agent_pid" 2>\/dev\/null \|\| true/);
  assert.match(source, /\.claude-agentbattler-active\.pid/);
  assert.match(source, /mkdir -p "\$\(dirname "\$active"\)"/);
  assert.match(source, /kill -TERM "\$previous"/);
  assert.match(source, /pkill -TERM -f "\^\$real\( \|\$\)"/);
});

test('DotAgents turn streaming tolerates quiet SSE intervals without fetch body timeouts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-dotagents-stream-'));
  const outputPath = path.join(root, 'turn.jsonl');
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'progress', data: { conversationId: 'conv-1', steps: [] } })}\n\n`);
    setTimeout(() => {
      response.end(`data: ${JSON.stringify({ type: 'done', data: { conversation_id: 'conv-1', conversation_history: [] } })}\n\n`);
    }, 75);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await dotagents.streamTurn({
      port: server.address().port,
      apiKey: 'test-key',
      prompt: 'test',
      conversationId: null,
      timeoutMs: 1_000,
      outputPath,
    });
    assert.equal(result.events.some((event) => event.type === 'done'), true);
    assert.match(await readFile(outputPath, 'utf8'), /"type":"done"/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude compaction policy is explicit per model and fails closed for new models', () => {
  assert.deepEqual(claudeCompactionPolicy('gpt-5.6-sol'), {
    version: 'model-window-v2',
    model: 'gpt-5.6-sol',
    contextWindowTokens: 200_000,
    autoCompactWindowTokens: 200_000,
    autoCompactPercent: 80,
    autoCompactTriggerTokens: 160_000,
    environmentVariables: {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
    },
  });
  assert.throws(() => claudeCompactionPolicy('gpt-next'), /calibrate the model/);
});

test('Claude compaction telemetry records native boundaries and pre/post token counts', () => {
  const telemetry = claudeCompactionTelemetry([
    { type: 'assistant', message: { usage: { input_tokens: 180_000, cache_read_input_tokens: 5_000 } } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-26T00:00:00.000Z', compact_metadata: { trigger: 'auto' } },
    { type: 'assistant', message: { usage: { input_tokens: 22_000 } } },
  ]);
  assert.deepEqual(telemetry, { count: 1, boundaries: [{ index: 1, timestamp: '2026-07-26T00:00:00.000Z', trigger: 'auto', beforeTokens: 185_000, afterTokens: 22_000 }] });
});

test('overflow compatibility recognizes context errors and emits Anthropic prompt-too-long structure', () => {
  const body = { error: { message: 'maximum context length exceeded' } };
  assert.equal(isContextOverflowResponse(400, body), true);
  assert.deepEqual(normalizeContextOverflow(400, body, 'req-1'), {
    status: 400,
    body: {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Prompt is too long: the input exceeds the model context window. Upstream response: maximum context length exceeded' },
      request_id: 'req-1',
    },
  });
  assert.equal(normalizeContextOverflow(400, { error: { message: 'request too large' } }), null);
  assert.equal(normalizeContextOverflow(413, { error: { message: 'request too large' } }), null);
  assert.equal(normalizeContextOverflow(429, { error: { message: 'rate limited' } }), null);
});

test('overflow compatibility proxy preserves success and translates only context overflow', async () => {
  const upstream = createServer((request, response) => {
    if (request.url === '/overflow') {
      response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req-overflow' });
      response.end(JSON.stringify({ error: { message: 'prompt is too long for this context window' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startAnthropicOverflowCompat({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
  try {
    const success = await fetch(`${proxy.baseUrl}/ok`);
    assert.equal(success.status, 200); assert.deepEqual(await success.json(), { ok: true });
    const overflow = await fetch(`${proxy.baseUrl}/overflow`);
    assert.equal(overflow.status, 400);
    assert.equal((await overflow.json()).error.type, 'invalid_request_error');
    assert.deepEqual(proxy.stats, { requests: 2, translatedContextOverflows: 1 });
  } finally {
    await proxy.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test('Harbor Claude lease terminates a predecessor before the next turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-claude-lease-'));
  const source = await readFile(path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'claude_agent.py'), 'utf8');
  const wrapperSource = source.match(/^_WRAPPER = r"""([\s\S]*?)^"""$/m)?.[1];
  assert.ok(wrapperSource, 'Claude wrapper source was not found');
  const wrapper = path.join(root, 'claude');
  const real = path.join(root, '.local', 'bin', 'claude-agentbattler-real');
  const waitFor = async (condition, message) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
  };
  const exited = (child) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude wrapper did not exit'));
    }, 10_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  try {
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(wrapper, wrapperSource);
    await writeFile(real, `#!/usr/bin/env bash
if [[ ! -f "$HOME/first.pid" ]]; then
  echo $$ > "$HOME/first.pid"
  sleep 300
else
  echo $$ > "$HOME/second.pid"
  echo '{"type":"result","is_error":false}'
  sleep 300
fi
`);
    await chmod(wrapper, 0o755); await chmod(real, 0o755);
    const env = { ...process.env, HOME: root };
    const first = spawn(wrapper, ['--fake'], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    first.stdin.end();
    await waitFor(async () => {
      try { await readFile(path.join(root, 'first.pid')); return true; } catch { return false; }
    }, 'first Claude process did not start');
    const firstExit = exited(first);
    const second = spawn(wrapper, ['--fake'], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    second.stdin.end();
    const secondResult = await exited(second);
    assert.equal(secondResult.code, 0);
    await firstExit;
    const firstPid = Number.parseInt(await readFile(path.join(root, 'first.pid'), 'utf8'), 10);
    assert.throws(() => process.kill(firstPid, 0), /ESRCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated Harbor V4 task uses fifteen steps and a separate verifier', async () => {
  const taskRoot = path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'mini-ledger-v4');
  const config = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  assert.equal((config.match(/\[\[steps\]\]/g) ?? []).length, 15);
  assert.match(config, /environment_mode = "separate"/);
  assert.match(config, /artifacts = \[\{ source = "\/app"/);
  assert.match(config, /agent_time_policy = "self-terminating"/);
  assert.doesNotMatch(config, /\[agent\]\ntimeout_sec/);
  assert.doesNotMatch(config, /\[steps\.agent\]\ntimeout_sec/);
  const verifierScript = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'tests', 'test.sh'), 'utf8');
  const verifierCompose = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'tests', 'docker-compose.yaml'), 'utf8');
  assert.match(verifierScript, /iptables -P OUTPUT DROP/);
  assert.match(verifierScript, /chown -hR 1000:1000 \/app/);
  assert.match(verifierCompose, /NET_ADMIN/);
  const firstPrompt = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'instruction.md'), 'utf8');
  assert.doesNotMatch(firstPrompt, /holdout-verifier|benchmark\/challenges/);
});

test('generated Harbor V5 task gives every turn the sealed 30-minute notice', async () => {
  const taskRoot = path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'mini-ledger-v5-r2');
  const config = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  assert.equal((config.match(/\[\[steps\]\]/g) ?? []).length, 15);
  assert.match(config, /challenge = "mini-ledger-v5"/);
  assert.match(config, /agent_time_policy = "hard-30-minutes-per-turn-with-agent-notice"/);
  assert.match(config, /protocol_revision = "r2"/);
  assert.match(config, /verifier_workspace_policy = "source-only-per-stage-and-holdout-case"/);
  for (const entry of await import('node:fs/promises').then(({ readdir }) => readdir(path.join(taskRoot, 'steps'), { withFileTypes: true }))) {
    if (!entry.isDirectory()) continue;
    const prompt = await readFile(path.join(taskRoot, 'steps', entry.name, 'instruction.md'), 'utf8');
    assert.match(prompt, /hard 30-minute wall-clock limit enforced by the benchmark/);
    assert.match(prompt, /leave the workspace in a runnable state before the limit/);
    assert.match(prompt, /query emits the event array directly/);
  }
});

test('generated Harbor V5 R4 task declares the harness reliability revision', async () => {
  const taskRoot = path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'mini-ledger-v5-r4');
  const config = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  assert.match(config, /version = "5\.3\.0"/);
  assert.match(config, /protocol_revision = "r4"/);
  const candidateProcess = await readFile(path.join(taskRoot, 'tests', 'candidate-process.mjs'), 'utf8');
  assert.match(candidateProcess, /removeCandidateWorkspace/);
  assert.match(candidateProcess, /cleanup deferred/);
});

test('generated Harbor V5 R5 task declares the Droid harness revision', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '..', 'scripts', 'build-harbor-terminal-task.mjs'), 'utf8');
  assert.match(source, /protocolRevision === 'r5' \? '5\.4\.0'/);
});

test('generated Harbor V6 task archives every candidate and reevaluates final correctness', async () => {
  const taskRoot = path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'mini-ledger-v6');
  const config = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  assert.equal((config.match(/\[\[steps\]\]/g) ?? []).length, 15);
  assert.match(config, /version = "6\.0\.0"/);
  assert.match(config, /agent_time_policy = "hard-60-minutes-per-turn-with-agent-notice"/);
  assert.match(config, /primary_score_policy = "final-public-matrix-plus-holdout"/);
  assert.match(config, /candidate_snapshot_policy = "every-turn-exact-ledger-source"/);
  assert.match(config, /candidate_network_policy = "node-permission-model-deny-network-and-child-process"/);
  const runner = await readFile(path.join(taskRoot, 'tests', 'run-stage.mjs'), 'utf8');
  assert.match(runner, /candidateSnapshotsRequired = true/);
  assert.match(runner, /finalPublicRequired = true/);
  assert.match(runner, /candidate-ledger\.mjs/);
  assert.match(runner, /all-public-stages-from-final-source-only-candidate/);
  assert.match(runner, /nodePermissionModel: true/);
  const candidateProcess = await readFile(path.join(taskRoot, 'tests', 'candidate-process.mjs'), 'utf8');
  assert.match(candidateProcess, /--permission --allow-fs-read=\. --allow-fs-write=\./);
  const firstPrompt = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'instruction.md'), 'utf8');
  assert.match(firstPrompt, /must never be embedded as source defaults/);
  assert.match(firstPrompt, /hard 60-minute wall-clock limit enforced by the benchmark/);
});

test('candidate verifier process identity is opt-in and validated', () => {
  const previousUid = process.env.AGENTBATTLER_CANDIDATE_UID;
  const previousGid = process.env.AGENTBATTLER_CANDIDATE_GID;
  try {
    delete process.env.AGENTBATTLER_CANDIDATE_UID;
    delete process.env.AGENTBATTLER_CANDIDATE_GID;
    assert.deepEqual(candidateSpawnOptions(), { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_OPTIONS: CANDIDATE_NODE_OPTIONS } });
    process.env.AGENTBATTLER_CANDIDATE_UID = '1000';
    process.env.AGENTBATTLER_CANDIDATE_GID = '1001';
    assert.deepEqual(candidateSpawnOptions(), { uid: 1000, gid: 1001, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_OPTIONS: CANDIDATE_NODE_OPTIONS } });
    process.env.AGENTBATTLER_CANDIDATE_UID = 'root';
    assert.throws(() => candidateSpawnOptions(), /positive integers/);
  } finally {
    if (previousUid === undefined) delete process.env.AGENTBATTLER_CANDIDATE_UID; else process.env.AGENTBATTLER_CANDIDATE_UID = previousUid;
    if (previousGid === undefined) delete process.env.AGENTBATTLER_CANDIDATE_GID; else process.env.AGENTBATTLER_CANDIDATE_GID = previousGid;
  }
});

test('candidate verifier process denies network and outside-workspace files at the Node runtime boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-candidate-permission-'));
  try {
    await writeFile(path.join(root, 'allowed.txt'), 'allowed');
    const result = await new Promise((resolve, reject) => {
      const stdout = [];
      const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); console.log(fs.readFileSync('allowed.txt', 'utf8')); try { fs.readFileSync('/etc/hosts'); process.exit(8); } catch (error) { console.log(error.code); } fetch('https://example.com').then(() => process.exit(9), error => { console.log(error.cause?.code ?? error.code ?? error.name); })"], {
        ...candidateSpawnOptions(),
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8') }));
    });
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /^allowed\nERR_ACCESS_DENIED\nERR_ACCESS_DENIED\n$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Harbor importer proves resume and does not double-count cumulative traces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-harbor-import-'));
  try {
    const stageIds = Array.from({ length: 15 }, (_, index) => `stage-${index + 1}`);
    const stepResults = [];
    for (let index = 0; index < stageIds.length; index += 1) {
      const stepName = `${String(index + 1).padStart(2, '0')}-${stageIds[index]}`;
      const agent = path.join(root, 'steps', stepName, 'agent');
      const verifier = path.join(root, 'steps', stepName, 'verifier');
      await mkdir(agent, { recursive: true });
      await mkdir(verifier, { recursive: true });
      await writeFile(path.join(agent, 'trajectory.json'), JSON.stringify({
        session_id: 'one-native-session',
        steps: Array.from({ length: index + 1 }, (_, stepIndex) => ({
          step_id: stepIndex + 1,
          tool_calls: [{ tool_call_id: `tool-${stepIndex + 1}` }],
        })),
        final_metrics: {
          total_prompt_tokens: (index + 1) * 100,
          total_cached_tokens: (index + 1) * 10,
          total_completion_tokens: (index + 1) * 20,
          extra: { reasoning_output_tokens: (index + 1) * 5 },
        },
      }));
      await writeFile(path.join(verifier, 'stage-result.json'), JSON.stringify({
        stage: { id: stageIds[index], passed: true, regressions: 0, exitCode: 0, durationMs: 1, diagnostic: null },
        holdout: index === 14 ? { passed: 9, total: 11, cases: [] } : null,
      }));
      stepResults.push({
        step_name: stepName,
        exception_info: index === 7 ? { exception_type: 'AgentTimeoutError', exception_message: 'Agent execution timed out after 1200.0 seconds' } : null,
        agent_result: { n_input_tokens: (index + 1) * 100, n_cache_tokens: (index + 1) * 10, n_output_tokens: (index + 1) * 20 },
        agent_execution: { started_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`, finished_at: `2026-01-01T00:00:${String(index + 1).padStart(2, '0')}Z` },
        verifier_result: { rewards: { reward: 1 } },
      });
    }
    const imported = await harbor.importHarborResult({
      raw: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z', trial_uri: 'file:///trial', step_results: stepResults },
      trialRoot: root,
      challenge: { stages: stageIds.map((id) => ({ id })), verifiers: { holdout: { cases: 11 } } },
      job: { harness: 'codex-cli', model: 'gpt-test', challengeStageIds: stageIds },
      harnessVersion: '0.test',
    });
    assert.equal(imported.sameSessionProof, true);
    assert.equal(imported.adapter.cumulativeTrajectories, true);
    assert.deepEqual(imported.usage, { inputTokens: 1500, cachedInputTokens: 150, outputTokens: 300, reasoningTokens: 75 });
    assert.deepEqual(imported.turns[0].usage, { inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
    assert.deepEqual(imported.turns[14].usage, { inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
    assert.equal(imported.turns[7].timedOut, true);
    assert.equal(imported.turns[7].exitCode, null);
    assert.equal(imported.adapter.timedOutTurns, 1);
    assert.equal(imported.toolCalls, 15);
    assert.equal(imported.holdout.passed, 9);
    const broken = structuredClone(stepResults);
    broken[7].exception_info = { exception_type: 'EnvironmentError', exception_message: 'container disappeared' };
    await assert.rejects(harbor.importHarborResult({
      raw: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z', trial_uri: 'file:///trial', step_results: broken },
      trialRoot: root,
      challenge: { stages: stageIds.map((id) => ({ id })), verifiers: { holdout: { cases: 11 } } },
      job: { harness: 'codex-cli', model: 'gpt-test', challengeStageIds: stageIds },
      harnessVersion: '0.test',
    }), /Harbor step 08-stage-8 failed: container disappeared/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Harbor importer uses native Pi JSONL for continuity and tool evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-harbor-pi-import-'));
  try {
    const stageIds = Array.from({ length: 15 }, (_, index) => `stage-${index + 1}`);
    const stepResults = [];
    for (let index = 0; index < stageIds.length; index += 1) {
      const stepName = `${String(index + 1).padStart(2, '0')}-${stageIds[index]}`;
      const agent = path.join(root, 'steps', stepName, 'agent');
      const verifier = path.join(root, 'steps', stepName, 'verifier');
      await mkdir(agent, { recursive: true }); await mkdir(verifier, { recursive: true });
      await writeFile(path.join(agent, 'pi.txt'), [
        JSON.stringify({ type: 'session', id: 'one-pi-native-session' }),
        JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' }),
        JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 10, cacheRead: 5, output: 2, reasoning: 1 } } }),
        JSON.stringify({ type: 'agent_end' }),
      ].join('\n'));
      await writeFile(path.join(verifier, 'stage-result.json'), JSON.stringify({
        stage: { id: stageIds[index], passed: true, regressions: 0, exitCode: 0, durationMs: 1 },
        holdout: index === 14 ? { passed: 11, total: 11, cases: [] } : null,
      }));
      stepResults.push({ step_name: stepName, agent_result: { n_input_tokens: 10, n_output_tokens: 2 }, agent_execution: {}, verifier_result: { rewards: { reward: 1 } } });
    }
    const imported = await harbor.importHarborResult({
      raw: { started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z', step_results: stepResults },
      trialRoot: root,
      challenge: { stages: stageIds.map((id) => ({ id })), verifiers: { holdout: { cases: 11 } } },
      job: { harness: 'pi-coding-agent', model: 'gpt-test', challengeStageIds: stageIds },
      harnessVersion: '0.80.7',
    });
    assert.equal(imported.sessionId, 'one-pi-native-session');
    assert.equal(imported.sameSessionProof, true);
    assert.equal(imported.toolCalls, 15);
    assert.deepEqual(imported.usage, { inputTokens: 225, cachedInputTokens: 75, outputTokens: 30, reasoningTokens: 15 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
