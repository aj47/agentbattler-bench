#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { partitionScheduleJobs } from '../src/game-ledger.mjs';
import {
  createBattleProtocol, createPlacementSchedule, createSeason, groupAgentsByCombo,
} from '../src/league.mjs';
import { canonicalJson, sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'agents/harness-suite/manifest.json');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const OUTPUT_ROOT = path.join(ROOT, 'results/league/dotagents-placement');
const LEDGER = path.join(ROOT, 'results/league/ledger');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { flag: 'wx' });
  await rename(temporary, file);
}

const [manifest, suite, suiteSha256] = await Promise.all([
  readFile(MANIFEST_PATH, 'utf8').then(JSON.parse),
  readFile(POSITIONS_PATH, 'utf8').then(JSON.parse),
  sha256File(POSITIONS_PATH),
]);
const groups = [...groupAgentsByCombo(manifest.agents).values()];
const entrants = groups.filter((group) => group.combo.harness.id === 'dotagents-mono');
invariant(entrants.length === 3, `Expected three DotAgents combos; found ${entrants.length}`);
const protocol = createBattleProtocol({ nodeVersion: 'v26.3.0' });
const season = createSeason({ suiteId: suite.suiteId, suiteSha256, protocol, evidenceLane: 'exploratory' });
const plan = [];

for (const entrant of entrants.sort((left, right) => left.combo.model.id.localeCompare(right.combo.model.id))) {
  const anchors = groups.filter((group) => (
    group.combo.harness.id !== 'dotagents-mono'
    && group.combo.model.id === entrant.combo.model.id
    && group.combo.model.reasoningEffort === entrant.combo.model.reasoningEffort
  )).sort((left, right) => left.combo.harness.id.localeCompare(right.combo.harness.id));
  invariant(anchors.length === 3, `Expected three same-model anchors for ${entrant.combo.model.id}; found ${anchors.length}`);
  const schedule = createPlacementSchedule({
    agents: manifest.agents,
    entrantComboId: entrant.combo.comboId,
    anchorComboIds: anchors.map((group) => group.combo.comboId),
    positions: suite.positions,
    season,
    protocol,
    tierId: 'contender',
    rotations: 1,
  });
  const partition = await partitionScheduleJobs(LEDGER, schedule.jobs);
  const slug = entrant.combo.model.id.replace(/^gpt-5\.6-/, '');
  const output = path.join(OUTPUT_ROOT, `${slug}.json`);
  await atomicJson(output, schedule);
  plan.push({
    model: entrant.combo.model.id,
    entrantComboId: entrant.combo.comboId,
    anchorComboIds: anchors.map((group) => group.combo.comboId),
    scheduleId: schedule.scheduleId,
    schedule: path.relative(ROOT, output),
    games: schedule.jobs.length,
    reusableGames: partition.cached.length,
    missingGames: partition.missing.length,
  });
}

await atomicJson(path.join(OUTPUT_ROOT, 'plan.json'), {
  schemaVersion: 'agentbattler.dotagents-placement-plan.v1',
  season,
  schedules: plan,
  totals: {
    combos: plan.length,
    games: plan.reduce((sum, item) => sum + item.games, 0),
    reusableGames: plan.reduce((sum, item) => sum + item.reusableGames, 0),
    missingGames: plan.reduce((sum, item) => sum + item.missingGames, 0),
  },
});
console.log(`DotAgents placement: ${plan.length} schedules and ${plan.reduce((sum, item) => sum + item.games, 0)} games.`);
for (const item of plan) console.log(`${item.model}: ${item.reusableGames} reusable, ${item.missingGames} missing (${item.scheduleId})`);
