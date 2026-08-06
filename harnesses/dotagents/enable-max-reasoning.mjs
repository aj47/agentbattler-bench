#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const dist = process.argv[2];
invariant(typeof dist === 'string' && path.isAbsolute(dist), 'Pass the absolute @ai-sdk/openai dist directory');

const before = '["none", "minimal", "low", "medium", "high", "xhigh"]';
const after = '["none", "minimal", "low", "medium", "high", "xhigh", "max"]';
for (const filename of ['index.mjs', 'index.js']) {
  const file = path.join(dist, filename);
  const source = await readFile(file, 'utf8');
  const occurrences = source.split(before).length - 1;
  invariant(occurrences === 1, `${file} has ${occurrences} max-reasoning schema targets; expected exactly one`);
  const patched = source.replace(before, after);
  invariant(patched.includes('reasoning_effort'), `${file} no longer contains the OpenAI reasoning request mapping`);
  await writeFile(file, patched);
}
