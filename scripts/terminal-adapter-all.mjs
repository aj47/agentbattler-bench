#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function verifyHarborAdapters(challenge, harness) {
  const expected = challenge.execution?.adapters;
  if (!expected) throw new Error('V4 challenge does not bind adapter source');
  const kind = harborByHarness.has(harness) ? 'harbor' : harness === 'dotagents-mono' ? 'dotagents' : 'droid';
  const common = ['dispatcher', kind, 'claudeCompaction', 'anthropicOverflowCompat'];
  if (kind === 'droid') common.push('droidHarness', 'droidJsonRpc', 'droidRouting', 'droidRuntime');
  for (const optional of ['candidateProcess', 'publicVerifier', 'holdoutVerifier', 'challengeRuntime', 'terminalPrompts', 'harnessVersions']) {
    if (expected[optional]) common.push(optional);
  }
  for (const name of common) {
    const descriptor = expected[name];
    if (!descriptor || await sha256File(path.join(ROOT, descriptor.path)) !== descriptor.sha256) throw new Error(`${name} adapter source does not match the sealed challenge`);
  }
}

export async function runTerminalJob(args) {
  const harborChallenge = args.challenge?.execution?.substrate === 'harbor';
  if (harborChallenge) await verifyHarborAdapters(args.challenge, args.job?.harness);
  const adapter = harborChallenge
    ? (harborByHarness.get(args.job?.harness) ?? legacyByHarness.get(args.job?.harness))
    : legacyByHarness.get(args.job?.harness);
  if (!adapter) throw new Error(`No terminal adapter registered for ${args.job?.harness}`);
  return adapter.runTerminalJob(args);
}
