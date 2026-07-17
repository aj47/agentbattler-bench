#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UV = process.env.AGENTBATTLER_UV ?? 'uv';
const script = path.join(ROOT, 'scripts/publish-hf-results.py');
const child = spawn(UV, ['run', '--with', 'huggingface_hub==1.8.0', '--with', 'pyarrow==20.0.0', 'python', script, '--root', ROOT, ...process.argv.slice(2)], { cwd: ROOT, shell: false, stdio: 'inherit' });
child.on('error', (error) => { console.error(`HF publish: ${error.message}`); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
