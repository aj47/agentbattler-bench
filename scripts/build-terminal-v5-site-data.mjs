#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../src/provenance.mjs';
import { buildTerminalCampaignSiteData } from '../src/terminal-publication.mjs';

const options = { campaignRoot: null, output: null, sourceRoots: {}, allowIncomplete: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value === '--campaign-root') options.campaignRoot = path.resolve(process.argv[++index]);
  else if (value === '--output') options.output = path.resolve(process.argv[++index]);
  else if (value === '--source-r2') options.sourceRoots.R2 = path.resolve(process.argv[++index]);
  else if (value === '--source-r3') options.sourceRoots.R3 = path.resolve(process.argv[++index]);
  else if (value === '--source-r4') options.sourceRoots.R4 = path.resolve(process.argv[++index]);
  else if (value === '--allow-incomplete') options.allowIncomplete = true;
  else throw new Error(`Unexpected argument: ${value}`);
}
if (!options.campaignRoot || !options.output) throw new Error('--campaign-root and --output are required');
const lane = await buildTerminalCampaignSiteData(options);
await mkdir(path.dirname(options.output), { recursive: true });
await writeFile(options.output, `${canonicalJson(lane, { space: 2 })}\n`);
console.log(`Terminal campaign site data: ${options.output} (${lane.campaign.acceptedRuns}/${lane.campaign.expectedRuns})`);
