import { droidUpstreamModel, normalizeDroidBaseUrl } from './droid-harness.mjs';

const CLIPROXY_ENVIRONMENT = Object.freeze({
  baseUrl: 'AGENTBATTLER_CLIPROXY_BASE_URL',
  apiKey: 'AGENTBATTLER_CLIPROXY_API_KEY',
  commit: 'AGENTBATTLER_CLIPROXY_COMMIT',
  catalogCommit: 'AGENTBATTLER_CLIPROXY_CATALOG_COMMIT',
  modelsSha256: 'AGENTBATTLER_CLIPROXY_MODELS_SHA256',
  codexModelsSha256: 'AGENTBATTLER_CLIPROXY_CODEX_MODELS_SHA256',
  imageId: 'AGENTBATTLER_CLIPROXY_IMAGE_ID',
  configSha256: 'AGENTBATTLER_CLIPROXY_CONFIG_SHA256',
  runtimeSha256: 'AGENTBATTLER_CLIPROXY_RUNTIME_SHA256',
});

function invariant(condition, message) { if (!condition) throw new Error(message); }

function loopback(url) {
  return ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname);
}

function apiKeyFor({ baseUrl, requestedApiKey, label }) {
  invariant(loopback(baseUrl) || requestedApiKey, `${label} API key is required for a non-loopback URL`);
  const apiKey = requestedApiKey ?? 'local-router-no-auth';
  invariant(typeof apiKey === 'string' && apiKey.length > 0, `${label} API key must not be empty`);
  return apiKey;
}

function cliProxyConfig(environment) {
  const values = Object.fromEntries(Object.entries(CLIPROXY_ENVIRONMENT).map(([name, variable]) => [name, environment[variable]]));
  if (Object.values(values).every((value) => value === undefined)) return null;
  invariant(Object.values(values).every((value) => typeof value === 'string' && value.length > 0), 'Set all AGENTBATTLER_CLIPROXY_* provenance variables for Droid proxy routing');
  invariant(/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(values.baseUrl), 'Droid CLIProxyAPI endpoint must use loopback HTTP');
  invariant(values.apiKey.length >= 32, 'CLIProxyAPI key is too short');
  invariant(/^[0-9a-f]{40}$/.test(values.commit), 'CLIProxyAPI commit must be a full Git SHA');
  invariant(/^[0-9a-f]{40}$/.test(values.catalogCommit), 'CLIProxyAPI catalog commit must be a full Git SHA');
  invariant(/^[0-9a-f]{64}$/.test(values.modelsSha256) && /^[0-9a-f]{64}$/.test(values.codexModelsSha256), 'CLIProxyAPI catalog hashes must be SHA-256');
  invariant(/^[0-9a-f]{64}$/.test(values.configSha256), 'CLIProxyAPI config hash must be SHA-256');
  invariant(/^[0-9a-f]{64}$/.test(values.runtimeSha256), 'CLIProxyAPI runtime hash must be SHA-256');
  return {
    kind: 'cliproxy',
    providerId: 'cliproxyapi',
    baseUrl: normalizeDroidBaseUrl(values.baseUrl),
    apiKey: values.apiKey,
    upstreamModelPrefix: '',
    provenance: {
      name: 'CLIProxyAPI',
      commit: values.commit,
      catalogCommit: values.catalogCommit,
      modelsSha256: values.modelsSha256,
      codexModelsSha256: values.codexModelsSha256,
      imageId: values.imageId,
      configSha256: values.configSha256,
      runtimeSha256: values.runtimeSha256,
    },
  };
}

export function droidRouterConfig(environment = process.env) {
  const hasExplicitDroidRoute = ['AGENTBATTLER_DROID_BASE_URL', 'AGENTBATTLER_DROID_API_KEY', 'AGENTBATTLER_DROID_MODEL_PREFIX']
    .some((name) => environment[name] !== undefined);
  if (hasExplicitDroidRoute) {
    const rawBaseUrl = environment.AGENTBATTLER_DROID_BASE_URL;
    invariant(typeof rawBaseUrl === 'string' && rawBaseUrl.length > 0, 'AGENTBATTLER_DROID_BASE_URL is required when overriding Droid routing');
    const baseUrl = normalizeDroidBaseUrl(rawBaseUrl);
    const upstreamModelPrefix = environment.AGENTBATTLER_DROID_MODEL_PREFIX ?? 'cx/';
    droidUpstreamModel('gpt-5.6-terra', upstreamModelPrefix);
    return {
      kind: 'custom',
      providerId: 'custom-openai-compatible',
      baseUrl,
      apiKey: apiKeyFor({ baseUrl, requestedApiKey: environment.AGENTBATTLER_DROID_API_KEY, label: 'Droid custom route' }),
      upstreamModelPrefix,
      provenance: { name: 'custom-openai-compatible', modelPrefix: upstreamModelPrefix },
    };
  }

  const proxy = cliProxyConfig(environment);
  if (proxy) return proxy;

  const baseUrl = normalizeDroidBaseUrl(environment.NINEROUTER_URL ?? 'http://127.0.0.1:20128');
  return {
    kind: '9router',
    providerId: '9router-openai-compatible',
    baseUrl,
    apiKey: apiKeyFor({ baseUrl, requestedApiKey: environment.NINEROUTER_KEY, label: '9Router' }),
    upstreamModelPrefix: 'cx/',
    provenance: { name: '9Router', mode: environment.NINEROUTER_URL ? 'configured' : 'local-default' },
  };
}

export function droidRouteModel(route, model) {
  invariant(route && typeof route === 'object', 'Droid route is required');
  return droidUpstreamModel(model, route.upstreamModelPrefix);
}

export async function preflightDroidRoute(route, model, { timeoutMs = 10_000 } = {}) {
  const response = await fetch(`${route.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${route.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const content = await response.text();
  invariant(response.ok, `${route.provenance.name} model preflight failed (${response.status}): ${content}`);
  const payload = JSON.parse(content);
  const expectedModel = droidRouteModel(route, model);
  invariant(payload.data?.some((entry) => entry?.id === expectedModel), `${route.provenance.name} does not advertise ${expectedModel}`);
  return { expectedModel, models: payload.data.map((entry) => entry.id) };
}
