#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const UV = process.env.AGENTBATTLER_UV ?? 'uv';
const PYTHON = path.join(ROOT, 'scripts/hf_results.py');
const CLI = path.join(ROOT, 'bin/agentbattler.mjs');
const RESULT_SETS = {
  current: [
    'results/claude-code-model-suite/matches/result.json',
    'results/harness-suite/matches/result.json',
  ],
  dotagents: [
    'results/league/dotagents-placement/matches/luna/result.json',
    'results/league/dotagents-placement/matches/sol/result.json',
    'results/league/dotagents-placement/matches/terra/result.json',
  ],
};

const CONFIG_SETS = {
  current: ['claude_code_only', 'three_harness'],
  dotagents: ['dotagents_luna', 'dotagents_sol', 'dotagents_terra'],
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['export', 'verify'].includes(command)) throw new Error('Usage: export-hf-results <export|verify> [options]');
  const setIndex = args.indexOf('--suite-set');
  const suiteSet = setIndex >= 0 ? args[setIndex + 1] : 'current';
  if (!RESULT_SETS[suiteSet]) throw new Error(`Unknown --suite-set ${suiteSet}`);
  if (command === 'export') for (const result of RESULT_SETS[suiteSet]) await run(NODE, [CLI, 'pack', result]);
  await run(UV, ['run', '--with', 'pyarrow==20.0.0', 'python', PYTHON, command, '--root', ROOT, ...args]);
  if (command === 'verify') {
    const outputIndex = args.indexOf('--output');
    const output = outputIndex >= 0 ? args[outputIndex + 1] : '.artifacts/hf-dataset/agentbattler-bench-results';
    const releases = await readdir(path.resolve(ROOT, output, 'releases'));
    if (releases.length !== 1) throw new Error('Expected exactly one staged release directory');
    for (const config of CONFIG_SETS[suiteSet]) {
      await run(NODE, [CLI, 'replay', path.join(output, 'releases', releases[0], config, 'bundle', 'result.json.gz')]);
    }
  }
}

main().catch((error) => { console.error(`HF results export: ${error.message}`); process.exitCode = 1; });
