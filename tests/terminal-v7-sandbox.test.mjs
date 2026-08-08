import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  createDroidV7SandboxProfile,
  droidV7SandboxLauncher,
  isolatedDroidV7Environment,
  resolveDroidV7RuntimeReadPaths,
} from '../src/droid-sandbox.mjs';
import { DROID_RESTRICTED_TOOLS, DROID_V7_RESTRICTED_TOOLS } from '../src/droid-harness.mjs';
import { verifyDroidRuntime } from '../src/droid-runtime.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

test('V7 Droid environment is a fixed non-secret allowlist independent of the host', () => {
  const environment = isolatedDroidV7Environment('/private/run/droid-home', '/private/run/droid-tmp', {
    executablePaths: ['/opt/pinned/node'],
  });
  assert.deepEqual(Object.keys(environment).sort(), ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR', 'TZ']);
  assert.deepEqual(environment, {
    PATH: '/opt/pinned:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: '/private/run/droid-home',
    TMPDIR: '/private/run/droid-tmp',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NO_COLOR: '1',
  });
  assert.equal(environment.AGENTBATTLER_CLIPROXY_API_KEY, undefined);
  assert.ok(Object.isFrozen(environment));
});

test('V7 exposes only Droid Execute while preserving the V6 tool catalog', async () => {
  assert.deepEqual(DROID_V7_RESTRICTED_TOOLS, ['Execute']);
  assert.deepEqual(DROID_RESTRICTED_TOOLS, ['Read', 'ApplyPatch', 'Execute', 'Glob', 'Grep', 'LS']);
  const adapter = await readFile(path.join(ROOT, 'scripts', 'terminal-adapter-droid.mjs'), 'utf8');
  assert.match(adapter, /isV7 \? DROID_V7_RESTRICTED_TOOLS : DROID_RESTRICTED_TOOLS/);
  assert.match(adapter, /inProcessFilesystemTools: 'disabled'/);
  assert.match(adapter, /commandToolBoundary: 'execute-only-child-process'/);
});

test('V7 Harbor command sandboxes mask the container root and fail closed on capabilities', async () => {
  const files = [
    'benchmark/harbor/v7_codex_bwrap_wrapper.sh',
    'benchmark/harbor/v7_claude_bwrap_wrapper.sh',
    'benchmark/harbor/v7_pi_sandbox_extension.mjs',
    'harnesses/dotagents/runtime-tools-sandbox-v7.patch',
  ];
  for (const relative of files) {
    const source = await readFile(path.join(ROOT, relative), 'utf8');
    assert.match(source, /--tmpfs['" ,\\]+\//);
    assert.match(source, /--unshare-net/);
    assert.match(source, /--proc['" ,\\]+\/proc/);
    assert.match(source, /--cap-drop['" ,\\]+ALL/);
    assert.match(source, /CapEff/);
    assert.match(source, /--clearenv/);
    assert.match(source, /enumerate their own environment/);
    assert.match(source, /--ro-bind/);
    assert.match(source, /\/app\/\.agentbattler|CONTROL_ROOT/);
    assert.doesNotMatch(source, /--ro-bind['" ,\\]+\/etc['" ,\\]+\/etc/);
  }
  const [codex, claude, pi] = await Promise.all([
    readFile(path.join(ROOT, 'benchmark/harbor/v7_codex_agent.py'), 'utf8'),
    readFile(path.join(ROOT, 'benchmark/harbor/v7_claude_agent.py'), 'utf8'),
    readFile(path.join(ROOT, 'benchmark/harbor/v7_pi_agent.py'), 'utf8'),
  ]);
  assert.match(codex, /v7_codex_bwrap_wrapper\.sh/);
  assert.match(claude, /v7_claude_bwrap_wrapper\.sh/);
  assert.match(claude, /0:0:444/);
  assert.match(claude, /--tools \"Bash\"/);
  assert.match(claude, /--allowedTools \"Bash\"/);
  assert.match(claude, /--disallowedTools \"Read,Edit,Write,Glob,Grep,NotebookEdit,WebFetch,WebSearch,mcp__\*\"/);
  assert.match(claude, /--strict-mcp-config --disable-slash-commands --no-chrome/);
  assert.match(claude, /"allow": \["Bash"\]/);
  assert.match(claude, /"deny": \[/);
  assert.match(pi, /v7_pi_sandbox_extension\.mjs/);

  const adapters = await Promise.all([
    'scripts/terminal-adapter-harbor.mjs',
    'scripts/terminal-adapter-dotagents.mjs',
    'scripts/terminal-adapter-droid.mjs',
  ].map((relative) => readFile(path.join(ROOT, relative), 'utf8')));
  for (const adapter of adapters) {
    assert.match(adapter, /isV7 \? \{\s*modelCommandCapabilities: 'exactly-zero'/);
  }
});

test('V7 Droid SBPL launches the pinned native runtime with only its exact static dependencies', {
  skip: process.platform !== 'darwin' ? 'macOS sandbox-exec is required' : false,
  timeout: 30_000,
}, async (context) => {
  let runtime;
  try {
    runtime = await verifyDroidRuntime(process.env);
  } catch (error) {
    context.skip(`Pinned Droid runtime is unavailable: ${error.message}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-real-droid-start-'));
  try {
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const temporary = path.join(root, 'tmp');
    await Promise.all([workspace, home, temporary].map((directory) => mkdir(directory, { recursive: true })));
    const runtimeReadPaths = await resolveDroidV7RuntimeReadPaths([process.execPath]);
    const profilePath = path.join(root, 'profile.sb');
    await writeFile(profilePath, createDroidV7SandboxProfile({
      runDirectory: root,
      workspace,
      binaryPath: runtime.binaryPath,
      runtimeReadPaths,
      networkPort: 1,
    }));
    const result = await execFileAsync('/usr/bin/sandbox-exec', [
      '-f', profilePath, runtime.binaryPath, '--version',
    ], {
      cwd: workspace,
      env: isolatedDroidV7Environment(home, temporary, { executablePaths: [process.execPath] }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.stdout.trim(), runtime.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V7 Droid SBPL gives router access only to the Droid binary and workspace access to children', {
  skip: process.platform !== 'darwin' ? 'macOS sandbox-exec is required' : false,
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-droid-sandbox-'));
  const workspace = path.join(root, 'workspace');
  const control = path.join(workspace, '.agentbattler');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-droid-outside-'));
  const privateParentBinary = path.join(root, 'private-parent-runtime');
  await mkdir(control, { recursive: true });
  const parentSource = path.join(root, 'private-parent-runtime.c');
  await writeFile(parentSource, `
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2) return 60;
  puts("ready"); fflush(stdout); usleep(500000);
  int fd = socket(AF_INET, SOCK_STREAM, 0); if (fd < 0) return 61;
  struct sockaddr_in address = {0}; address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)atoi(argv[1]));
  if (inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) != 1) return 62;
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) return 63;
  const char *request = "GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n";
  if (write(fd, request, strlen(request)) < 0) return 64;
  char response[4096] = {0}; ssize_t length = read(fd, response, sizeof(response) - 1);
  if (length <= 0) return 65;
  const char *body = strstr(response, "\\r\\n\\r\\n"); if (!body) return 66;
  fputs(body + 4, stdout); return 0;
}
`);
  await execFileAsync('/usr/bin/clang', [parentSource, '-o', privateParentBinary], { timeout: 10_000 });
  await writeFile(path.join(control, 'contract.json'), '{}\n');
  await writeFile(path.join(outside, 'secret.txt'), 'not-readable\n');

  const server = createServer((_request, response) => response.end('router-ok'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const runtimeReadPaths = await resolveDroidV7RuntimeReadPaths([process.execPath]);
    assert.ok(runtimeReadPaths.files.some((value) => value.endsWith('/zoneinfo/UTC')));
    assert.ok(runtimeReadPaths.files.some((value) => value.endsWith('/zoneinfo/posixrules')));
    assert.ok(runtimeReadPaths.files.some((value) => value.endsWith('/icutz/icutz44l.dat')));
    assert.ok(runtimeReadPaths.roots.every((value) => !value.startsWith('/private/var/db/timezone/')));
    const profilePath = path.join(root, 'v7.sb');
    const profile = createDroidV7SandboxProfile({
      runDirectory: root,
      workspace,
      binaryPath: privateParentBinary,
      runtimeReadPaths,
      networkPort: port,
    });
    await writeFile(profilePath, profile, { mode: 0o600 });
    assert.match(profile, /\(deny file-read\*\)/);
    assert.match(profile, /\(allow file-read-metadata\)/);
    assert.doesNotMatch(profile, /\(deny file-write\*\)\s*$/m);
    assert.match(profile, new RegExp(`process-path ${JSON.stringify(privateParentBinary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(profile, /\(subpath "\/private\/etc"\)/);
    assert.doesNotMatch(profile, /\(subpath "\/usr"\)/);
    assert.doesNotMatch(profile, /\(subpath "\/usr\/local"\)/);

    const parentNetwork = await new Promise((resolve, reject) => {
      const processChild = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, privateParentBinary, String(port)], {
        cwd: workspace,
        env: { PATH: path.dirname(process.execPath), LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TMPDIR: workspace },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      processChild.stdout.on('data', (chunk) => stdout.push(chunk));
      processChild.stderr.on('data', (chunk) => stderr.push(chunk));
      processChild.once('error', reject);
      processChild.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    });
    assert.deepEqual(parentNetwork, { code: 0, signal: null, stdout: 'ready\nrouter-ok', stderr: '' });

    const probe = [
      "const fs=require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(path.join(workspace, 'write-ok.txt'))}, 'ok')`,
      `try { fs.readFileSync(${JSON.stringify(path.join(outside, 'secret.txt'))}); process.exit(41) } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error }`,
      `try { fs.readdirSync(${JSON.stringify(outside)}); process.exit(45) } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error }`,
      `try { fs.readdirSync('/usr/local'); process.exit(48) } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error }`,
      `if (!fs.statSync(${JSON.stringify(path.join(outside, 'secret.txt'))}).isFile()) process.exit(46)`,
      `try { fs.writeFileSync(${JSON.stringify(path.join(outside, 'write-denied.txt'))}, 'tamper'); process.exit(47) } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error }`,
      `try { fs.chmodSync(${JSON.stringify(privateParentBinary)}, 0o500); process.exit(50) } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error }`,
      `const privateLaunch=require('node:child_process').spawnSync(${JSON.stringify(privateParentBinary)}, [String(${port})]); if (!['EACCES','EPERM'].includes(privateLaunch.error?.code)) process.exit(51)`,
      `const nestedSandbox=require('node:child_process').spawnSync('/usr/bin/sandbox-exec', ['-p','(version 1) (allow default)','/usr/bin/true']); if (!['EACCES','EPERM'].includes(nestedSandbox.error?.code)) process.exit(52)`,
      `const copiedParent=${JSON.stringify(path.join(workspace, 'copied-parent-runtime'))}; fs.copyFileSync(${JSON.stringify(privateParentBinary)},copiedParent); fs.chmodSync(copiedParent,0o500); const copiedLaunch=require('node:child_process').spawnSync(copiedParent,[String(${port})]); if(copiedLaunch.status!==63) process.exit(53)`,
      `const linkedParent=${JSON.stringify(path.join(workspace, 'linked-parent-runtime'))}; try { fs.linkSync(${JSON.stringify(privateParentBinary)},linkedParent); const linkedLaunch=require('node:child_process').spawnSync(linkedParent,[String(${port})]); if(linkedLaunch.status!==63) process.exit(54) } catch(error) { if(!['EACCES','EPERM'].includes(error.code)) throw error }`,
      `try { fs.writeFileSync(${JSON.stringify(path.join(control, 'contract.json'))}, 'tamper') ; process.exit(42) } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error }`,
      `const request=require('node:http').get('http://localhost:${port}/',()=>process.exit(43)); request.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(44),2000)`,
    ].join(';');
    const child = await new Promise((resolve, reject) => {
      const processChild = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, '-e', probe], {
        cwd: workspace,
        env: { PATH: path.dirname(process.execPath), LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TMPDIR: workspace },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderr = [];
      processChild.stderr.on('data', (chunk) => stderr.push(chunk));
      processChild.once('error', reject);
      processChild.once('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') }));
    });
    assert.deepEqual(child, { code: 0, signal: null, stderr: '' });
    assert.equal(await readFile(path.join(workspace, 'write-ok.txt'), 'utf8'), 'ok');
    assert.equal(await readFile(path.join(control, 'contract.json'), 'utf8'), '{}\n');

    const launcher = droidV7SandboxLauncher({
      profilePath,
      droidBinary: privateParentBinary,
      runtimeReadPaths,
    });
    assert.equal(launcher.policy.network, 'loopback-router-droid-binary-only-model-children-denied');
    assert.equal(launcher.policy.defaultFilesystemAccess, 'denied');
    assert.equal(launcher.policy.outOfWorkspaceFileContents, 'denied');
    assert.equal(launcher.policy.outOfWorkspaceDirectoryEnumeration, 'denied-except-root-and-declared-runtime-roots');
    assert.equal(launcher.policy.rootDirectoryEnumeration, 'observable-macos-runtime-requirement');
    assert.equal(launcher.policy.outOfWorkspaceExactPathMetadata, 'observable-macos-sandbox-exec-limitation');
  } finally {
    await rm(privateParentBinary, { force: true });
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
