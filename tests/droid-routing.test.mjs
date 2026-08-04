import assert from 'node:assert/strict';
import test from 'node:test';

import { droidRouteModel, droidRouterConfig } from '../src/droid-routing.mjs';

const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);

function cliProxyEnvironment(overrides = {}) {
  return {
    AGENTBATTLER_CLIPROXY_BASE_URL: 'http://127.0.0.1:8317',
    AGENTBATTLER_CLIPROXY_API_KEY: 'c'.repeat(64),
    AGENTBATTLER_CLIPROXY_COMMIT: SHA40,
    AGENTBATTLER_CLIPROXY_CATALOG_COMMIT: SHA40,
    AGENTBATTLER_CLIPROXY_MODELS_SHA256: SHA64,
    AGENTBATTLER_CLIPROXY_CODEX_MODELS_SHA256: SHA64,
    AGENTBATTLER_CLIPROXY_IMAGE_ID: 'sha256:image',
    AGENTBATTLER_CLIPROXY_CONFIG_SHA256: SHA64,
    AGENTBATTLER_CLIPROXY_RUNTIME_SHA256: SHA64,
    ...overrides,
  };
}

test('Droid automatically uses the sourced M4 CLIProxy route and canonical model IDs', () => {
  const route = droidRouterConfig(cliProxyEnvironment());
  assert.equal(route.kind, 'cliproxy');
  assert.equal(route.baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(route.upstreamModelPrefix, '');
  assert.equal(droidRouteModel(route, 'gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.deepEqual(route.provenance, {
    name: 'CLIProxyAPI', commit: SHA40, catalogCommit: SHA40,
    modelsSha256: SHA64, codexModelsSha256: SHA64, imageId: 'sha256:image',
    configSha256: SHA64, runtimeSha256: SHA64,
  });
});

test('explicit Droid routing wins over CLIProxy and supports a custom model prefix', () => {
  const route = droidRouterConfig(cliProxyEnvironment({
    AGENTBATTLER_DROID_BASE_URL: 'https://gateway.example.test/openai',
    AGENTBATTLER_DROID_API_KEY: 'secret',
    AGENTBATTLER_DROID_MODEL_PREFIX: 'models/',
  }));
  assert.equal(route.kind, 'custom');
  assert.equal(route.baseUrl, 'https://gateway.example.test/openai/v1');
  assert.equal(droidRouteModel(route, 'gpt-5.6-sol'), 'models/gpt-5.6-sol');
});

test('Droid retains the local 9Router fallback and fails closed on partial CLIProxy provenance', () => {
  const route = droidRouterConfig({});
  assert.equal(route.kind, '9router');
  assert.equal(route.baseUrl, 'http://127.0.0.1:20128/v1');
  assert.equal(droidRouteModel(route, 'gpt-5.6-terra'), 'cx/gpt-5.6-terra');
  assert.throws(() => droidRouterConfig({ AGENTBATTLER_CLIPROXY_BASE_URL: 'http://127.0.0.1:8317' }), /Set all AGENTBATTLER_CLIPROXY/);
});
