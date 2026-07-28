import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultCliProxyRuntimeRoot,
  formatCliProxyContainerState,
  validatePersistentCliProxyRuntimeRoot,
} from '../src/cliproxy-runtime.mjs';

test('CLIProxy runtime defaults to persistent user storage', () => {
  assert.equal(defaultCliProxyRuntimeRoot('/Users/example'), '/Users/example/AgentBattlerRuntime/cliproxy-v5');
  assert.equal(validatePersistentCliProxyRuntimeRoot('/Users/example/AgentBattlerRuntime/cliproxy-v5', ['/tmp', '/private/tmp']), '/Users/example/AgentBattlerRuntime/cliproxy-v5');
});

test('CLIProxy runtime rejects reboot-ephemeral storage', () => {
  assert.throws(() => validatePersistentCliProxyRuntimeRoot('/private/tmp/agentbattler', ['/tmp', '/private/tmp']), /must be persistent/);
  assert.throws(() => validatePersistentCliProxyRuntimeRoot('/tmp/agentbattler', ['/tmp', '/private/tmp']), /must be persistent/);
});

test('CLIProxy status supports Docker state without a healthcheck', () => {
  assert.equal(formatCliProxyContainerState('{"Status":"running"}'), 'running');
  assert.equal(formatCliProxyContainerState({ Status: 'running', Health: { Status: 'healthy' } }), 'running healthy');
  assert.throws(() => formatCliProxyContainerState('{}'), /invalid/);
});
