#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  createDroidSettings,
  DROID_CONTEXT_POLICY,
  DROID_RESTRICTED_TOOLS,
  DROID_VERSION,
  droidExecArgs,
  parseDroidEventStream,
  summarizeDroidEvents,
} from '../src/droid-harness.mjs';
import { droidRouterConfig, preflightDroidRoute } from '../src/droid-routing.mjs';
import { verifyDroidRuntime } from '../src/droid-runtime.mjs';

function invariant(condition, message) { if (!condition) throw new Error(message); }

function runDroid(args, { cwd, env, prompt }) {
  return new Promise((resolve, reject) => {
    const child = spawn('droid', args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(prompt, 'utf8');
  });
}

const requests = [];
const droidRuntime = await verifyDroidRuntime(process.env);
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: null });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6-terra', object: 'model' }] }));
      return;
    }
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const responseId = 'resp_droid_smoke';
    const item = { id: 'msg_droid_smoke', type: 'message', status: 'completed', content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'OK' }], role: 'assistant' };
    const completed = { id: responseId, object: 'response', created_at: 1, status: 'completed', completed_at: 2, error: null, incomplete_details: null, model: 'gpt-5.6-terra', output: [item], parallel_tool_calls: true, tool_choice: 'auto', tools: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 101 } };
    for (const event of [
      { type: 'response.created', response: { ...completed, status: 'in_progress', completed_at: null, output: [], usage: null }, sequence_number: 0 },
      { type: 'response.output_item.added', item: { ...item, status: 'in_progress', content: [] }, output_index: 0, sequence_number: 1 },
      { type: 'response.content_part.added', content_index: 0, item_id: item.id, output_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' }, sequence_number: 2 },
      { type: 'response.output_text.delta', content_index: 0, delta: 'OK', item_id: item.id, logprobs: [], output_index: 0, sequence_number: 3 },
      { type: 'response.output_text.done', content_index: 0, item_id: item.id, logprobs: [], output_index: 0, sequence_number: 4, text: 'OK' },
      { type: 'response.content_part.done', content_index: 0, item_id: item.id, output_index: 0, part: item.content[0], sequence_number: 5 },
      { type: 'response.output_item.done', item, output_index: 0, sequence_number: 6 },
      { type: 'response.completed', response: completed, sequence_number: 7 },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-droid-routing-'));
try {
  const droidHome = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const factoryHome = path.join(droidHome, '.factory');
  const settingsPath = path.join(factoryHome, 'settings.json');
  await Promise.all([factoryHome, workspace].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const route = droidRouterConfig({
    AGENTBATTLER_CLIPROXY_BASE_URL: baseUrl,
    AGENTBATTLER_CLIPROXY_API_KEY: 'c'.repeat(64),
    AGENTBATTLER_CLIPROXY_COMMIT: 'a'.repeat(40),
    AGENTBATTLER_CLIPROXY_CATALOG_COMMIT: 'b'.repeat(40),
    AGENTBATTLER_CLIPROXY_MODELS_SHA256: 'c'.repeat(64),
    AGENTBATTLER_CLIPROXY_CODEX_MODELS_SHA256: 'd'.repeat(64),
    AGENTBATTLER_CLIPROXY_IMAGE_ID: 'sha256:mock-image',
    AGENTBATTLER_CLIPROXY_CONFIG_SHA256: 'e'.repeat(64),
    AGENTBATTLER_CLIPROXY_RUNTIME_SHA256: 'f'.repeat(64),
  });
  await preflightDroidRoute(route, 'gpt-5.6-terra');
  await writeFile(settingsPath, `${JSON.stringify(createDroidSettings({ baseUrl: route.baseUrl, upstreamModelPrefix: route.upstreamModelPrefix }), null, 2)}\n`, { mode: 0o600 });
  const env = {
    PATH: process.env.PATH,
    HOME: droidHome,
    TMPDIR: root,
    AGENTBATTLER_DROID_API_KEY: route.apiKey,
    NO_COLOR: '1',
  };
  const args = droidExecArgs({ workspace, model: 'gpt-5.6-terra' });
  const result = await runDroid(args, { cwd: workspace, env, prompt: 'Reply exactly OK. Do not use tools.' });
  if (process.env.AGENTBATTLER_DROID_DEBUG === '1') console.error(JSON.stringify(requests, null, 2));
  invariant(result.exitCode === 0, `Droid routing smoke exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  const events = parseDroidEventStream(result.stdout);
  if (process.env.AGENTBATTLER_DROID_DEBUG === '1') console.error(JSON.stringify(events, null, 2));
  const summary = summarizeDroidEvents(events);
  const modelRequests = requests.filter((request) => request.url === '/v1/responses');
  invariant(modelRequests.length === 1, `Expected one model request, received ${modelRequests.length}`);
  const captured = modelRequests[0];
  invariant(captured.method === 'POST' && captured.url === '/v1/responses', `Unexpected Droid route: ${captured.method} ${captured.url}`);
  invariant(captured.body.model === 'gpt-5.6-terra', `Droid sent model ${captured.body.model}`);
  invariant(captured.body.max_output_tokens === DROID_CONTEXT_POLICY.maxOutputTokens, `Droid max_output_tokens was ${captured.body.max_output_tokens}`);
  invariant(captured.body.reasoning?.effort === 'high' && captured.body.reasoning_effort === 'high', `Droid reasoning effort was ${captured.body.reasoning?.effort ?? captured.body.reasoning_effort}`);
  const requestedTools = (captured.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter(Boolean).sort();
  invariant(JSON.stringify(requestedTools) === JSON.stringify([...DROID_RESTRICTED_TOOLS].sort()), `Droid sent unexpected tool schemas: ${requestedTools.join(', ')}`);
  invariant(captured.headers.authorization === `Bearer ${route.apiKey}`, 'Droid did not expand the API key environment reference');
  console.log(JSON.stringify({
    schemaVersion: 'agentbattler.droid-routing-validation.v1',
    droidVersion: DROID_VERSION,
    binarySha256: droidRuntime.binarySha256,
    routeKind: route.kind,
    transport: route.provenance,
    route: captured.url,
    upstreamModel: captured.body.model,
    maxOutputTokens: captured.body.max_output_tokens,
    reasoningEffort: captured.body.reasoning_effort,
    compactionPolicy: DROID_CONTEXT_POLICY,
    restrictedTools: DROID_RESTRICTED_TOOLS,
    sessionId: summary.sessionId,
    eventTypes: events.map((event) => event.type),
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
