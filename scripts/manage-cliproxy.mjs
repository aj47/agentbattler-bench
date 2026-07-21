#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COMMIT = 'db82d65d1cc3be6dc9662ee2b9a3810ac948d377';
const IMAGE = `agentbattler-cliproxy:${COMMIT.slice(0, 12)}`;
const CONTAINER = 'agentbattler-cliproxy';
const NETWORK = 'agentbattler-cliproxy';
const PORT = 8317;
const SERVER_ARGS = ['./CLIProxyAPI', '-config', '/CLIProxyAPI/config.yaml', '-local-model'];
const command = process.argv[2];
const runtimeRoot = path.resolve(process.argv[3] ?? '/private/tmp/agentbattler-cliproxy-v4');
const configPath = path.join(runtimeRoot, 'config.yaml');
const keyPath = path.join(runtimeRoot, 'api-key');
const authPath = path.join(runtimeRoot, 'auth');
const envPath = path.join(runtimeRoot, 'benchmark.env');

function invariant(condition, message) { if (!condition) throw new Error(message); }

async function run(program, args, { capture = false, allowFailure = false, interactive = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: interactive ? 'inherit' : capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    const stdout = []; const stderr = [];
    if (capture) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${program} exited ${code}${result.stderr ? `: ${result.stderr}` : ''}`));
    });
  });
}

async function docker(args, options) {
  const candidates = ['/usr/local/bin/docker', 'docker'];
  let lastError;
  for (const candidate of candidates) {
    try { return await run(candidate, args, options); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('Docker is unavailable');
}

async function initialize() {
  await mkdir(authPath, { recursive: true, mode: 0o700 });
  let apiKey;
  try { apiKey = (await readFile(keyPath, 'utf8')).trim(); } catch {
    apiKey = randomBytes(32).toString('hex');
    await writeFile(keyPath, `${apiKey}\n`, { mode: 0o600 });
  }
  invariant(/^[0-9a-f]{64}$/.test(apiKey), 'Invalid saved CLIProxyAPI key');
  const config = `host: "0.0.0.0"
port: ${PORT}
tls:
  enable: false
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
auth-dir: "/data/auth"
api-keys:
  - "${apiKey}"
debug: false
commercial-mode: true
logging-to-file: false
usage-statistics-enabled: false
passthrough-headers: false
request-retry: 3
max-retry-credentials: 1
max-retry-interval: 30
disable-cooling: false
save-cooldown-status: false
transient-error-cooldown-seconds: 5
disable-image-generation: true
quota-exceeded:
  switch-project: false
  switch-preview-model: false
  antigravity-credits: false
routing:
  strategy: "fill-first"
  session-affinity: true
  session-affinity-ttl: "24h"
`;
  await writeFile(configPath, config, { mode: 0o600 });
  const configSha256 = createHash('sha256').update(config).digest('hex');
  const imageId = (await docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { capture: true })).stdout;
  const runtimeSha256 = createHash('sha256').update(JSON.stringify({ imageId, configSha256, serverArgs: SERVER_ARGS })).digest('hex');
  const env = [
    `export AGENTBATTLER_CLIPROXY_BASE_URL='http://127.0.0.1:${PORT}'`,
    `export AGENTBATTLER_CLIPROXY_DOCKER_BASE_URL='http://${CONTAINER}:${PORT}/v1'`,
    `export AGENTBATTLER_CLIPROXY_API_KEY='${apiKey}'`,
    `export AGENTBATTLER_CLIPROXY_DOCKER_NETWORK='${NETWORK}'`,
    `export AGENTBATTLER_CLIPROXY_COMMIT='${COMMIT}'`,
    `export AGENTBATTLER_CLIPROXY_IMAGE_ID='${imageId}'`,
    `export AGENTBATTLER_CLIPROXY_CONFIG_SHA256='${configSha256}'`,
    `export AGENTBATTLER_CLIPROXY_RUNTIME_SHA256='${runtimeSha256}'`,
    '',
  ].join('\n');
  await writeFile(envPath, env, { mode: 0o600 });
  console.log(`Initialized ${runtimeRoot}`);
  console.log(`Config SHA-256: ${configSha256}`);
  console.log(`Image: ${imageId}`);
  console.log(`Runtime SHA-256: ${runtimeSha256}`);
}

async function ensureInitialized() {
  await readFile(configPath, 'utf8').catch(() => { throw new Error(`Run ${process.argv[1]} init first`); });
}

async function login() {
  await ensureInitialized();
  await docker([
    'run', '--rm', '--interactive', '--tty',
    '--volume', `${configPath}:/CLIProxyAPI/config.yaml:ro`,
    '--volume', `${authPath}:/data/auth:rw`,
    IMAGE, './CLIProxyAPI', '-config', '/CLIProxyAPI/config.yaml', '-codex-device-login', '-no-browser',
  ], { interactive: true });
}

async function start() {
  await ensureInitialized();
  await docker(['network', 'inspect', NETWORK], { capture: true, allowFailure: true }).then(async (result) => {
    if (result.code !== 0) await docker(['network', 'create', '--internal=false', NETWORK]);
  });
  await docker(['rm', '--force', CONTAINER], { capture: true, allowFailure: true });
  await docker([
    'run', '--detach', '--name', CONTAINER, '--restart', 'unless-stopped',
    '--network', NETWORK,
    '--publish', `127.0.0.1:${PORT}:${PORT}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    '--volume', `${configPath}:/CLIProxyAPI/config.yaml:ro`,
    '--volume', `${authPath}:/data/auth:rw`,
    IMAGE, ...SERVER_ARGS,
  ], { capture: true });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1_000) })).ok) {
        console.log(`CLIProxyAPI is healthy; source ${envPath} before benchmark runs.`);
        return;
      }
    } catch { /* Wait for the container. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('CLIProxyAPI did not become healthy');
}

async function status() {
  const result = await docker(['inspect', CONTAINER, '--format', '{{.State.Status}} {{.State.Health.Status}}'], { capture: true, allowFailure: true });
  console.log(result.code === 0 ? result.stdout.replace(' <no value>', '') : 'not running');
}

if (command === 'init') await initialize();
else if (command === 'login') await login();
else if (command === 'start') await start();
else if (command === 'status') await status();
else throw new Error('Usage: manage-cliproxy.mjs <init|login|start|status> [runtime-directory]');
