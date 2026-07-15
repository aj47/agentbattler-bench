import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Return the lowercase SHA-256 digest for a string, Buffer, or Uint8Array. */
export function sha256(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createHash('sha256').update(bytes).digest('hex');
}

/** Return the SHA-256 digest of a file without interpreting its contents. */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
  if (typeof value !== 'object') throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
  if (seen.has(value)) throw new TypeError('Canonical JSON cannot contain cycles');

  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`Canonical JSON cannot contain undefined at ${key}`);
    result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

/** Deterministic JSON encoding with recursively sorted object keys. */
export function canonicalJson(value, { space = 0 } = {}) {
  return JSON.stringify(canonicalValue(value, new Set()), null, space);
}

/** Hash the canonical representation of JSON-compatible data. */
export function canonicalJsonSha256(value) {
  return sha256(canonicalJson(value));
}

/**
 * Build a stable checksum manifest. Paths are POSIX-style and relative to root.
 * The result is data (rather than preformatted text) so it can be embedded in JSON.
 */
export async function createChecksumManifest(filePaths, { root = process.cwd() } = {}) {
  if (!Array.isArray(filePaths)) throw new TypeError('filePaths must be an array');
  const entries = [];
  for (const input of filePaths) {
    const absolute = path.resolve(root, input);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error(`Manifest path escapes root: ${input}`);
    }
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Manifest entry is not a file: ${input}`);
    entries.push({ path: relative, sha256: await sha256File(absolute), sizeBytes: info.size });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { algorithm: 'sha256', entries };
}

/** Format manifest data in the conventional sha256sum-compatible form. */
export function formatChecksumManifest(manifest) {
  return manifest.entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
}

/** Re-hash every manifest entry. Returns all mismatches rather than stopping early. */
export async function verifyChecksumManifest(manifest, { root = process.cwd() } = {}) {
  if (!manifest || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.entries)) {
    throw new TypeError('Invalid SHA-256 manifest');
  }
  const mismatches = [];
  for (const entry of manifest.entries) {
    const absolute = path.resolve(root, entry.path);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      mismatches.push({ path: entry.path, reason: 'path_escape' });
      continue;
    }
    try {
      const info = await stat(absolute);
      const actualHash = info.isFile() ? await sha256File(absolute) : null;
      if (!info.isFile() || info.size !== entry.sizeBytes || actualHash !== entry.sha256) {
        mismatches.push({
          path: entry.path,
          reason: 'checksum_mismatch',
          expected: { sha256: entry.sha256, sizeBytes: entry.sizeBytes },
          actual: { sha256: actualHash, sizeBytes: info.size },
        });
      }
    } catch (error) {
      mismatches.push({ path: entry.path, reason: 'unreadable', error: error.message });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
