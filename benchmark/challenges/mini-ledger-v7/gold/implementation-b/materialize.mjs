#!/usr/bin/env node
import { chmod, copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hashV7ExecutableTree, loadV7Pack, materializeV7Starter } from '../../pack.mjs';
import { prepareGoldImplementationBIncidentResponse } from './incident.mjs';

const OVERLAY = path.join(import.meta.dirname, 'overlay');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function overlayFiles(root, relative = '') {
  const result = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...await overlayFiles(root, child));
    else {
      invariant(entry.isFile() && !entry.isSymbolicLink(), `implementation-b overlay contains an unsupported entry: ${child}`);
      result.push(child);
    }
  }
  return result;
}

export async function applyGoldImplementationB({ destination }) {
  const root = path.resolve(destination);
  const starterEntrypoint = path.join(root, 'bin', 'ledger.mjs');
  const starterStat = await lstat(starterEntrypoint);
  invariant(starterStat.isFile() && !starterStat.isSymbolicLink(), 'implementation-b requires a materialized Mini Ledger V7 starter');
  const files = await overlayFiles(OVERLAY);
  for (const relative of files) {
    const source = path.join(OVERLAY, ...relative.split('/'));
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const targetStat = await lstat(target);
      invariant(targetStat.isFile() && !targetStat.isSymbolicLink(), `implementation-b target is not a regular file: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await copyFile(source, target);
    await chmod(target, relative === 'bin/ledger.mjs' ? 0o750 : 0o640);
  }
  return Object.freeze({
    destination: root,
    files: Object.freeze(files),
    executableSourceSha256: await hashV7ExecutableTree(root),
  });
}

export async function materializeGoldImplementationB({ destination, pack }) {
  invariant(pack && typeof pack === 'object', 'materializeGoldImplementationB requires a V7 pack');
  const starter = await materializeV7Starter({ destination, pack });
  const applied = await applyGoldImplementationB({ destination });
  return Object.freeze({ starter, ...applied, pack });
}

export async function prepareGoldImplementationBPhase({ destination, phase }) {
  invariant(phase === 4, 'implementation-b has no out-of-band action for this phase');
  return prepareGoldImplementationBIncidentResponse({ destination });
}

export const materializeFreshGoldImplementationB = materializeGoldImplementationB;

async function cli(argv) {
  const [destination, instanceId = 'dev-01', variant = 'decoy'] = argv;
  invariant(destination, 'usage: node materialize.mjs DESTINATION [INSTANCE_ID] [clean|decoy]');
  const pack = loadV7Pack(instanceId, { variant });
  const result = await materializeGoldImplementationB({ destination, pack });
  process.stdout.write(`${JSON.stringify({
    implementation: 'mini-ledger-v7-gold-b',
    destination: result.destination,
    instanceId: pack.instanceId,
    variant: pack.variant,
    executableSourceSha256: result.executableSourceSha256,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await cli(process.argv.slice(2));
}
