import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDevinModelsAllowed,
  buildDevinCliArgs,
  buildDevinDockerArgs,
  buildIsolatedDevinConfig,
  DEVIN_HARNESS_NAME,
  DEVIN_HARNESS_VERSION,
  DEVIN_IMAGE,
  DEVIN_PERMISSION_MODE,
  FREE_DEVIN_MODELS,
  modelSlug,
  parseDevinExport,
  parseDevinVersion,
  publicDevinCommand,
  requireDevinAuthentication,
  resolveDevinRuntime,
} from '../src/devin-harness.mjs';

test('slugifies Devin model ids for agent paths', () => {
  assert.equal(modelSlug('swe-1-6-fast'), 'swe-1-6-fast');
  assert.equal(modelSlug('Claude Opus 4.6'), 'claude-opus-4-6');
  assert.throws(() => modelSlug('???'), /usable slug/);
});

test('builds a stripped isolated Devin config with no MCP or foreign imports', () => {
  const config = buildIsolatedDevinConfig({ model: 'swe-1.7' });
  assert.equal(config.agent.model, 'swe-1.7');
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.hooks, {});
  assert.equal(config.read_config_from.cursor, false);
  assert.equal(config.read_config_from.windsurf, false);
  assert.equal(config.read_config_from.claude, false);
  assert.equal(config.auto_update, false);
});

test('builds unattended Devin CLI args with export and stripped config', () => {
  const args = buildDevinCliArgs({
    model: 'swe-1.7',
    promptFile: '/repo/benchmark/challenges/chess-agent-v1.md',
    configPath: '/tmp/xdg-config/devin/config.json',
    exportPath: '/tmp/out/devin-export.json',
  });
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), [
    '--permission-mode', DEVIN_PERMISSION_MODE,
  ]);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'swe-1.7']);
  assert.ok(args.includes('--prompt-file'));
  assert.ok(args.includes('--export'));
  assert.equal(DEVIN_HARNESS_NAME, 'devin-cli');
});

test('redacts ephemeral paths in the public command', () => {
  const args = buildDevinCliArgs({
    model: 'opus',
    promptFile: '/repo/prompt.md',
    configPath: '/tmp/cfg/devin/config.json',
    exportPath: '/tmp/export.json',
  });
  const command = publicDevinCommand(args, {
    workspace: '/tmp/ws',
    configHome: '/tmp/cfg',
    dataHome: '/tmp/data',
    promptFile: '/repo/prompt.md',
  });
  assert.equal(command[0], 'devin');
  assert.ok(command.includes('<prompt-file>'));
  assert.ok(!command.some((value) => value.includes('/tmp/cfg')));
});

test('host-shaped public command redacts ephemeral export paths with host identity segments', () => {
  // Mirrors generateOneHost: export under the ephemeral tree, not results/.
  const tempRoot = '/tmp/agentbattler-devin-glm-5-2-high-01-abc123';
  const workspace = `${tempRoot}/workspace`;
  const configHome = `${tempRoot}/xdg-config`;
  const dataHome = `${tempRoot}/xdg-data`;
  const exportDir = `${tempRoot}/export`;
  const promptFile = '/home/lab/agentbattler-bench/benchmark/challenges/chess-agent-v1.md';
  const args = buildDevinCliArgs({
    model: 'glm-5.2-high',
    promptFile,
    configPath: `${configHome}/devin/config.json`,
    exportPath: `${exportDir}/devin-export.json`,
  });
  const command = publicDevinCommand(args, {
    workspace,
    configHome,
    dataHome,
    exportDir,
    promptFile,
  });
  assert.equal(command[0], 'devin');
  assert.ok(command.includes('<prompt-file>'));
  assert.ok(command.includes('<ephemeral-export>/devin-export.json'));
  assert.ok(!command.some((value) => value.includes('/home/lab')));
  assert.ok(!command.some((value) => value.includes(tempRoot)));
  assert.ok(!command.some((value) => value.includes('results/devin-suite')));
});

test('parses devin --version output', () => {
  assert.equal(parseDevinVersion('devin 3000.1.27 (0d4bf12e)'), '3000.1.27');
  assert.throws(() => parseDevinVersion('not a version'), /Could not parse/);
});

test('requires a logged-in Devin auth status', () => {
  assert.deepEqual(
    requireDevinAuthentication({
      exitCode: 0,
      stdoutText: 'Logged in (via Devin).\nTier:              Devin Pro\nPlan:              Pro\n',
    }),
    { method: 'devin-account', subscriptionAccess: true, provider: 'devin' },
  );
  assert.throws(
    () => requireDevinAuthentication({ exitCode: 1, stdoutText: 'Not logged in' }),
    /authentication failed/,
  );
});

