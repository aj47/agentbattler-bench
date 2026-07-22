import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as all from '../scripts/terminal-adapter-all.mjs';
import * as claude from '../scripts/terminal-adapter-claude.mjs';
import * as dotagents from '../scripts/terminal-adapter-dotagents.mjs';
import * as harbor from '../scripts/terminal-adapter-harbor.mjs';
import { candidateSpawnOptions } from '../benchmark/challenges/candidate-process.mjs';

test('all terminal harness adapters advertise the exhaustive matrix roster', () => {
  assert.deepEqual(all.harnesses, ['claude-code', 'codex-cli', 'dotagents-mono', 'pi-coding-agent']);
  assert.deepEqual(claude.harnesses, ['claude-code']);
  assert.deepEqual(harbor.harnesses, ['claude-code', 'codex-cli', 'pi-coding-agent']);
  assert.deepEqual(dotagents.harnesses, ['dotagents-mono']);
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
  assert.ok(args.some((value) => value.endsWith('/.codex/auth.json') && value.startsWith('CODEX_AUTH_JSON_PATH=')));
  assert.ok(!args.includes('CODEX_FORCE_AUTH_JSON=true'));
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
  assert.match(source, /upload_file/);
});

test('generated Harbor V4 task uses fifteen steps and a separate verifier', async () => {
  const taskRoot = path.resolve(import.meta.dirname, '..', 'benchmark', 'harbor', 'mini-ledger-v4');
  const config = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
  assert.equal((config.match(/\[\[steps\]\]/g) ?? []).length, 15);
  assert.match(config, /environment_mode = "separate"/);
  assert.match(config, /artifacts = \[\{ source = "\/app"/);
  const verifierScript = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'tests', 'test.sh'), 'utf8');
  const verifierCompose = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'tests', 'docker-compose.yaml'), 'utf8');
  assert.match(verifierScript, /iptables -P OUTPUT DROP/);
  assert.match(verifierCompose, /NET_ADMIN/);
  const firstPrompt = await readFile(path.join(taskRoot, 'steps', '01-foundation', 'instruction.md'), 'utf8');
  assert.doesNotMatch(firstPrompt, /holdout-verifier|benchmark\/challenges/);
});

test('candidate verifier process identity is opt-in and validated', () => {
  const previousUid = process.env.AGENTBATTLER_CANDIDATE_UID;
  const previousGid = process.env.AGENTBATTLER_CANDIDATE_GID;
  try {
    delete process.env.AGENTBATTLER_CANDIDATE_UID;
    delete process.env.AGENTBATTLER_CANDIDATE_GID;
    assert.deepEqual(candidateSpawnOptions(), {});
    process.env.AGENTBATTLER_CANDIDATE_UID = '1000';
    process.env.AGENTBATTLER_CANDIDATE_GID = '1001';
    assert.deepEqual(candidateSpawnOptions(), { uid: 1000, gid: 1001 });
    process.env.AGENTBATTLER_CANDIDATE_UID = 'root';
    assert.throws(() => candidateSpawnOptions(), /positive integers/);
  } finally {
    if (previousUid === undefined) delete process.env.AGENTBATTLER_CANDIDATE_UID; else process.env.AGENTBATTLER_CANDIDATE_UID = previousUid;
    if (previousGid === undefined) delete process.env.AGENTBATTLER_CANDIDATE_GID; else process.env.AGENTBATTLER_CANDIDATE_GID = previousGid;
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
    assert.equal(imported.toolCalls, 15);
    assert.equal(imported.holdout.passed, 9);
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
  } finally { await rm(root, { recursive: true, force: true }); }
});
