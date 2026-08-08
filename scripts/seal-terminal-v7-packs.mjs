#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/provenance.mjs';
import {
  createTerminalV7SealManifest,
  validateTerminalV7SealManifest,
} from '../src/terminal-v7-seals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r1';
const CODEX_STATE_ROOT = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const KEY_PATH = path.resolve(process.env.AGENTBATTLER_V7_SEED_KEY_FILE ?? path.join(CODEX_STATE_ROOT, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${REVISION}.seed-key`));
const OUTPUT = path.resolve(ROOT, process.env.AGENTBATTLER_V7_SEALS_PATH ?? `benchmark/challenges/mini-ledger-v7/seals/${REVISION}.json`);

if (!/^r[1-9]\d*$/.test(REVISION)) throw new Error('V7 revision must look like r1');
let seedKey;
try {
  seedKey = (await readFile(KEY_PATH, 'utf8')).trim();
} catch (error) {
  if (error?.code !== 'ENOENT' || !process.argv.includes('--create-key')) throw new Error('V7 evaluator seed key is unavailable; pass --create-key only before any frontier pilot exists');
  await mkdir(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  seedKey = randomBytes(32).toString('hex');
  await writeFile(KEY_PATH, `${seedKey}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(KEY_PATH, 0o600);
}
let manifest;
try {
  manifest = JSON.parse(await readFile(OUTPUT, 'utf8'));
  validateTerminalV7SealManifest(manifest, { seedKey });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  manifest = createTerminalV7SealManifest({ revision: REVISION, seedKey, sealedAt: new Date().toISOString() });
  validateTerminalV7SealManifest(manifest, { seedKey });
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${canonicalJson(manifest, { space: 2 })}\n`, { flag: 'wx' });
}
console.log(`Sealed Mini Ledger V7 ${REVISION}: 3 development, 5 release, 5 reserve packs with clean twins`);
console.log(`Commitment manifest: ${OUTPUT}`);
