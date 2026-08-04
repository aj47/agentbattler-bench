#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DROID_CONTEXT_POLICY,
  droidCompactionTelemetry,
  droidModelFamily,
  parseDroidEventStream,
} from '../src/droid-harness.mjs';

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const tracePath = valueFor('--trace');
const model = valueFor('--model');
if (!tracePath || !model) throw new Error('Usage: validate-droid-compaction.mjs --trace DROID_SESSION.jsonl --model MODEL');
droidModelFamily(model);

const events = parseDroidEventStream(await readFile(path.resolve(tracePath), 'utf8'));
const telemetry = droidCompactionTelemetry(events);
if (telemetry.count < 1) throw new Error(`Calibration failed: the intentionally long ${model} session emitted no native compaction boundary`);
console.log(JSON.stringify({
  schemaVersion: 'agentbattler.droid-compaction-calibration.v1',
  model,
  policy: DROID_CONTEXT_POLICY,
  telemetry,
}, null, 2));
