#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_INPUTS = [
  path.join(ROOT, 'agents/model-suite/manifest.json'),
  path.join(ROOT, 'agents/pi-model-suite/manifest.json'),
];
const CLAUDE_INPUT = path.join(ROOT, 'agents/claude-code-model-suite/manifest.json');
const OUTPUT_DIR = path.join(ROOT, 'agents/harness-suite');
const OUTPUT = path.join(OUTPUT_DIR, 'manifest.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const inputs = [...REQUIRED_INPUTS];
try {
  await access(CLAUDE_INPUT);
  inputs.push(CLAUDE_INPUT);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const manifests = await Promise.all(inputs.map((file) => readFile(file, 'utf8').then(JSON.parse)));
const agents = manifests.flatMap((manifest) => manifest.agents);
const ids = agents.map((agent) => agent.id);
invariant(new Set(ids).size === ids.length, 'Harness suite contains duplicate agent IDs');
invariant(agents.every((agent) => agent.provenance?.generatedByHarness === true), 'Harness suite may only contain generated agents');
const harnesses = [...new Set(agents.map((agent) => agent.provenance.harness))].sort();
const expectedHarnesses = inputs.length === 3
  ? ['claude-code', 'codex-cli', 'pi-coding-agent']
  : ['codex-cli', 'pi-coding-agent'];
invariant(JSON.stringify(harnesses) === JSON.stringify(expectedHarnesses), `Harness suite requires ${expectedHarnesses.join(', ')} manifests`);

const modelCounts = new Map();
for (const agent of agents) {
  const key = `${agent.provenance.harness}/${agent.provenance.modelRequested}`;
  modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
}
const counts = [...modelCounts.values()];
invariant(counts.length === 3 * harnesses.length && new Set(counts).size === 1, 'Harness suite requires balanced generations for all three models and every harness');

const baseline = manifests.find((manifest) => manifest.comparison?.harness === 'codex-cli');
invariant(manifests.every((manifest) => manifest.comparison?.promptSha256 === baseline?.comparison?.promptSha256), 'Harness manifests use different prompts');
invariant(manifests.every((manifest) => manifest.comparison?.reasoningEffort === baseline?.comparison?.reasoningEffort), 'Harness manifests use different reasoning effort');
const allCrossHarnessPairs = harnesses.reduce((total, first, index) => total + harnesses.slice(index + 1).reduce((inner, second) => (
  inner + agents.filter((agent) => agent.provenance.harness === first).length * agents.filter((agent) => agent.provenance.harness === second).length
), 0), 0);

const manifest = {
  schemaVersion: 'agentbattler.agent-manifest.v1',
  manifestId: `${harnesses.join('-vs-')}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  description: `Balanced direct harness comparison: ${harnesses.join(', ')} using the same models, prompt, reasoning effort, and generation count.`,
  comparison: {
    kind: 'harness-comparison',
    pairing: 'cross-harness-all',
    harnesses,
    models: [...new Set(agents.map((agent) => agent.provenance.modelRequested))].sort(),
    generationsPerHarnessModel: counts[0],
    prompt: baseline.comparison.prompt,
    promptSha256: baseline.comparison.promptSha256,
    reasoningEffort: baseline.comparison.reasoningEffort,
  },
  agents,
};

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(OUTPUT, `${canonicalJson(manifest, { space: 2 })}\n`);
console.log(`Harness roster: ${agents.length} agents across ${harnesses.join(' vs ')}`);
console.log(`All cross-harness pairs: ${allCrossHarnessPairs}`);
console.log(`Manifest: ${OUTPUT}`);
