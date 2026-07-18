#!/usr/bin/env node
const adapters = await Promise.all([
  import('./terminal-adapter-codex.mjs'),
  import('./terminal-adapter-pi.mjs'),
  import('./terminal-adapter-claude.mjs'),
  import('./terminal-adapter-dotagents.mjs'),
]);

const byHarness = new Map(adapters.flatMap((adapter) => adapter.harnesses.map((harness) => [harness, adapter])));
export const harnesses = [...byHarness.keys()].sort();

export async function runTerminalJob(args) {
  const adapter = byHarness.get(args.job?.harness);
  if (!adapter) throw new Error(`No terminal adapter registered for ${args.job?.harness}`);
  return adapter.runTerminalJob(args);
}
