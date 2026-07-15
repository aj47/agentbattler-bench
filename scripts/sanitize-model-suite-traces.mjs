#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateNativeCodexSession } from '../src/codex-session.mjs';
import { canonicalJson, sha256 } from '../src/provenance.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATIONS = path.join(ROOT, 'results/model-suite/generations');
const PROMPT = await readFile(path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md'), 'utf8');
const SCRUB_CONTEXT = { homeDirectory: os.homedir(), username: os.userInfo().username };

for (const model of ['terra', 'sol', 'luna']) {
  const directory = path.join(GENERATIONS, model);
  const metadataPath = path.join(directory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const results = {};
  for (const [key, file] of [
    ['cliStdout', 'codex.jsonl'],
    ['cliStderr', 'codex-stderr.txt'],
    ['nativeSession', 'session.jsonl'],
  ]) {
    const target = path.join(directory, file);
    const sanitized = sanitizePublicTrace(await readFile(target, 'utf8'), SCRUB_CONTEXT);
    await writeFile(target, sanitized.content);
    results[key] = sanitized;
  }
  const session = validateNativeCodexSession(results.nativeSession.content, {
    sessionId: metadata.run.sessionId,
    model: metadata.run.modelRequested,
    prompt: PROMPT,
    forbiddenText: [SCRUB_CONTEXT.homeDirectory, SCRUB_CONTEXT.username],
  });
  metadata.nativeSession = {
    ...metadata.nativeSession,
    sha256: sha256(results.nativeSession.content),
    sizeBytes: Buffer.byteLength(results.nativeSession.content),
    ...session,
  };
  metadata.sanitization = {
    strategy: 'literal-host-identity-redaction',
    placeholders: ['<redacted-home>', '<redacted-user>'],
    cliStdout: results.cliStdout.replacements,
    cliStderr: results.cliStderr.replacements,
    nativeSession: results.nativeSession.replacements,
    totalReplacements: results.cliStdout.totalReplacements + results.cliStderr.totalReplacements + results.nativeSession.totalReplacements,
  };
  await writeFile(metadataPath, `${canonicalJson(metadata, { space: 2 })}\n`);
  console.log(`${model}: ${metadata.sanitization.totalReplacements} host identity occurrences redacted`);
}
