import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  materializeGoldImplementationB,
  prepareGoldImplementationBPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs';
import { verifyPhase } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';

async function workspaceFor(pack) {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-gold-b-'));
  await materializeGoldImplementationB({ destination, pack });
  return destination;
}

test('independent gold implementation B satisfies the sealed phase contracts', { timeout: 120_000 }, async (context) => {
  const pack = loadV7Pack('dev-02', { variant: 'decoy' });

  for (const phase of [1, 2, 5]) {
    await context.test(`phase ${phase} scores every requirement`, async () => {
      const workspace = await workspaceFor(pack);
      try {
        const result = await verifyPhase({ pack, phase, candidateTree: workspace, workspace, verifierSeedIndex: 7 });
        assert.equal(result.score, result.maxScore, JSON.stringify(result.requirements.filter(({ passed }) => !passed)));
        assert.deepEqual(result.infrastructureErrors, []);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

  await context.test('phase 3 serializes native processes and proves durability when strace is available', async () => {
    const workspace = await workspaceFor(pack);
    const traceDirectory = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-gold-b-traces-'));
    try {
      const result = await verifyPhase({
        pack,
        phase: 3,
        candidateTree: workspace,
        workspace,
        verifierSeedIndex: 7,
        durabilityTraceDirectory: traceDirectory,
      });
      assert.equal(result.requirements[0].passed, true);
      assert.equal(result.requirements[1].passed, true);
      const hasStrace = spawnSync('strace', ['--version'], { stdio: 'ignore' }).status === 0;
      if (hasStrace) {
        assert.equal(result.score, result.maxScore, JSON.stringify(result.requirements.filter(({ passed }) => !passed)));
        assert.deepEqual(result.infrastructureErrors, []);
      } else {
        assert.equal(result.requirements[2].passed, false);
        assert.match(result.requirements[2].diagnostic, /strace is unavailable/);
        assert.equal(result.infrastructureErrors[0].requirementId, 'V7-P3-PRIVATE-TERMINATION');
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(traceDirectory, { recursive: true, force: true });
    }
  });

  await context.test('phase 4 writes only the declared response and preserves executable bytes', async () => {
    const workspace = await workspaceFor(pack);
    try {
      const control = path.join(workspace, '.agentbattler', 'current');
      await mkdir(control, { recursive: true });
      const installed = await installV7Phase({ pack, phase: 4, destination: control });
      const before = await hashV7ExecutableTree(workspace);
      const contract = bindV7PhaseEntryContract(installed.contract, before);
      await writeFile(path.join(control, 'task-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
      await prepareGoldImplementationBPhase({ destination: workspace, phase: 4 });
      const response = JSON.parse(await readFile(path.join(workspace, 'incident-response.json'), 'utf8'));
      assert.equal(response.conclusion, 'no-canonical-data-loss');
      assert.equal(await hashV7ExecutableTree(workspace), before);
      const result = await verifyPhase({
        pack,
        phase: 4,
        candidateTree: workspace,
        workspace,
        contract,
        verifierSeedIndex: 7,
      });
      assert.equal(result.score, result.maxScore, JSON.stringify(result.requirements.filter(({ passed }) => !passed)));
      assert.deepEqual(result.infrastructureErrors, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
