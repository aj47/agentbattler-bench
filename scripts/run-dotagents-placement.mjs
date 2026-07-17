#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_PATH = path.join(ROOT, 'results/league/dotagents-placement/plan.json');
const MANIFEST_PATH = path.join(ROOT, 'agents/harness-suite/manifest.json');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const LEDGER_PATH = path.join(ROOT, 'results/league/ledger');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited ${exitCode}`));
    });
  });
}

const plan = JSON.parse(await readFile(PLAN_PATH, 'utf8'));
invariant(plan?.schemaVersion === 'agentbattler.dotagents-placement-plan.v1', 'Create the DotAgents placement plan first');
invariant(plan.schedules?.length === 3, `Expected three DotAgents placement schedules; found ${plan.schedules?.length ?? 0}`);

await Promise.all(plan.schedules.map(async (item) => {
  const slug = item.model.replace(/^gpt-5\.6-/, '');
  invariant(['terra', 'sol', 'luna'].includes(slug), `Unexpected DotAgents model in placement plan: ${item.model}`);
  const resultPath = path.join(ROOT, `results/league/dotagents-placement/matches/${slug}/result.json`);
  if (await exists(resultPath)) {
    console.log(`Replaying completed ${slug} placement bundle...`);
    return run(['bin/agentbattler.mjs', 'replay', resultPath]);
  }
  console.log(`Running missing ${slug} placement games...`);
  return run([
    'bin/agentbattler.mjs', 'run',
    '--manifest', MANIFEST_PATH,
    '--positions', POSITIONS_PATH,
    '--schedule', path.join(ROOT, item.schedule),
    '--output', path.dirname(resultPath),
    '--ledger', LEDGER_PATH,
    '--no-smoke',
  ]);
}));

await run(['scripts/create-dotagents-placement.mjs']);
