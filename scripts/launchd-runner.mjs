#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = process.env.AGENTBATTLER_OUTPUT;
const manifest = process.env.AGENTBATTLER_MANIFEST;
const positions = process.env.AGENTBATTLER_POSITIONS;
const pairing = process.env.AGENTBATTLER_PAIRING;
const status = process.env.AGENTBATTLER_EXIT_STATUS;
if (![output, manifest, positions, pairing, status].every(Boolean)) throw new Error('launchd runner environment is incomplete');
const node = process.execPath;
const cli = path.join(root, 'bin/agentbattler.mjs');
async function run(args) { return await new Promise((resolve, reject) => { const child = spawn(node, [cli, ...args], { cwd: root, env: process.env, stdio: 'inherit' }); child.on('error', reject); child.on('close', resolve); }); }
await mkdir(path.dirname(status), { recursive: true });
const benchmark = await run(['run', '--manifest', manifest, '--positions', positions, '--pairing', pairing, '--output', output, '--no-smoke']);
const replay = benchmark === 0 ? await run(['replay', `${output}/result.json`]) : null;
const payload = { benchmarkExitCode: benchmark, replayExitCode: replay, completedAt: new Date().toISOString() };
await writeFile(status, `${JSON.stringify(payload)}\n`);
process.exitCode = benchmark || replay || 0;