test('extracts best-effort telemetry from ATIF-like export documents', () => {
  const exportDoc = {
    format: 'atif-test',
    sessionId: 'sess-1',
    model: 'swe-1.7',
    messages: [
      { role: 'user', content: 'prompt' },
      {
        role: 'assistant',
        model: 'swe-1.7',
        content: [{ type: 'toolCall', name: 'write', arguments: { path: 'agent.js' } }],
        usage: { input: 11, output: 22 },
      },
      { role: 'tool', tool_name: 'bash' },
    ],
  };
  const summary = parseDevinExport(JSON.stringify(exportDoc));
  assert.equal(summary.sessionId, 'sess-1');
  assert.equal(summary.model, 'swe-1.7');
  assert.equal(summary.toolCallCount, 2);
  assert.equal(summary.toolCallBreakdown.write, 1);
  assert.equal(summary.toolCallBreakdown.bash, 1);
  assert.equal(summary.totalTokens, 33);
  assert.equal(summary.mcpCallCount, 0);
});

test('handles empty export gracefully', () => {
  const summary = parseDevinExport('');
  assert.equal(summary.format, 'empty');
  assert.equal(summary.totalTokens, null);
  assert.equal(summary.toolCallCount, 0);
});

test('defaults to docker runtime and rejects unknown runtimes', () => {
  assert.equal(resolveDevinRuntime(undefined), 'docker');
  assert.equal(resolveDevinRuntime('host'), 'host');
  assert.throws(() => resolveDevinRuntime('firecracker'), /AGENTBATTLER_DEVIN_RUNTIME/);
});

test('builds Pi-grade Docker args with read-only image and ephemeral mounts only', () => {
  const args = buildDevinDockerArgs({
    model: 'swe-1.7',
    workspace: '/tmp/workspace',
    devinHome: '/tmp/devin-home',
    exportDir: '/tmp/export',
    promptFile: '/repo/benchmark/challenges/chess-agent-v1.md',
    user: '1000:1000',
  });
  assert.equal(args[0], 'run');
  assert.ok(args.includes(DEVIN_IMAGE));
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.ok(args.includes('no-new-privileges'));
  assert.equal(DEVIN_HARNESS_VERSION, '3000.1.27');
  const rwMounts = args.filter((value) => value.endsWith(':rw'));
  assert.deepEqual(rwMounts, [
    '/tmp/workspace:/workspace:rw',
    '/tmp/devin-home:/devin-home:rw',
    '/tmp/export:/export:rw',
  ]);
  assert.ok(args.some((value) => value.endsWith(':/prompt/chess-agent-v1.md:ro')));
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--permission-mode'));
  const publicCmd = publicDevinCommand(args, {
    workspace: '/tmp/workspace',
    devinHome: '/tmp/devin-home',
    exportDir: '/tmp/export',
    promptFile: '/repo/benchmark/challenges/chess-agent-v1.md',
    prefix: ['docker'],
  });
  assert.equal(publicCmd[0], 'docker');
  assert.ok(!publicCmd.some((value) => value.includes('/tmp/workspace')));
});

test('parses ATIF-v1.x Devin CLI export documents', () => {
  const atif = {
    schema_version: 'ATIF-v1.7',
    session_id: 'married-lock',
    agent: { name: 'devin', version: '3000.1.27', model_name: 'SWE-1.7' },
    steps: [
      {
        type: 'assistant',
        tool_calls: [
          { function_name: 'write' },
          { function_name: 'exec' },
        ],
      },
      { type: 'tool_result' },
    ],
    final_metrics: {
      total_prompt_tokens: 100,
      total_completion_tokens: 20,
      total_cached_tokens: 50,
      total_steps: 2,
    },
  };
  const summary = parseDevinExport(JSON.stringify(atif));
  assert.equal(summary.format, 'ATIF-v1.7');
  assert.equal(summary.sessionId, 'married-lock');
  assert.equal(summary.model, 'SWE-1.7');
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.toolCallCount, 2);
  assert.equal(summary.toolCallBreakdown.write, 1);
  assert.equal(summary.toolCallBreakdown.exec, 1);
  assert.equal(summary.inputTokens, 100);
  assert.equal(summary.outputTokens, 20);
  assert.equal(summary.cachedInputTokens, 50);
  assert.equal(summary.totalTokens, 120);
});

test('free-model allowlist is fail-closed; bare glm-5.2 requires paid opt-in', () => {
  assert.ok(FREE_DEVIN_MODELS.includes('glm-5.2-high'));
  assert.ok(!FREE_DEVIN_MODELS.includes('glm-5.2'));
  assert.deepEqual(
    assertDevinModelsAllowed(['swe-1.7', 'glm-5.2-high', 'kimi-k2.7']),
    ['swe-1.7', 'glm-5.2-high', 'kimi-k2.7'],
  );
  assert.throws(
    () => assertDevinModelsAllowed(['glm-5.2']),
    /non-allowlisted|glm-5\.2/,
  );
  assert.throws(
    () => assertDevinModelsAllowed(['kimi-k2.6']),
    /non-allowlisted/,
  );
  assert.throws(
    () => assertDevinModelsAllowed(['mistral-large']),
    /non-allowlisted/,
  );
  assert.throws(
    () => assertDevinModelsAllowed(['swe-1.6-fast']),
    /non-allowlisted/,
  );
  assert.deepEqual(
    assertDevinModelsAllowed(['glm-5.2', 'swe-1.6-fast'], { allowPaid: true }),
    ['glm-5.2', 'swe-1.6-fast'],
  );
});
