import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AgentValidationError,
  MAX_AGENT_BYTES,
  pairedGames,
  playGame,
  replayGame,
  runAgentMove,
  validateAgent,
} from '../src/runner.mjs';
import {
  canonicalJson,
  canonicalJsonSha256,
  createChecksumManifest,
  formatChecksumManifest,
  sha256,
  verifyChecksumManifest,
} from '../src/provenance.mjs';

async function fixture(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(dir, name), contents);
  return { dir, path: (name) => path.join(dir, name) };
}

test('validateAgent accepts one UTF-8 .js file and records its identity', async (t) => {
  const f = await fixture(t, { 'agent.js': "process.stdout.write('e2e4')\n" });
  const identity = await validateAgent(f.path('agent.js'));
  assert.equal(identity.fileName, 'agent.js');
  assert.equal(identity.sizeBytes, Buffer.byteLength("process.stdout.write('e2e4')\n"));
  assert.match(identity.sourceSha256, /^[0-9a-f]{64}$/);
});

test('validateAgent rejects wrong extension, oversize, and invalid UTF-8', async (t) => {
  const f = await fixture(t, {
    'agent.mjs': 'x',
    'huge.js': Buffer.alloc(MAX_AGENT_BYTES + 1, 97),
    'invalid.js': Buffer.from([0xc3, 0x28]),
  });
  await assert.rejects(validateAgent(f.path('agent.mjs')), (error) => error instanceof AgentValidationError && error.code === 'not_js');
  await assert.rejects(validateAgent(f.path('huge.js')), (error) => error.code === 'too_large');
  await assert.rejects(validateAgent(f.path('invalid.js')), (error) => error.code === 'invalid_utf8');
});

test('runAgentMove enforces exact stdout and classifies crash and timeout', async (t) => {
  const f = await fixture(t, {
    'ok.js': "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('e2e4\\n'))",
    'malformed.js': "console.log('move: e2e4')",
    'crash.js': "throw new Error('boom')",
    'timeout.js': 'setInterval(() => {}, 1000)',
  });
  assert.deepEqual((await runAgentMove({ agentPath: f.path('ok.js'), fen: 'fen' })).status, 'ok');
  assert.equal((await runAgentMove({ agentPath: f.path('malformed.js'), fen: 'fen' })).status, 'malformed');
  assert.equal((await runAgentMove({ agentPath: f.path('crash.js'), fen: 'fen' })).status, 'crash');
  assert.equal((await runAgentMove({ agentPath: f.path('timeout.js'), fen: 'fen', timeoutMs: 30 })).status, 'timeout');
});

test('runAgentMove sandbox denies extra files and network and strips parent secrets', async (t) => {
  const f = await fixture(t, {
    'secret.txt': 'secret',
    'reader.js': `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(path.join(os.tmpdir(), 'definitely-not-agent-source'))}); console.log('e2e4')`,
    'network.js': `import net from 'node:net'; net.connect(80, '127.0.0.1'); console.log('e2e4')`,
    'environment.js': `console.log(process.env.AGENTBATTLER_TEST_SECRET ? 'a1a8' : 'e2e4')`,
  });
  const result = await runAgentMove({ agentPath: f.path('reader.js'), fen: 'fen' });
  assert.equal(result.status, 'crash');
  assert.match(result.stderr, /permission|ERR_ACCESS_DENIED/i);
  const network = await runAgentMove({ agentPath: f.path('network.js'), fen: 'fen' });
  assert.equal(network.status, 'crash');
  assert.match(network.stderr, /permission|ERR_ACCESS_DENIED/i);
  process.env.AGENTBATTLER_TEST_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.AGENTBATTLER_TEST_SECRET; });
  assert.equal((await runAgentMove({ agentPath: f.path('environment.js'), fen: 'fen' })).move, 'e2e4');
});

test('playGame records each deterministic ply and replay verifies it', async (t) => {
  const source = `let fen='';process.stdin.on('data',c=>fen+=c);process.stdin.on('end',()=>{const p=fen.split(/\\s+/);const key=p[1]+p[5];const moves={w1:'e2e4',b1:'e7e5',w2:'g1f3',b2:'b8c6'};process.stdout.write(moves[key])})`;
  const f = await fixture(t, { 'a.js': source, 'b.js': source });
  const position = {
    id: 'initial',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    seed: 7,
    maxPlies: 4,
  };
  const result = await playGame({
    white: { id: 'a', path: f.path('a.js') },
    black: { id: 'b', path: f.path('b.js') },
    position,
  });
  assert.equal(result.final.outcome, '1/2-1/2');
  assert.equal(result.final.reason, 'max_plies');
  assert.deepEqual(result.plies.map((ply) => ply.move), ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  assert.ok(result.plies.every((ply) => ply.input && ply.resultingFen && ply.runtimeMs >= 0));
  assert.equal(replayGame(result).ok, true);
  assert.match(result.resultSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(pairedGames('a.js', 'b.js', position).map((game) => [game.white, game.black]), [
    ['a.js', 'b.js'], ['b.js', 'a.js'],
  ]);
});

test('playGame classifies illegal agent move as a forfeit', async (t) => {
  const f = await fixture(t, { 'bad.js': "console.log('a1a8')", 'good.js': "console.log('e7e5')" });
  const result = await playGame({
    white: { id: 'bad', path: f.path('bad.js') },
    black: { id: 'good', path: f.path('good.js') },
    position: { id: 'initial', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', maxPlies: 2 },
  });
  assert.equal(result.final.outcome, '0-1');
  assert.equal(result.final.reason, 'agent_illegal');
  assert.equal(result.final.failure.class, 'agent');
  assert.equal(result.plies[0].status, 'illegal');
  assert.equal(replayGame(result).ok, true);
  result.final = { outcome: '1-0', reason: 'max_plies', failure: null };
  delete result.resultSha256;
  result.resultSha256 = canonicalJsonSha256(result);
  assert.equal(replayGame(result).ok, false, 'replay must reject a re-hashed but incorrectly graded agent failure');
});

test('canonical JSON and checksum manifest are stable and verifiable', async (t) => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalJsonSha256({ b: 2, a: 1 }), sha256('{"a":1,"b":2}'));
  const f = await fixture(t, { 'b.txt': 'B', 'a.txt': 'A' });
  const manifest = await createChecksumManifest(['b.txt', 'a.txt'], { root: f.dir });
  assert.deepEqual(manifest.entries.map((entry) => entry.path), ['a.txt', 'b.txt']);
  assert.match(formatChecksumManifest(manifest), /^[0-9a-f]{64}  a\.txt\n[0-9a-f]{64}  b\.txt\n$/);
  assert.deepEqual(await verifyChecksumManifest(manifest, { root: f.dir }), { ok: true, mismatches: [] });
  await writeFile(f.path('a.txt'), 'changed');
  assert.equal((await verifyChecksumManifest(manifest, { root: f.dir })).ok, false);
});
