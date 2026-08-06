#!/usr/bin/env node
import path from 'node:path';

import { verifyHoldout } from '../mini-ledger-v4/holdout-verifier.mjs';

export { verifyHoldout };

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceIndex = process.argv.indexOf('--workspace');
  try {
    if (workspaceIndex < 1 || !process.argv[workspaceIndex + 1]) throw new Error('Usage: holdout-verifier.mjs --workspace DIR');
    const result = await verifyHoldout({ workspace: path.resolve(process.argv[workspaceIndex + 1]) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.passed !== result.total) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
