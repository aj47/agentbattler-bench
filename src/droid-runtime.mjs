import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { DROID_BINARY_SHA256, DROID_VERSION } from './droid-harness.mjs';
import { sha256File } from './provenance.mjs';

const execFileAsync = promisify(execFile);

function invariant(condition, message) { if (!condition) throw new Error(message); }

async function resolveDroidBinary(environment) {
  for (const directory of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, 'droid');
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Continue through PATH. */ }
  }
  throw new Error('Droid executable is unavailable on PATH');
}

export async function verifyDroidRuntime(environment = process.env) {
  const binaryPath = await resolveDroidBinary(environment);
  const [{ stdout }, binarySha256] = await Promise.all([
    execFileAsync(binaryPath, ['--version'], { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 }),
    sha256File(binaryPath),
  ]);
  const version = stdout.trim();
  invariant(version === DROID_VERSION, `Droid must be version ${DROID_VERSION}; got ${version || 'unavailable'}`);
  invariant(binarySha256 === DROID_BINARY_SHA256, `Droid ${DROID_VERSION} binary SHA-256 is ${binarySha256}, expected ${DROID_BINARY_SHA256}`);
  return { version, binarySha256, binaryPath };
}
