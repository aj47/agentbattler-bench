#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = [
  path.join(ROOT, 'agents/model-suite/manifest.json'),
  path.join(ROOT, 'agents/pi-model-suite/manifest.json'),
];
const OUTPUT_DIR = path.join(ROOT, 'agents/harness-suite');
const OUTPUT = path.join(OUTPUT_DIR, 'manifest.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const manifests = await Promise.all(INPUTS.map((file) => readFile(file, 'utf8').then(JSON.parse)));
const agents = manifests.flatMap((manifest) => manifest.agents);
const ids = agents.map((agent) => agent.id);
invariant(new Set(ids).size === ids.length, 'Harness suite contains duplicate agent IDs');
invariant(agents.every((agent) => agent.provenance?.generatedByHarness === true), 'Harness suite may only contain generated agents');
const harnesses = [...new Set(agents.map((agent) => agent.provenance.harness))].sort();
invariant(harnesses.length === 2 && harnesses.includes('codex-cli') && harnesses.includes('pi-coding-agent'), 'Harness suite requires Codex CLI and Pi manifests');

const modelCounts = new Map();
for (const agent of agents) {
  const key = `${agent.provenance.harness}/${agent.provenance.modelRequested}`;
  modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
}
const counts = [...modelCounts.values()];
invariant(counts.length === 6 && new Set(counts).size === 1, 'Harness suite requires balanced generations for all three models and both harnesses');

const codex = manifests.find((manifest) => manifest.comparison?.harness === 'codex-cli');
const pi = manifests.find((manifest) => manifest.comparison?.harness === 'pi-coding-agent');
invariant(codex?.comparison?.promptSha256 === pi?.comparison?.promptSha256, 'Harness manifests use different prompts');
invariant(codex?.comparison?.reasoningEffort === pi?.comparison?.reasoningEffort, 'Harness manifests use different reasoning effort');

const manifest = {
  schemaVersion: 'agentbattler.agent-manifest.v1',
  manifestId: `codex-vs-pi-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  description: 'Balanced direct harness comparison: Codex CLI versus Pi using the same models, prompt, reasoning effort, and generation count.',
  comparison: {
    kind: 'harness-comparison',
    pairing: 'cross-harness-all',
    harnesses,
    models: [...new Set(agents.map((agent) => agent.provenance.modelRequested))].sort(),
    generationsPerHarnessModel: counts[0],
    prompt: codex.comparison.prompt,
    promptSha256: codex.comparison.promptSha256,
    reasoningEffort: codex.comparison.reasoningEffort,
  },
  agents,
};

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(OUTPUT, `${canonicalJson(manifest, { space: 2 })}\n`);
console.log(`Harness roster: ${agents.length} agents across ${harnesses.join(' vs ')}`);
console.log(`All cross-harness pairs: ${(agents.length / 2) ** 2}`);
console.log(`Manifest: ${OUTPUT}`);
