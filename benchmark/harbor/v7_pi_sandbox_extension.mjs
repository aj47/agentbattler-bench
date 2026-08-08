import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { createBashTool } from '@earendil-works/pi-coding-agent';

const WORKSPACE = realpathSync('/app');
const CONTROL_ROOT = `${WORKSPACE}/.agentbattler`;
// Arbitrary POSIX children can enumerate their own environment. Clear to a
// fixed non-secret set; do not claim the variable names themselves are hidden.
const SAFE_ENVIRONMENT = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  TMPDIR: '/tmp',
});
const CAPABILITY_GUARD = 'cap="$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)"; case "$cap" in ""|*[!0]*) echo "AgentBattler V7 command sandbox retained capabilities" >&2; exit 77;; esac; exec /bin/bash -lc "$1"';

function withinWorkspace(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const resolved = path.resolve(WORKSPACE, candidate);
  if (resolved !== WORKSPACE && !resolved.startsWith(`${WORKSPACE}${path.sep}`)) return false;
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  const real = realpathSync(existing);
  return real === WORKSPACE || real.startsWith(`${WORKSPACE}${path.sep}`);
}

function sandboxArguments(command, cwd) {
  if (!existsSync(CONTROL_ROOT)) throw new Error('V7 trusted control root is unavailable');
  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop', 'ALL',
    '--tmpfs', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--ro-bind', '/usr', '/usr',
    '--dir', '/etc',
    '--ro-bind', '/etc/passwd', '/etc/passwd',
    '--ro-bind', '/etc/group', '/etc/group',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--dir', WORKSPACE,
    '--bind', WORKSPACE, WORKSPACE,
    '--ro-bind', CONTROL_ROOT, CONTROL_ROOT,
    '--tmpfs', '/tmp',
    '--clearenv',
    ...Object.entries(SAFE_ENVIRONMENT).flatMap(([name, value]) => ['--setenv', name, value]),
    '--chdir', cwd,
    '--', '/bin/bash', '-c', CAPABILITY_GUARD, 'agentbattler-v7-capability-guard', command,
  ];
}

function sandboxedBashOperations() {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!withinWorkspace(cwd)) throw new Error('bash working directory is outside the benchmark workspace');
      return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/bwrap', sandboxArguments(command, cwd), {
          cwd,
          detached: true,
          env: SAFE_ENVIRONMENT,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let timedOut = false;
        const timer = Number.isFinite(timeout) && timeout > 0 ? setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, timeout * 1_000) : null;
        const abort = () => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('error', reject);
        child.once('close', (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) reject(new Error('aborted'));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

export default function agentBattlerV7PiSandbox(pi) {
  const bash = createBashTool(WORKSPACE, { operations: sandboxedBashOperations() });
  pi.registerTool({ ...bash, label: 'bash (AgentBattler V7 sandbox)' });

  pi.on('tool_call', (event) => {
    if (!['read', 'write', 'edit'].includes(event.toolName)) return;
    if (!withinWorkspace(event.input?.path)) {
      return { block: true, reason: `${event.toolName} is restricted to /app` };
    }
  });
}
