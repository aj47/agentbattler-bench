#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDroidSettings,
  DROID_VERSION,
  materializeDroidSettingsCredential,
} from '../src/droid-harness.mjs';
import { DroidJsonRpcSession } from '../src/droid-jsonrpc.mjs';
import { droidRouteModel, droidRouterConfig, preflightDroidRoute } from '../src/droid-routing.mjs';
import { verifyDroidRuntime } from '../src/droid-runtime.mjs';
import {
  assertDroidCredentialAbsent,
  createDroidSandboxProfile,
  droidSandboxLauncher,
  isolatedDroidEnvironment,
  requireDroidSandboxRuntime,
  retireDroidCredentialSettings,
} from '../src/droid-sandbox.mjs';

function invariant(condition, message) { if (!condition) throw new Error(message); }

const model = process.env.AGENTBATTLER_DROID_SMOKE_MODEL ?? 'gpt-5.6-terra';
const router = droidRouterConfig();
if (process.env.AGENTBATTLER_DROID_REQUIRE_CLIPROXY === '1') invariant(router.kind === 'cliproxy', `M4 preflight selected ${router.kind}, not CLIProxyAPI`);
const verifiedDroidRuntime = await verifyDroidRuntime(process.env);
const { binaryPath: droidBinary, ...droidRuntime } = verifiedDroidRuntime;
await preflightDroidRoute(router, model);

const root = await mkdtemp(path.join(os.homedir(), '.agentbattler-droid-live-'));
try {
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await Promise.all([
    mkdir(path.join(home, '.factory'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(home, 'tmp'), { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  const settingsPath = path.join(home, '.factory', 'settings.json');
  const settings = createDroidSettings({ baseUrl: router.baseUrl, upstreamModelPrefix: router.upstreamModelPrefix });
  const runtimeReadPaths = [process.execPath];
  const env = isolatedDroidEnvironment(home, path.join(home, 'tmp'), { executablePaths: runtimeReadPaths });
  const routeUrl = new URL(router.baseUrl);
  invariant(['127.0.0.1', 'localhost', '::1'].includes(routeUrl.hostname), 'Droid live validation requires a loopback router');
  const networkPort = Number(routeUrl.port || (routeUrl.protocol === 'https:' ? 443 : 80));
  const sandboxBinary = await requireDroidSandboxRuntime();
  const profilePath = path.join(root, 'droid-sandbox.sb');
  await writeFile(profilePath, createDroidSandboxProfile({ runDirectory: root, binaryPath: droidBinary, allowedReadPaths: runtimeReadPaths, networkPort }), { mode: 0o600 });
  const launcher = droidSandboxLauncher({ sandboxBinary, profilePath, droidBinary, allowedReadPaths: runtimeReadPaths });
  const session = new DroidJsonRpcSession({ workspace, model, env, timeoutMs: 120_000, launcher });
  let initialized;
  let firstSummary;
  let secondSummary;
  let commandSummary;
  const commandMarkerPath = path.join(workspace, 'command-env.txt');
  try {
    const runtimeSettings = materializeDroidSettingsCredential(settings, router.apiKey);
    await writeFile(settingsPath, `${JSON.stringify(runtimeSettings, null, 2)}\n`, { mode: 0o600 });
    initialized = await session.start();
    const retirement = await retireDroidCredentialSettings({ factoryHome: path.join(home, '.factory'), apiKey: router.apiKey });
    invariant(retirement.settingsFilesRemoved >= 1, 'Droid did not retire its credential settings before the first turn');
    await assertDroidCredentialAbsent({ runDirectory: root, apiKey: router.apiKey });
    firstSummary = (await session.turn('Reply with exactly ROUTE_OK. Do not use tools.')).summary;
    invariant(firstSummary.finalText.trim() === 'ROUTE_OK', `Unexpected first response: ${firstSummary.finalText}`);
    const command = `node -e "require('node:fs').writeFileSync('${commandMarkerPath}', process.env.AGENTBATTLER_DROID_API_KEY ? 'DIRTY' : 'CLEAN')"`;
    commandSummary = (await session.turn(`You must use the Execute tool to run this exact command, and must not answer until it succeeds:\n${command}\nThen reply with exactly COMMAND_ENV_CHECKED.`)).summary;
    const commandMarker = await readFile(commandMarkerPath, 'utf8').catch(() => null);
    invariant(commandMarker === 'CLEAN', `Droid model-command credential check failed (marker=${commandMarker ?? 'missing'}, toolCalls=${commandSummary.toolCallCount})`);
    await rm(commandMarkerPath);
    secondSummary = (await session.turn('Reply with exactly RESUME_OK. Do not use tools.')).summary;
    invariant(secondSummary.sessionId === firstSummary.sessionId, 'Droid changed session ID between turns');
    invariant(secondSummary.finalText.trim() === 'RESUME_OK', `Unexpected second response: ${secondSummary.finalText}`);
    await assertDroidCredentialAbsent({ runDirectory: root, apiKey: router.apiKey });
  } finally {
    await session.close();
    await retireDroidCredentialSettings({ factoryHome: path.join(home, '.factory'), apiKey: router.apiKey });
    await assertDroidCredentialAbsent({ runDirectory: root, apiKey: router.apiKey });
  }
  console.log(JSON.stringify({
    schemaVersion: 'agentbattler.droid-live-validation.v1',
    droidVersion: DROID_VERSION,
    binarySha256: droidRuntime.binarySha256,
    routeKind: router.kind,
    transport: router.provenance,
    baseUrl: router.baseUrl,
    model,
    upstreamModel: droidRouteModel(router, model),
    turns: 3,
    sessionId: initialized.sessionId,
    sameSessionProof: true,
    apiKeyInheritedByModelCommands: false,
    apiKeyDelivery: 'ephemeral-settings-settled-and-retired-before-first-turn',
    filesystemIsolation: launcher.policy,
    contextLimit: initialized.settings.context.limit,
    restrictedToolIds: initialized.settings.restrictToolIds,
    usage: {
      inputTokens: firstSummary.usage.inputTokens + commandSummary.usage.inputTokens + secondSummary.usage.inputTokens,
      cachedInputTokens: firstSummary.usage.cachedInputTokens + commandSummary.usage.cachedInputTokens + secondSummary.usage.cachedInputTokens,
      outputTokens: firstSummary.usage.outputTokens + commandSummary.usage.outputTokens + secondSummary.usage.outputTokens,
      reasoningTokens: firstSummary.usage.reasoningTokens + commandSummary.usage.reasoningTokens + secondSummary.usage.reasoningTokens,
    },
  }, null, 2));
} finally {
  if (process.env.AGENTBATTLER_DROID_KEEP === '1') console.error(`Preserved Droid live-smoke state: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
