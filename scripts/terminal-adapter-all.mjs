#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTerminalV7ExecutionIdentity } from '../src/terminal-v7-execution-identity.mjs';
import { sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [harbor, codex, pi, claude, dotagents, droid] = await Promise.all([
  import('./terminal-adapter-harbor.mjs'),
  import('./terminal-adapter-codex.mjs'),
  import('./terminal-adapter-pi.mjs'),
  import('./terminal-adapter-claude.mjs'),
  import('./terminal-adapter-dotagents.mjs'),
  import('./terminal-adapter-droid.mjs'),
]);

const legacyByHarness = new Map([codex, pi, claude, dotagents, droid].flatMap((adapter) => adapter.harnesses.map((harness) => [harness, adapter])));
const harborByHarness = new Map(harbor.harnesses.map((harness) => [harness, harbor]));
export const harnesses = [...legacyByHarness.keys()].sort();

async function verifyLegacyHarborAdapters(challenge, harness) {
  const expected = challenge.execution?.adapters;
  if (!expected) throw new Error('Harbor challenge does not bind adapter source');
  const kind = harborByHarness.has(harness) ? 'harbor' : harness === 'dotagents-mono' ? 'dotagents' : 'droid';
  const common = ['dispatcher', kind, 'claudeCompaction', 'anthropicOverflowCompat'];
  if (kind === 'droid') common.push('droidHarness', 'droidJsonRpc', 'droidRouting', 'droidRuntime');
  for (const optional of ['candidateProcess', 'publicVerifier', 'holdoutVerifier', 'challengeRuntime', 'terminalChallenge', 'terminalRunner', 'terminalPrompts', 'harnessVersions', 'terminalRoster', 'codexHarbor', 'codexBwrapWrapper', 'piSandboxExtension', 'claudeBwrapWrapper', 'dotagentsHarness', 'dotagentsDockerfile', 'dotagentsDockerignore', 'dotagentsCommandSandbox', 'dotagentsMaxReasoning', 'dotagentsSandboxPatchR5', 'dotagentsSandboxPatchV7', 'droidSandbox', 'runEvidence', 'v7Runtime', 'v7Direct', 'v7Overlay', 'v7VerifierEvidence', 'v7HumanTwins', 'v7BaseGateAssembler', 'v7Retirement', 'v7RevisionControl', 'candidateTree', 'v7Control', 'v7CodexHarbor', 'v7PiHarbor', 'v7ClaudeHarbor', 'verifier', 'verifierContainer', 'verifierContainerDockerfile', 'verifierContainerRunner', 'pack', 'requirements', 'requirementMap']) {
    if (expected[optional]) common.push(optional);
  }
  for (const name of common) {
    const descriptor = expected[name];
    if (!descriptor || await sha256File(path.join(ROOT, descriptor.path)) !== descriptor.sha256) throw new Error(`${name} adapter source does not match the sealed challenge`);
  }
}

export async function runTerminalJob(args) {
  const v7Challenge = args.challenge?.id === 'terminal-mini-ledger-v7';
  const harborChallenge = args.challenge?.execution?.substrate === 'harbor' || v7Challenge;
  if (v7Challenge) {
    if (!args.job?.harness) throw new Error('V7 execution harness identity is missing');
    await assertTerminalV7ExecutionIdentity({ root: ROOT, challenge: args.challenge });
  } else if (harborChallenge) await verifyLegacyHarborAdapters(args.challenge, args.job?.harness);
  const adapter = harborChallenge
    ? (harborByHarness.get(args.job?.harness) ?? legacyByHarness.get(args.job?.harness))
    : legacyByHarness.get(args.job?.harness);
  if (!adapter) throw new Error(`No terminal adapter registered for ${args.job?.harness}`);
  return adapter.runTerminalJob(args);
}
