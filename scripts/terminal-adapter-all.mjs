#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [harbor, codex, pi, claude, dotagents] = await Promise.all([
  import('./terminal-adapter-harbor.mjs'),
  import('./terminal-adapter-codex.mjs'),
  import('./terminal-adapter-pi.mjs'),
  import('./terminal-adapter-claude.mjs'),
  import('./terminal-adapter-dotagents.mjs'),
]);

const legacyByHarness = new Map([codex, pi, claude, dotagents].flatMap((adapter) => adapter.harnesses.map((harness) => [harness, adapter])));
const harborByHarness = new Map(harbor.harnesses.map((harness) => [harness, harbor]));
export const harnesses = [...legacyByHarness.keys()].sort();

async function verifyV4Adapters(challenge, harness) {
  const expected = challenge.execution?.adapters;
  if (!expected) throw new Error('V4 challenge does not bind adapter source');
  const kind = harborByHarness.has(harness) ? 'harbor' : 'dotagents';
  for (const name of ['dispatcher', kind]) {
    const descriptor = expected[name];
    if (!descriptor || await sha256File(path.join(ROOT, descriptor.path)) !== descriptor.sha256) throw new Error(`${name} adapter source does not match the sealed challenge`);
  }
}

export async function runTerminalJob(args) {
  if (args.challenge?.id === 'terminal-mini-ledger-v4') await verifyV4Adapters(args.challenge, args.job?.harness);
  const adapter = args.challenge?.id === 'terminal-mini-ledger-v4'
    ? (harborByHarness.get(args.job?.harness) ?? legacyByHarness.get(args.job?.harness))
    : legacyByHarness.get(args.job?.harness);
  if (!adapter) throw new Error(`No terminal adapter registered for ${args.job?.harness}`);
  return adapter.runTerminalJob(args);
}
