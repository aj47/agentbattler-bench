#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDotAgentsV7Image } from '../src/dotagents-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main({
  repositoryRoot = ROOT,
  dockerBinary = process.env.AGENTBATTLER_DOCKER_BIN ?? 'docker',
} = {}) {
  const descriptor = await buildDotAgentsV7Image({ repositoryRoot, dockerBinary });
  process.stdout.write(`Built ${descriptor.image} as ${descriptor.imageId}\n`);
  process.stdout.write(`Reviewed source: ${descriptor.sourceSha256}\n`);
  return descriptor;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`DotAgents V7 image build failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
