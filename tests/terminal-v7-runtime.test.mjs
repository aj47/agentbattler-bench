import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { beginV7Phase, prepareV7Workspace } from '../src/terminal-v7-runtime.mjs';

const execFileAsync = promisify(execFile);

test('V7 direct workspace is one shallow no-remote repository with current-only control', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-runtime-'));
  const workspace = path.join(root, 'workspace');
  const baselineDirectory = path.join(root, 'baseline');
  try {
    const { pack } = await prepareV7Workspace({ instanceId: 'dev-01', variant: 'decoy', workspace, baselineDirectory });
    const count = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspace });
    const remotes = await execFileAsync('git', ['remote'], { cwd: workspace });
    assert.equal(count.stdout.trim(), '1');
    assert.equal(remotes.stdout.trim(), '');
    await assert.rejects(access(path.join(baselineDirectory, '.git')), /ENOENT/);
    await assert.rejects(access(path.join(workspace, '.agentbattler', 'current')), /ENOENT/);
    const control = await beginV7Phase({ pack, phase: 1, workspace });
    assert.match(control.prompt, /\.agentbattler\/current\/TASK\.md/);
    assert.equal((await readFile(path.join(workspace, '.agentbattler', 'current', 'TASK.md'), 'utf8')).includes('Phase 1'), true);
    await assert.rejects(access(path.join(workspace, '.agentbattler', 'current', 'incident-evidence.json')), /ENOENT/);
    const history = await execFileAsync('git', ['log', '-1', '--format=%at %s'], { cwd: workspace });
    assert.equal(history.stdout.trim(), '946684800 sealed starter');
  } finally {
    await chmod(path.join(workspace, '.agentbattler', 'current'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
