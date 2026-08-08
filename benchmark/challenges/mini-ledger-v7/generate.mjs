#!/usr/bin/env node
import path from 'node:path';

import { installV7Phase, loadV7Pack, materializeV7Starter, sealV7Pack } from './pack.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

try {
  const [action] = process.argv.slice(2);
  const instanceId = option('instance');
  const destination = option('destination');
  const phase = Number(option('phase'));
  const variant = option('variant') ?? 'decoy';
  if (!['create', 'reveal'].includes(action) || !instanceId || !destination || !Number.isInteger(phase)) {
    throw new Error('Usage: generate.mjs create|reveal --instance ID --variant clean|decoy --phase 1..5 --destination DIR');
  }
  const pack = loadV7Pack(instanceId, { variant });
  const workspace = path.resolve(destination);
  if (action === 'create') await materializeV7Starter({ pack, destination: workspace });
  const installed = await installV7Phase({ pack, phase, destination: path.join(workspace, '.agentbattler', 'current') });
  const seedKey = process.env.AGENTBATTLER_V7_SEED_KEY;
  const sealed = pack.pool === 'dev' || seedKey ? sealV7Pack(pack, { seedKey }) : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    instanceId: pack.instanceId,
    pool: pack.pool,
    variant: pack.variant,
    starterTreeSha256: pack.starterTreeSha256,
    phase: installed,
    sealSha256: sealed?.sealSha256 ?? null,
  })}\n`);
} catch (error) {
  process.stderr.write(`${String(error.message)}\n`);
  process.exitCode = 1;
}
