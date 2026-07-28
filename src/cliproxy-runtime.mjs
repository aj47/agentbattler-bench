import os from 'node:os';
import path from 'node:path';

export function defaultCliProxyRuntimeRoot(home = os.homedir()) {
  return path.join(home, 'AgentBattlerRuntime', 'cliproxy-v5');
}

function contains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validatePersistentCliProxyRuntimeRoot(runtimeRoot, temporaryRoots = [os.tmpdir(), '/tmp', '/private/tmp']) {
  if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) throw new Error('CLIProxyAPI runtime root is required');
  const resolved = path.resolve(runtimeRoot);
  if (temporaryRoots.some((temporaryRoot) => contains(temporaryRoot, resolved))) {
    throw new Error(`CLIProxyAPI runtime root must be persistent, not under a temporary directory: ${resolved}`);
  }
  return resolved;
}

export function formatCliProxyContainerState(value) {
  const state = typeof value === 'string' ? JSON.parse(value) : value;
  if (!state || typeof state !== 'object' || typeof state.Status !== 'string') throw new Error('Docker returned an invalid CLIProxyAPI state');
  return [state.Status, state.Health?.Status].filter(Boolean).join(' ');
}
