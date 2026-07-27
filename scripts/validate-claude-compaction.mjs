#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { claudeCompactionPolicy, claudeCompactionTelemetry } from '../src/claude-compaction.mjs';

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const tracePath = valueFor('--trace');
const model = valueFor('--model');
if (!tracePath || !model) throw new Error('Usage: validate-claude-compaction.mjs --trace CLAUDE_SESSION.jsonl --model MODEL');

const policy = claudeCompactionPolicy(model);
const events = (await readFile(path.resolve(tracePath), 'utf8')).split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch (error) { throw new Error(`Invalid JSONL on line ${index + 1}: ${error.message}`); }
});
const telemetry = claudeCompactionTelemetry(events);
if (telemetry.count < 1) throw new Error(`Calibration failed: the intentionally long ${model} session emitted no compact_boundary event`);
console.log(JSON.stringify({ schemaVersion: 'agentbattler.claude-compaction-calibration.v1', model, policy, telemetry }, null, 2));
