import { createHash, createHmac } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  V7_PHASES,
  V7_REQUIREMENTS_SHA256,
  V7_SCORE_GROUPS,
  canonicalJson,
  sha256,
} from './requirements.mjs';

export const V7_CHALLENGE_ID = 'terminal-mini-ledger-v7';
export const V7_PACK_SCHEMA = 'agentbattler.mini-ledger-v7.pack.v1';
export const V7_SEALED_PACK_SCHEMA = 'agentbattler.mini-ledger-v7.sealed-pack.v1';

const HERE = import.meta.dirname;
const STARTER_ROOT = path.join(HERE, 'starter');
const TICKET_ROOT = path.join(HERE, 'tickets');
const REQUIREMENT_MAP = JSON.parse(readFileSync(path.join(HERE, 'requirement-map.json'), 'utf8'));
const COMBINED_VERIFIER_SHA256 = sha256(readFileSync(path.join(HERE, 'verifier.mjs')));
const DEV_SEED_KEY = 'mini-ledger-v7-public-development-key-v1';
const VARIANTS = new Set(['clean', 'decoy']);
const PHASE_PAYLOAD_SCHEMA = 'agentbattler.mini-ledger-v7.phase-payload-commitment.v1';
const PACK_SHA256_SENTINEL = '<bound-by-pack-descriptor>';
const PHASE_DELTA_SHA256_SENTINEL = '<self-bound-phase-delta>';
const EXECUTABLE_SOURCE_SHA256_SENTINEL = '<bound-at-phase-entry>';

export const V7_ARTIFACT_POLICY = Object.freeze({
  sourceAllowlist: Object.freeze(['package.json', 'bin/**', 'src/**', 'config/**']),
  declaredResponseAllowlist: Object.freeze(['incident-response.json']),
  maxFiles: 256,
  maxBytes: 4 * 1024 * 1024,
  regularFilesOnly: true,
});

export const V7_VERIFIER_HASHES = Object.freeze({
  public: COMBINED_VERIFIER_SHA256,
  private: COMBINED_VERIFIER_SHA256,
  adaptability: COMBINED_VERIFIER_SHA256,
});

export const V7_POOL_INSTANCES = Object.freeze({
  dev: Object.freeze(['dev-01', 'dev-02', 'dev-03']),
  release: Object.freeze(['release-01', 'release-02', 'release-03', 'release-04', 'release-05']),
  reserve: Object.freeze(['reserve-01', 'reserve-02', 'reserve-03', 'reserve-04', 'reserve-05']),
});

export const V7_HIDDEN_CASES = Object.freeze([
  { id: 'p1-legacy-order', phase: 1 },
  { id: 'p1-roundtrip-compatibility', phase: 1 },
  { id: 'p1-malformed-no-mutation', phase: 1 },
  { id: 'p2-batch-idempotency', phase: 2 },
  { id: 'p2-key-collision', phase: 2 },
  { id: 'p2-opaque-cursor-boundaries', phase: 2 },
  { id: 'p2-cursor-filter-binding', phase: 2 },
  { id: 'p3-concurrent-append', phase: 3 },
  { id: 'p3-import-compact-serialization', phase: 3 },
  { id: 'p3-termination-recovery', phase: 3 },
  { id: 'p4-evidence-lineage', phase: 4 },
  { id: 'p4-executable-source-preservation', phase: 4 },
  { id: 'p5-corrupt-primary-recovery', phase: 5 },
  { id: 'p5-fork-rejection', phase: 5 },
  { id: 'p5-replay-audit', phase: 5 },
  { id: 'p5-mixed-scale', phase: 5 },
]);

const PATHS = Object.freeze({
  entrypoint: 'bin/ledger.mjs',
  currentControlDirectory: '.agentbattler/current',
  currentTicket: '.agentbattler/current/TASK.md',
  currentContract: '.agentbattler/current/task-contract.json',
  currentSmoke: '.agentbattler/current/smoke.mjs',
  packageManifest: 'package.json',
  artifactManifest: 'var/artifact-manifest.json',
  canonicalLedger: 'ledger.json',
  incidentEvidence: '.agentbattler/current/incident-evidence.json',
  incidentResponse: 'incident-response.json',
});

const CONTROL_FILES = Object.freeze({
  ticket: 'TASK.md',
  contract: 'task-contract.json',
  smoke: 'smoke.mjs',
  incidentEvidence: 'incident-evidence.json',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function listTreeSync(root, relative = '') {
  const entries = [];
  for (const item of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, item.name) : item.name;
    if (item.isDirectory()) entries.push(...listTreeSync(root, child));
    else if (item.isFile()) entries.push([child, readFileSync(path.join(root, ...child.split('/')))]);
    else throw new Error(`Unsupported V7 starter entry: ${child}`);
  }
  return entries;
}

const TEMPLATE_FILES = Object.freeze(listTreeSync(STARTER_ROOT));
const TEMPLATE_FILE_MAP = new Map(TEMPLATE_FILES);

export const V7_AUXILIARY_TWIN_CLASSES = Object.freeze([
  Object.freeze({
    id: 'superseded-adrs',
    variantPaths: Object.freeze(['docs/adr/0001-archive-as-primary.md']),
    provenancePaths: Object.freeze(['docs/adr/0001-archive-as-primary.md', 'docs/adr/0004-manifest-authority.md']),
  }),
  Object.freeze({
    id: 'deprecated-schema-examples',
    variantPaths: Object.freeze(['docs/schemas/ledger-v0.deprecated.json', 'test/fixtures/legacy-v0.json']),
    provenancePaths: Object.freeze(['docs/schemas/ledger-v0.deprecated.json', 'config/test-policy.json']),
  }),
  Object.freeze({
    id: 'dead-legacy-module',
    variantPaths: Object.freeze(['legacy/ledger-v0.js']),
    provenancePaths: Object.freeze(['legacy/README.md', 'package.json', 'bin/ledger.mjs', 'src/cli.mjs']),
  }),
  Object.freeze({
    id: 'excluded-legacy-tests',
    variantPaths: Object.freeze(['test/legacy/excluded-v0.test.mjs']),
    provenancePaths: Object.freeze(['package.json', 'config/test-policy.json']),
  }),
  Object.freeze({
    id: 'historical-operational-evidence',
    variantPaths: Object.freeze(['var/archive/snapshot.json', 'var/logs/worker.log', 'var/incidents/closed-import-lag.json']),
    provenancePaths: Object.freeze(['var/artifact-manifest.json', 'docs/data-authority.md']),
  }),
]);

function matchedTwinBytes(cleanSource, decoySource, label) {
  const sources = [String(cleanSource), String(decoySource)];
  const lines = sources.map((source) => source.split('\n'));
  invariant(lines[0].length === lines[1].length, `${label} clean/decoy line structure changed`);
  const widths = lines[0].map((line, index) => Math.max(Buffer.byteLength(line), Buffer.byteLength(lines[1][index])));
  const bytes = lines.map((sourceLines) => Buffer.from(sourceLines.map((line, index) => (
    `${line}${' '.repeat(widths[index] - Buffer.byteLength(line))}`
  )).join('\n')));
  invariant(bytes[0].length === bytes[1].length, `${label} clean/decoy bytes are not length matched`);
  return Object.freeze({ clean: bytes[0], decoy: bytes[1] });
}

function matchedTwinValues(cleanValue, decoyValue, label) {
  const clean = String(cleanValue);
  const decoy = String(decoyValue);
  const maximum = Math.max(Buffer.byteLength(clean), Buffer.byteLength(decoy));
  const pair = Object.freeze({
    clean: clean.padEnd(maximum, ' '),
    decoy: decoy.padEnd(maximum, ' '),
  });
  invariant(Buffer.byteLength(pair.clean) === Buffer.byteLength(pair.decoy), `${label} clean/decoy values are not length matched`);
  return pair;
}

function jsonTwin(clean, decoy, label) {
  invariant(canonicalJson(Object.keys(clean)) === canonicalJson(Object.keys(decoy)), `${label} clean/decoy JSON fields changed`);
  return matchedTwinBytes(`${JSON.stringify(clean, null, 2)}\n`, `${JSON.stringify(decoy, null, 2)}\n`, label);
}

function auxiliaryTwinFiles() {
  const adrDecoy = TEMPLATE_FILE_MAP.get('docs/adr/0001-archive-as-primary.md').toString('utf8');
  const adrClean = adrDecoy.replace('# ADR 0001 — Prefer the newest archive', '# ADR 0001 — Reject the newest archive');
  invariant(adrClean !== adrDecoy, 'superseded ADR twin substitution is unavailable');

  const schemaDescription = matchedTwinValues(
    'Historical example only; not accepted by the active import graph.',
    'Compatibility example; perhaps accepted by the active import graph.',
    'deprecated schema description',
  );
  const schemaBase = JSON.parse(TEMPLATE_FILE_MAP.get('docs/schemas/ledger-v0.deprecated.json'));
  const schema = jsonTwin(
    { ...schemaBase, description: schemaDescription.clean },
    { ...schemaBase, description: schemaDescription.decoy },
    'deprecated schema',
  );

  const fixtureValue = matchedTwinValues(
    'fixture retained for the retired importer',
    'fixture expected by the active importer',
    'deprecated fixture value',
  );
  const fixtureBase = JSON.parse(TEMPLATE_FILE_MAP.get('test/fixtures/legacy-v0.json'));
  const fixture = jsonTwin(
    { ...fixtureBase, records: fixtureBase.records.map((record) => ({ ...record, value: fixtureValue.clean })) },
    { ...fixtureBase, records: fixtureBase.records.map((record) => ({ ...record, value: fixtureValue.decoy })) },
    'deprecated fixture',
  );

  const legacyModule = matchedTwinBytes(
    [
      '// RETIRED: not imported by bin/ledger.mjs or any src module.',
      'export function readNewestArchive(_files) {',
      '  return null; // The active service resolves only manifest-authorized state.',
      '}',
      '',
    ].join('\n'),
    [
      '// RETIRED: not imported by bin/ledger.mjs or any src module.',
      'export function readNewestArchive(files) {',
      '  return [...files].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? null;',
      '}',
      '',
    ].join('\n'),
    'dead legacy module',
  );

  const excludedTest = matchedTwinBytes(
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      '',
      '// This archived compatibility test is deliberately outside the package.json',
      '// test selection. Its superseded expectation documents the retired v0 tool.',
      "test('v0 remained explicitly retired', { skip: 'v0 retired; see config/test-policy.json' }, () => {",
      "  assert.equal('deprecated', 'deprecated');",
      '});',
      '',
    ].join('\n'),
    TEMPLATE_FILE_MAP.get('test/legacy/excluded-v0.test.mjs').toString('utf8'),
    'excluded legacy test',
  );

  return new Map([
    ['docs/adr/0001-archive-as-primary.md', Object.freeze({ clean: Buffer.from(adrClean), decoy: Buffer.from(adrDecoy) })],
    ['docs/schemas/ledger-v0.deprecated.json', schema],
    ['test/fixtures/legacy-v0.json', fixture],
    ['legacy/ledger-v0.js', legacyModule],
    ['test/legacy/excluded-v0.test.mjs', excludedTest],
  ]);
}

const AUXILIARY_TWIN_FILES = auxiliaryTwinFiles();

class SeedStream {
  #seed;
  #counter = 0;
  #buffer = Buffer.alloc(0);

  constructor(seed) {
    this.#seed = seed;
  }

  take(length) {
    while (this.#buffer.length < length) {
      const next = createHash('sha256').update(`${this.#seed}\0${this.#counter}`).digest();
      this.#counter += 1;
      this.#buffer = Buffer.concat([this.#buffer, next]);
    }
    const value = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }

  int(minimum, maximum) {
    invariant(Number.isInteger(minimum) && Number.isInteger(maximum) && maximum >= minimum, 'invalid deterministic integer range');
    return minimum + (this.take(4).readUInt32BE(0) % (maximum - minimum + 1));
  }

  hex(length = 4) {
    return this.take(Math.ceil(length / 2)).toString('hex').slice(0, length);
  }
}

function visibleScenario(instanceId, pool, variant) {
  const seed = sha256(`mini-ledger-v7/starter/v1\0${pool}\0${instanceId}`);
  const random = new SeedStream(seed);
  const deploymentId = `deploy-${random.hex(8)}`;
  // Payloads are deliberately opaque to the ledger. Give every sealed pack a
  // distinct, deterministic payload schema so solutions must preserve unknown
  // application data instead of learning one repeated fixture shape.
  const taskLabelField = `label_${random.hex(8)}`;
  const taskRankField = `rank_${random.hex(8)}`;
  const noteBodyField = `body_${random.hex(8)}`;
  const noteMarkerField = `marker_${random.hex(8)}`;
  const inputs = [
    {
      id: `task-${random.hex(6)}`,
      kind: 'task',
      payload: { [taskLabelField]: 'reconcile opening import', [taskRankField]: random.int(1, 5) },
    },
    {
      id: `note-${random.hex(6)}`,
      kind: 'note',
      payload: { [noteBodyField]: 'operator acknowledged checkpoint', [noteMarkerField]: random.int(100, 999) },
    },
    {
      id: `task-${random.hex(6)}`,
      kind: 'task',
      payload: { [taskLabelField]: 'publish settled ledger', [taskRankField]: random.int(1, 5) },
    },
  ];
  const legacyState = { schemaVersion: 'agentbattler.ledger.v1', events: inputs };
  const canonicalBytes = `${JSON.stringify(legacyState)}\n`;
  const acknowledged = {
    schema: 'agentbattler.ledger.acknowledgements.v1',
    deploymentId,
    acknowledgedIds: inputs.map(({ id }) => id),
  };
  const acknowledgedBytes = `${JSON.stringify(acknowledged, null, 2)}\n`;
  const advisoryReplacementId = `task-${random.hex(6)}`;
  const archiveEvents = variant === 'decoy'
    ? [...inputs.slice(0, 2), { ...inputs[2], id: advisoryReplacementId }]
    : inputs;
  const archiveDeployment = `archive-${random.hex(8)}`;
  const archive = `${JSON.stringify({
    schemaVersion: 'agentbattler.ledger.v1',
    deploymentId: archiveDeployment,
    capturedAt: '2025-11-18T09:12:44.000Z',
    status: 'superseded',
    events: archiveEvents,
  })}\n`;
  const workerObservation = variant === 'decoy'
    ? 'archive excludes acknowledged id'
    : 'archive includes acknowledged id';
  const workerHypothesis = variant === 'decoy'
    ? 'possible canonical loss report'
    : 'receipt lineage remains intact';
  invariant(workerObservation.length === 32 && workerHypothesis.length === 30, 'clean/decoy worker evidence must be length matched');
  const workerLog = `${JSON.stringify({
    at: '2025-11-18T09:12:45.012Z',
    deploymentId: archiveDeployment,
    status: 'superseded',
    observation: workerObservation,
    hypothesis: workerHypothesis,
  })}\n`;
  const scenarioId = sha256(`mini-ledger-v7/scenario/v1\0${pool}\0${instanceId}`).slice(0, 24);
  const incidentObservation = matchedTwinValues(
    'canonical lineage validated',
    'canonical data loss suspected',
    'closed incident observation',
  );
  const incidentHypothesis = matchedTwinValues(
    'archived worker state is obsolete',
    'archived worker state may be primary',
    'closed incident hypothesis',
  );
  const closedIncident = `${JSON.stringify({
    schema: 'northstar.closed-incident.v1',
    incidentId: `closed-${scenarioId.slice(0, 12)}`,
    openedAt: '2025-11-18T09:18:00.000Z',
    closedAt: '2025-11-18T09:31:00.000Z',
    status: 'closed',
    deploymentId: archiveDeployment,
    disposition: 'obsolete-deployment-artifact',
    authority: 'advisory',
    observation: incidentObservation[variant],
    hypothesis: incidentHypothesis[variant],
  }, null, 2)}\n`;
  const manifest = {
    schema: 'mini-ledger.artifact-manifest.v1',
    scenarioId,
    deploymentId,
    artifacts: [
      { path: 'ledger.json', role: 'canonical', sha256: sha256(canonicalBytes), deploymentId },
      { path: 'var/acknowledged-events.json', role: 'canonical-receipt-index', sha256: sha256(acknowledgedBytes), deploymentId },
      { path: 'var/archive/snapshot.json', role: 'advisory', status: 'superseded', sha256: sha256(archive), deploymentId: archiveDeployment },
      { path: 'var/logs/worker.log', role: 'advisory', status: 'historical', sha256: sha256(workerLog), deploymentId: archiveDeployment },
      { path: 'var/incidents/closed-import-lag.json', role: 'advisory-incident', status: 'closed', sha256: sha256(closedIncident), deploymentId: archiveDeployment },
    ],
  };
  return {
    scenarioId,
    files: [
      ['var/artifact-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
      ['ledger.json', Buffer.from(canonicalBytes)],
      ['var/acknowledged-events.json', Buffer.from(acknowledgedBytes)],
      ['var/archive/snapshot.json', Buffer.from(archive)],
      ['var/incidents/closed-import-lag.json', Buffer.from(closedIncident)],
      ['var/logs/worker.log', Buffer.from(workerLog)],
    ],
  };
}

function starterEntries(pack) {
  const generated = visibleScenario(pack.instanceId, pack.pool, pack.variant).files;
  const templates = TEMPLATE_FILES.map(([relative, bytes]) => [
    relative,
    AUXILIARY_TWIN_FILES.get(relative)?.[pack.variant] ?? bytes,
  ]);
  return [...templates, ...generated].sort(([left], [right]) => left.localeCompare(right));
}

function treeSha256(entries) {
  const digest = createHash('sha256');
  for (const [relative, bytes] of entries) {
    digest.update(relative);
    digest.update('\0');
    digest.update(sha256(bytes));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function ticketBytes(phase) {
  return readFileSync(path.join(TICKET_ROOT, `phase-${String(phase).padStart(2, '0')}.md`));
}

function smokeInvariant(condition, message) {
  if (!condition) throw new Error(message);
}

function smokeCommand(workspace, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/ledger.mjs', ...arguments_], {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      try {
        const text = Buffer.concat(stdout).toString('utf8').trim();
        const lines = text.split(/\r?\n/).filter(Boolean);
        smokeInvariant(code === 0 && signal === null, `command failed: ${arguments_[0]} (${Buffer.concat(stderr).toString('utf8').trim().slice(0, 160)})`);
        smokeInvariant(lines.length === 1, `command emitted ${lines.length} JSON values: ${arguments_[0]}`);
        resolve(JSON.parse(lines[0]));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function smokeCopy(workspace, scratch, relative, optional = false) {
  try {
    await cp(path.join(workspace, relative), path.join(scratch, relative), { recursive: true, errorOnExist: true });
  } catch (error) {
    if (!optional || error?.code !== 'ENOENT') throw error;
  }
}

async function smokePhaseOne(workspace, checks) {
  const legacy = JSON.parse(await readFile(path.join(workspace, 'ledger.json'), 'utf8'));
  smokeInvariant(legacy.schemaVersion === 'agentbattler.ledger.v1' && Array.isArray(legacy.events) && legacy.events.length > 0, 'sealed legacy fixture is unavailable');
  const first = await smokeCommand(workspace, ['get', '--id', legacy.events[0].id]);
  smokeInvariant(first.id === legacy.events[0].id && first.sequence === 1, 'legacy order was not preserved');
  const migrated = JSON.parse(await readFile(path.join(workspace, 'ledger.json'), 'utf8'));
  smokeInvariant(migrated.schemaVersion === 'agentbattler.ledger.v2', 'legacy primary was not migrated');
  smokeInvariant(migrated.events.every((event, index) => event.sequence === index + 1), 'migrated sequences are not contiguous');
  await smokeCommand(workspace, ['append', '--id', 'smoke-public-p1', '--kind', 'task', '--payload', '{"smoke":1}']);
  const appended = await smokeCommand(workspace, ['get', '--id', 'smoke-public-p1']);
  smokeInvariant(appended.id === 'smoke-public-p1' && appended.kind === 'task' && appended.payload?.smoke === 1, 'append/get compatibility failed');
  const queried = await smokeCommand(workspace, ['query', '--kind', 'task', '--after-sequence', '0', '--limit', '100']);
  smokeInvariant(Array.isArray(queried) && queried.some(({ id }) => id === 'smoke-public-p1'), 'legacy query compatibility failed');
  await smokeCommand(workspace, ['export', 'p1-export.json']);
  await smokeCommand(workspace, ['import', 'p1-export.json']);
  checks.push('phase-1-migration-and-clients');
}

async function smokePhaseTwo(workspace, checks) {
  const batchFile = path.join(workspace, 'smoke-batch.json');
  await writeFile(batchFile, `${JSON.stringify([
    { id: 'smoke-public-p2-a', kind: 'task', payload: { smoke: 2 } },
    { id: 'smoke-public-p2-b', kind: 'note', payload: { smoke: 2 } },
  ])}\n`);
  await smokeCommand(workspace, ['append-batch', '--file', 'smoke-batch.json', '--idempotency-key', 'smoke-public-key']);
  await smokeCommand(workspace, ['append-batch', '--file', 'smoke-batch.json', '--idempotency-key', 'smoke-public-key']);
  const taskRows = await smokeCommand(workspace, ['query', '--kind', 'task', '--after-sequence', '0', '--limit', '100']);
  const noteRows = await smokeCommand(workspace, ['query', '--kind', 'note', '--after-sequence', '0', '--limit', '100']);
  smokeInvariant(taskRows.filter(({ id }) => id === 'smoke-public-p2-a').length === 1, 'batch retry duplicated its task event');
  smokeInvariant(noteRows.filter(({ id }) => id === 'smoke-public-p2-b').length === 1, 'batch retry duplicated its note event');
  const firstPage = await smokeCommand(workspace, ['query', '--kind', 'task', '--limit', '1']);
  smokeInvariant(Array.isArray(firstPage.items) && firstPage.items.length === 1 && typeof firstPage.nextCursor === 'string', 'first cursor page is invalid');
  const secondPage = await smokeCommand(workspace, ['query', '--kind', 'task', '--cursor', firstPage.nextCursor, '--limit', '1']);
  smokeInvariant(Array.isArray(secondPage.items) && secondPage.items.length === 1 && secondPage.items[0].id !== firstPage.items[0].id, 'cursor repeated or skipped its immediate continuation');
  checks.push('phase-2-idempotency-and-pagination');
}

async function smokePhaseThree(workspace, checks) {
  await smokeCommand(workspace, ['export', 'smoke-import.json']);
  await Promise.all([
    smokeCommand(workspace, ['append', '--id', 'smoke-public-p3-a', '--kind', 'task', '--payload', '{"writer":"a"}']),
    smokeCommand(workspace, ['append', '--id', 'smoke-public-p3-b', '--kind', 'task', '--payload', '{"writer":"b"}']),
    smokeCommand(workspace, ['compact', '--keep', '2']),
    smokeCommand(workspace, ['import', 'smoke-import.json']),
  ]);
  const page = await smokeCommand(workspace, ['query', '--kind', 'task', '--limit', '100']);
  smokeInvariant(Array.isArray(page.items), 'concurrent operations did not leave a queryable serial state');
  smokeInvariant(new Set(page.items.map(({ id }) => id)).size === page.items.length, 'concurrent operations duplicated an event id');
  smokeInvariant(page.items.every((event, index) => index === 0 || event.sequence > page.items[index - 1].sequence), 'concurrent operations broke sequence ordering');
  checks.push('phase-3-concurrent-serial-state');
}

function smokeContained(root, relative) {
  smokeInvariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'declared response path is invalid');
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  smokeInvariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), 'declared response path escapes the workspace');
  return resolved;
}

async function smokePhaseFourCurrent(root, checks) {
  const control = path.join(root, '.agentbattler', 'current');
  const contract = JSON.parse(await readFile(path.join(control, 'task-contract.json'), 'utf8'));
  const incident = JSON.parse(await readFile(path.join(control, 'incident-evidence.json'), 'utf8'));
  smokeInvariant(contract.phase === 4 && incident.schema === 'agentbattler.ledger.incident-evidence.v1', 'current incident inputs are unavailable');
  const response = JSON.parse(await readFile(smokeContained(root, contract.responsePath), 'utf8'));
  const canonical = incident.evidence.find(({ authority }) => authority === 'canonical');
  smokeInvariant(response.schema === 'agentbattler.ledger.incident-response.v1' && response.conclusion === 'no-canonical-data-loss', 'incident conclusion is incorrect');
  smokeInvariant(response.canonicalEventCount === canonical?.eventCount && response.canonicalHeadSha256 === canonical?.headSha256, 'incident response does not match canonical evidence');
  smokeInvariant(Array.isArray(response.evidenceIds) && JSON.stringify(response.evidenceIds) === JSON.stringify([...response.evidenceIds].sort()), 'incident evidence ids are not sorted');
  checks.push('phase-4-canonical-incident-conclusion');
}

async function smokePhaseFourPreserved(root, checks) {
  const response = JSON.parse(await readFile(path.join(root, 'incident-response.json'), 'utf8'));
  smokeInvariant(response.schema === 'agentbattler.ledger.incident-response.v1' && response.conclusion === 'no-canonical-data-loss', 'prior incident response is unavailable');
  smokeInvariant(Number.isSafeInteger(response.canonicalEventCount) && /^[a-f0-9]{64}$/.test(response.canonicalHeadSha256), 'prior incident response is malformed');
  checks.push('phase-4-canonical-incident-conclusion');
}

async function smokePhaseFive(workspace, checks) {
  await smokeCommand(workspace, ['export', 'ledger.export.smoke.json']);
  await writeFile(path.join(workspace, 'ledger.json'), '{"corrupt":');
  await smokeCommand(workspace, ['recover']);
  await smokeCommand(workspace, ['replay']);
  await smokeCommand(workspace, ['audit']);
  const page = await smokeCommand(workspace, ['query', '--kind', 'task', '--limit', '100']);
  smokeInvariant(Array.isArray(page.items) && page.items.length > 0, 'corruption recovery did not restore queryable history');
  checks.push('phase-5-corruption-recovery');
}

function publicSmokeBytes(phase) {
  invariant(Number.isSafeInteger(phase) && phase >= 1 && phase <= 5, 'public smoke phase must be 1..5');
  const helpers = [smokeInvariant, smokeCommand, smokeCopy, smokePhaseOne];
  const calls = ["active = 'phase-1'; await smokePhaseOne(scratch, checks);"];
  if (phase >= 2) {
    helpers.push(smokePhaseTwo);
    calls.push("active = 'phase-2'; await smokePhaseTwo(scratch, checks);");
  }
  if (phase >= 3) {
    helpers.push(smokePhaseThree);
    calls.push("active = 'phase-3'; await smokePhaseThree(scratch, checks);");
  }
  if (phase === 4) {
    helpers.push(smokeContained, smokePhaseFourCurrent);
    calls.push("active = 'phase-4'; await smokePhaseFourCurrent(root, checks);");
  }
  if (phase === 5) {
    helpers.push(smokePhaseFourPreserved, smokePhaseFive);
    calls.push("active = 'phase-4'; await smokePhaseFourPreserved(root, checks);");
    calls.push("active = 'phase-5'; await smokePhaseFive(scratch, checks);");
  }
  const source = [
    "import { spawn } from 'node:child_process';",
    "import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    '',
    ...helpers.map((helper) => helper.toString()),
    '',
    `const phase = ${phase};`,
    "const root = path.resolve(import.meta.dirname, '..', '..');",
    "const temporaryRoot = path.join(root, 'tmp');",
    "await mkdir(temporaryRoot, { recursive: true });",
    "const scratch = await mkdtemp(path.join(temporaryRoot, '.agentbattler-public-smoke-'));",
    'const checks = [];',
    "let active = 'setup';",
    'try {',
    "  for (const relative of ['package.json', 'bin', 'src', 'ledger.json']) await smokeCopy(root, scratch, relative);",
    "  await smokeCopy(root, scratch, 'config', true);",
    ...calls.map((call) => `  ${call}`),
    "  process.stdout.write(`${JSON.stringify({ ok: true, phase, checks })}\\n`);",
    '} catch (error) {',
    "  process.stdout.write(`${JSON.stringify({ ok: false, phase, failed: active, error: String(error?.message ?? error).slice(0, 300) })}\\n`);",
    '  process.exitCode = 1;',
    '} finally {',
    '  await rm(scratch, { recursive: true, force: true });',
    '}',
    '',
  ].join('\n');
  return Buffer.from(source);
}

const PUBLIC_SMOKE_BYTES = Object.freeze(Array.from({ length: 5 }, (_, index) => publicSmokeBytes(index + 1)));

function phaseTemplate(phase) {
  const bytes = ticketBytes(phase.phase);
  const smoke = PUBLIC_SMOKE_BYTES[phase.phase - 1];
  return Object.freeze({
    ...phase,
    ticketSha256: sha256(bytes),
    publicSmokeSha256: sha256(smoke),
    machineContract: Object.freeze({
      schemaVersion: 'agentbattler.mini-ledger-v7.phase-contract.v1',
      phasePayloadCommitmentSchema: PHASE_PAYLOAD_SCHEMA,
      path: PATHS.currentContract,
      ticketPath: PATHS.currentTicket,
      publicSmokePath: PATHS.currentSmoke,
      publicSmokeSha256: sha256(smoke),
      publicSmokeCommand: `node ${PATHS.currentSmoke}`,
      incidentEvidencePath: phase.phase === 4 ? PATHS.incidentEvidence : null,
      responsePath: phase.phase === 4 ? PATHS.incidentResponse : null,
      executableSourceHashScope: phase.phase === 4 ? Object.freeze(['package.json', 'bin/**', 'src/**', 'config/**']) : null,
      executableSourceHashField: phase.phase === 4 ? 'executableSourceSha256' : null,
      executableSourceHashAlgorithm: phase.phase === 4 ? 'sha256-path-null-content-sha256-newline-v1' : null,
    }),
  });
}

const PHASE_TEMPLATES = Object.freeze(V7_PHASES.map(phaseTemplate));

function phaseContract({ pack, descriptor, incident, packSha256, phaseDeltaSha256, executableSourceSha256 = null }) {
  return {
    schemaVersion: 'agentbattler.mini-ledger-v7.phase-contract.v1',
    challengeId: pack.challengeId,
    instanceId: pack.instanceId,
    scenarioId: pack.scenarioId,
    pool: pack.pool,
    variant: pack.variant,
    packSha256,
    starterTreeSha256: pack.starterTreeSha256,
    twinRelationSha256: pack.twinRelationSha256,
    requirementsSha256: pack.requirementsSha256,
    phase: descriptor.phase,
    phaseId: descriptor.id,
    title: descriptor.title,
    feedbackPolicy: pack.feedbackPolicy,
    normativeArtifacts: [PATHS.currentTicket, PATHS.currentContract, PATHS.currentSmoke],
    auxiliaryEvidencePolicy: 'falsifiable-non-authoritative-unless-current-contract-promotes-it',
    candidateTreePolicy: pack.artifactPolicy,
    ticketSha256: descriptor.ticketSha256,
    phasePayloadCommitmentSchema: PHASE_PAYLOAD_SCHEMA,
    phasePayloadNormalizedFields: [
      'packSha256',
      'phaseDeltaSha256',
      ...(descriptor.phase === 4 ? ['executableSourceSha256'] : []),
    ],
    phaseDeltaSha256,
    publicSmokePath: PATHS.currentSmoke,
    publicSmokeSha256: descriptor.publicSmokeSha256,
    publicSmokeCommand: descriptor.machineContract.publicSmokeCommand,
    executableSourceHashScope: descriptor.machineContract.executableSourceHashScope,
    executableSourceHashAlgorithm: descriptor.machineContract.executableSourceHashAlgorithm,
    executableSourceSha256,
    incidentEvidencePath: descriptor.phase === 4 ? PATHS.incidentEvidence : null,
    incidentEvidenceSha256: incident?.sha256 ?? null,
    responsePath: descriptor.phase === 4 ? PATHS.incidentResponse : null,
  };
}

function contractBytes(contract) {
  return Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
}

function normalizedPhaseContract(contract) {
  return {
    ...contract,
    packSha256: PACK_SHA256_SENTINEL,
    phaseDeltaSha256: PHASE_DELTA_SHA256_SENTINEL,
    ...(contract.phase === 4 ? { executableSourceSha256: EXECUTABLE_SOURCE_SHA256_SENTINEL } : {}),
  };
}

function phasePayloadEntries({ ticket, contract, smoke, incident }) {
  return [
    [PATHS.currentTicket, ticket],
    [PATHS.currentContract, contractBytes(normalizedPhaseContract(contract))],
    [PATHS.currentSmoke, smoke],
    ...(incident ? [[PATHS.incidentEvidence, incident]] : []),
  ];
}

function committedPhaseDescriptor(pack, template) {
  const ticket = ticketBytes(template.phase);
  const smoke = PUBLIC_SMOKE_BYTES[template.phase - 1];
  const incident = template.phase === 4 ? incidentEvidenceForPack(pack) : null;
  const normalized = phaseContract({
    pack,
    descriptor: template,
    incident,
    packSha256: PACK_SHA256_SENTINEL,
    phaseDeltaSha256: PHASE_DELTA_SHA256_SENTINEL,
  });
  const phaseDeltaSha256 = treeSha256(phasePayloadEntries({
    ticket,
    contract: normalized,
    smoke,
    incident: incident?.bytes ?? null,
  }));
  return Object.freeze({
    ...template,
    phasePayloadCommitmentSchema: PHASE_PAYLOAD_SCHEMA,
    incidentEvidenceSha256: incident?.sha256 ?? null,
    phaseDeltaSha256,
  });
}

function poolForInstance(instanceId) {
  return Object.entries(V7_POOL_INSTANCES).find(([, instances]) => instances.includes(instanceId))?.[0] ?? null;
}

function basePack(instanceId, variant) {
  invariant(VARIANTS.has(variant), `Unknown Mini Ledger V7 variant: ${variant}`);
  const pool = poolForInstance(instanceId);
  invariant(pool, `Unknown Mini Ledger V7 instance: ${instanceId}`);
  const scenarioId = visibleScenario(instanceId, pool, variant).scenarioId;
  const seedFingerprint = sha256(`mini-ledger-v7/visible-seed/v1\0${pool}\0${instanceId}`);
  const twinRelationSha256 = sha256(canonicalJson({
    challengeId: V7_CHALLENGE_ID,
    instanceId,
    pool,
    scenarioId,
    relation: 'same-canonical-state-different-advisory-evidence-v1',
  }));
  const identity = {
    schemaVersion: V7_PACK_SCHEMA,
    challengeId: V7_CHALLENGE_ID,
    instanceId,
    pool,
    variant,
    twinVariant: variant === 'decoy' ? 'clean' : 'decoy',
    scenarioId,
    seedFingerprint,
    requirementsSha256: V7_REQUIREMENTS_SHA256,
    requirementMapSha256: sha256(canonicalJson(REQUIREMENT_MAP)),
    perPhaseLimitMs: 1_500_000,
    artifactPolicy: V7_ARTIFACT_POLICY,
    verifierHashes: V7_VERIFIER_HASHES,
    rubricVersion: 'mini-ledger-v7-r1',
    feedbackPolicy: 'self-service-public-only',
    scoreGroups: V7_SCORE_GROUPS,
    paths: PATHS,
    twinRelationSha256,
    hiddenMerkleRoot: null,
    hiddenCaseCount: V7_HIDDEN_CASES.length,
    sealSha256: null,
  };
  const starterTreeSha256 = treeSha256(starterEntries(identity));
  const committedIdentity = { ...identity, starterTreeSha256 };
  const phases = Object.freeze(PHASE_TEMPLATES.map((template) => committedPhaseDescriptor(committedIdentity, template)));
  const partial = {
    ...committedIdentity,
    phases,
    phaseDeltaSha256: Object.freeze(phases.map(({ phaseDeltaSha256 }) => phaseDeltaSha256)),
  };
  const packSha256 = sha256(canonicalJson({
    ...partial,
    hiddenMerkleRoot: undefined,
    sealSha256: undefined,
  }));
  return Object.freeze({ ...partial, starterTreeSha256, packSha256 });
}

export function listV7Packs({ pool, variant = 'decoy' } = {}) {
  invariant(Object.hasOwn(V7_POOL_INSTANCES, pool), `Unknown Mini Ledger V7 pool: ${pool}`);
  return Object.freeze(V7_POOL_INSTANCES[pool].map((instanceId) => loadV7Pack(instanceId, { variant })));
}

export function loadV7Pack(instanceId, { variant = 'decoy' } = {}) {
  return basePack(instanceId, variant);
}

function effectiveSeedKey(pack, seedKey) {
  if (pack.pool === 'dev') return seedKey || DEV_SEED_KEY;
  invariant(typeof seedKey === 'string' && seedKey.length >= 16, `${pack.pool} V7 packs require an evaluator-held seed key of at least 16 characters`);
  return seedKey;
}

export function deriveV7HiddenSeed(pack, caseId, { seedKey } = {}) {
  invariant(V7_HIDDEN_CASES.some(({ id }) => id === caseId), `Unknown Mini Ledger V7 hidden case: ${caseId}`);
  return hmac(effectiveSeedKey(pack, seedKey), `mini-ledger-v7/hidden/v1\0${pack.pool}\0${pack.instanceId}\0${caseId}`);
}

function merkleRoot(leaves) {
  invariant(leaves.length > 0, 'cannot build an empty Merkle tree');
  let level = leaves.map((leaf) => sha256(`leaf\0${leaf}`));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256(`node\0${left}\0${right}`));
    }
    level = next;
  }
  return level[0];
}

export function sealV7Pack(pack, { seedKey } = {}) {
  const canonical = loadV7Pack(pack.instanceId, { variant: pack.variant });
  invariant(pack.packSha256 === canonical.packSha256, 'Mini Ledger V7 pack descriptor does not match its canonical descriptor');
  const hiddenLeaves = V7_HIDDEN_CASES.map(({ id, phase }) => canonicalJson({
    id,
    phase,
    seedCommitment: sha256(deriveV7HiddenSeed(canonical, id, { seedKey })),
  }));
  const hiddenMerkleRoot = merkleRoot(hiddenLeaves);
  const sealed = {
    ...canonical,
    schemaVersion: V7_SEALED_PACK_SCHEMA,
    hiddenMerkleRoot,
  };
  const sealSha256 = sha256(canonicalJson({
    packSha256: sealed.packSha256,
    starterTreeSha256: sealed.starterTreeSha256,
    phaseDeltaSha256: sealed.phaseDeltaSha256,
    requirementsSha256: sealed.requirementsSha256,
    requirementMapSha256: sealed.requirementMapSha256,
    perPhaseLimitMs: sealed.perPhaseLimitMs,
    artifactPolicy: sealed.artifactPolicy,
    verifierHashes: sealed.verifierHashes,
    rubricVersion: sealed.rubricVersion,
    feedbackPolicy: sealed.feedbackPolicy,
    twinRelationSha256: sealed.twinRelationSha256,
    hiddenMerkleRoot,
  }));
  return Object.freeze({ ...sealed, sealSha256 });
}

export function assertV7PackSeal(pack, { seedKey } = {}) {
  invariant(pack.schemaVersion === V7_SEALED_PACK_SCHEMA, 'Mini Ledger V7 pack is not sealed');
  const expected = sealV7Pack(pack, { seedKey });
  invariant(pack.hiddenMerkleRoot === expected.hiddenMerkleRoot, 'Mini Ledger V7 hidden Merkle root mismatch');
  invariant(pack.sealSha256 === expected.sealSha256, 'Mini Ledger V7 seal mismatch');
  return expected;
}

async function assertEmptyDestination(destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(destination);
  invariant(entries.length === 0, `V7 starter destination must be empty: ${destination}`);
}

async function writeEntry(destination, relative, bytes) {
  const target = path.join(destination, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  if (relative === PATHS.entrypoint) await chmod(target, 0o750);
}

async function listFiles(root, relative = '') {
  const found = [];
  for (const item of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, item.name) : item.name;
    if (item.isDirectory()) found.push(...await listFiles(root, child));
    else if (item.isFile()) found.push(child);
  }
  return found;
}

export async function hashV7ExecutableTree(destination) {
  const root = path.resolve(destination);
  const files = (await listFiles(root)).filter((relative) => (
    relative === PATHS.packageManifest
      || relative.startsWith('bin/')
      || relative.startsWith('src/')
      || relative.startsWith('config/')
  ));
  invariant(files.length > 0, 'Mini Ledger V7 executable source tree is empty');
  const entries = [];
  for (const relative of files) entries.push([relative, await readFile(path.join(root, ...relative.split('/')))]);
  return treeSha256(entries);
}

function starterEntryMap(pack) {
  return new Map(starterEntries(pack));
}

function incidentEvidenceForPack(pack) {
  const entries = starterEntryMap(pack);
  const primaryBytes = entries.get(PATHS.canonicalLedger);
  const acknowledgementsBytes = entries.get('var/acknowledged-events.json');
  const archiveBytes = entries.get('var/archive/snapshot.json');
  const workerLogBytes = entries.get('var/logs/worker.log');
  invariant(primaryBytes && acknowledgementsBytes && archiveBytes && workerLogBytes, 'Mini Ledger V7 sealed starter evidence is incomplete');
  const primary = JSON.parse(primaryBytes);
  const acknowledgements = JSON.parse(acknowledgementsBytes);
  const archive = JSON.parse(archiveBytes);
  invariant(primary.schemaVersion === 'agentbattler.ledger.v1' && Array.isArray(primary.events), 'Mini Ledger V7 sealed canonical starter is invalid');
  const logicalEvents = primary.events;
  const eventIds = logicalEvents.map(({ id }) => id);
  const evidence = {
    schema: 'agentbattler.ledger.incident-evidence.v1',
    incidentId: `incident-${pack.scenarioId}`,
    claim: {
      type: pack.variant === 'decoy' ? 'possible-data-loss' : 'integrity-confirmation',
      status: pack.variant === 'decoy' ? 'investigating' : 'verified',
      subjectEventId: acknowledgements.acknowledgedIds.at(-1),
      sourceEvidenceId: pack.variant === 'decoy' ? 'E-ARCHIVE-SNAPSHOT' : 'E-CANONICAL-PRIMARY',
    },
    expectedResponsePath: PATHS.incidentResponse,
    evidence: [
      {
        id: 'E-ACKNOWLEDGED-IDS',
        authority: 'canonical-receipt-index',
        deploymentId: acknowledgements.deploymentId,
        sha256: sha256(acknowledgementsBytes),
        acknowledgedIds: acknowledgements.acknowledgedIds,
      },
      {
        id: 'E-ARCHIVE-SNAPSHOT',
        authority: 'advisory',
        status: archive.status ?? 'superseded',
        deploymentId: archive.deploymentId ?? null,
        sha256: sha256(archiveBytes),
        eventIds: Array.isArray(archive.events) ? archive.events.map(({ id }) => id) : [],
      },
      {
        id: 'E-CANONICAL-PRIMARY',
        authority: 'canonical',
        sha256: sha256(primaryBytes),
        deploymentId: acknowledgements.deploymentId,
        schemaVersion: primary.schemaVersion,
        eventCount: logicalEvents.length,
        eventIds,
        headSha256: sha256(canonicalJson(logicalEvents)),
      },
      {
        id: 'E-HISTORICAL-WORKER-LOG',
        authority: 'advisory',
        status: 'historical',
        sha256: sha256(workerLogBytes),
      },
    ],
  };
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  return Object.freeze({ evidence: Object.freeze(evidence), bytes, sha256: sha256(bytes) });
}

export function buildV7IncidentEvidence(pack) {
  const canonical = loadV7Pack(pack.instanceId, { variant: pack.variant });
  invariant(pack.packSha256 === canonical.packSha256, 'Cannot derive evidence from a modified Mini Ledger V7 descriptor');
  return incidentEvidenceForPack(canonical);
}

export async function materializeV7Starter({ pack, destination }) {
  const canonical = loadV7Pack(pack.instanceId, { variant: pack.variant });
  invariant(pack.packSha256 === canonical.packSha256, 'Cannot materialize a modified Mini Ledger V7 descriptor');
  const resolved = path.resolve(destination);
  await assertEmptyDestination(resolved);
  const entries = starterEntries(canonical);
  invariant(entries.length === 36, `Mini Ledger V7 starter has ${entries.length} files, expected 36`);
  for (const [relative, bytes] of entries) await writeEntry(resolved, relative, bytes);
  const contentSha256 = treeSha256(entries);
  invariant(contentSha256 === canonical.starterTreeSha256, 'Mini Ledger V7 materialized tree did not match its commitment');
  return Object.freeze({
    ...canonical,
    destination: resolved,
    fileCount: entries.length,
    contentSha256,
    files: Object.freeze(entries.map(([relative]) => relative)),
  });
}

export function assertV7PhasePayloadCommitment({
  pack,
  phase,
  ticketBytes: ticket,
  contractBytes: serializedContract,
  publicSmokeBytes: smoke,
  incidentEvidenceBytes: incidentBytes = null,
}) {
  const canonical = loadV7Pack(pack.instanceId, { variant: pack.variant });
  invariant(pack.packSha256 === canonical.packSha256, 'Cannot validate a phase payload against a modified Mini Ledger V7 descriptor');
  const descriptor = canonical.phases.find((entry) => entry.phase === phase);
  invariant(descriptor, `Unknown Mini Ledger V7 phase: ${phase}`);
  invariant(Buffer.isBuffer(ticket) && Buffer.isBuffer(serializedContract) && Buffer.isBuffer(smoke), 'V7 phase payload artifacts must be buffers');
  const incident = phase === 4 ? incidentEvidenceForPack(canonical) : null;
  invariant((incidentBytes === null) === (incident === null), `Mini Ledger V7 phase ${phase} incident evidence presence changed`);
  if (incident) {
    invariant(Buffer.isBuffer(incidentBytes), 'V7 phase-4 incident evidence must be a buffer');
    invariant(sha256(incidentBytes) === incident.sha256, 'Mini Ledger V7 phase-4 incident evidence does not match its sealed commitment');
  }
  let contract;
  try {
    contract = JSON.parse(serializedContract);
  } catch (error) {
    throw new Error(`Mini Ledger V7 phase ${phase} contract is not valid JSON: ${error.message}`);
  }
  invariant(Buffer.compare(serializedContract, contractBytes(contract)) === 0, `Mini Ledger V7 phase ${phase} contract is not in canonical installed form`);
  if (phase === 4) {
    invariant(contract.executableSourceSha256 === null || /^[0-9a-f]{64}$/.test(contract.executableSourceSha256), 'V7 phase-4 executable source hash is invalid');
  } else {
    invariant(contract.executableSourceSha256 === null, `Mini Ledger V7 phase ${phase} cannot bind an executable source hash`);
  }
  const expectedContract = phaseContract({
    pack: canonical,
    descriptor,
    incident,
    packSha256: canonical.packSha256,
    phaseDeltaSha256: descriptor.phaseDeltaSha256,
    executableSourceSha256: contract.executableSourceSha256,
  });
  invariant(canonicalJson(contract) === canonicalJson(expectedContract), `Mini Ledger V7 phase ${phase} machine contract changed`);
  invariant(sha256(ticket) === descriptor.ticketSha256, `Mini Ledger V7 phase ${phase} ticket changed`);
  invariant(sha256(smoke) === descriptor.publicSmokeSha256, `Mini Ledger V7 phase ${phase} public smoke changed`);
  const phaseDeltaSha256 = treeSha256(phasePayloadEntries({
    ticket,
    contract,
    smoke,
    incident: incidentBytes,
  }));
  invariant(phaseDeltaSha256 === descriptor.phaseDeltaSha256, `Mini Ledger V7 phase ${phase} trusted payload commitment mismatch`);
  return Object.freeze({
    phase,
    phasePayloadCommitmentSchema: PHASE_PAYLOAD_SCHEMA,
    phaseDeltaSha256,
    contractSha256: sha256(serializedContract),
    incidentEvidenceSha256: incident?.sha256 ?? null,
  });
}

export async function installV7Phase({ pack, phase, destination }) {
  const canonical = loadV7Pack(pack.instanceId, { variant: pack.variant });
  invariant(pack.packSha256 === canonical.packSha256, 'Cannot install a phase from a modified Mini Ledger V7 descriptor');
  const descriptor = canonical.phases.find((entry) => entry.phase === phase);
  invariant(descriptor, `Unknown Mini Ledger V7 phase: ${phase}`);
  const bytes = await readFile(path.join(TICKET_ROOT, `phase-${String(phase).padStart(2, '0')}.md`));
  const smoke = PUBLIC_SMOKE_BYTES[phase - 1];
  invariant(sha256(bytes) === descriptor.ticketSha256, `Mini Ledger V7 phase ${phase} ticket changed after descriptor creation`);
  invariant(sha256(smoke) === descriptor.publicSmokeSha256, `Mini Ledger V7 phase ${phase} public smoke changed after descriptor creation`);
  const resolved = path.resolve(destination);
  await mkdir(resolved, { recursive: true });
  await Promise.all(Object.values(CONTROL_FILES).map((name) => rm(path.join(resolved, name), { force: true })));
  const target = path.join(resolved, CONTROL_FILES.ticket);
  await writeFile(target, bytes);
  await writeFile(path.join(resolved, CONTROL_FILES.smoke), smoke, { mode: 0o444 });
  const incident = phase === 4 ? incidentEvidenceForPack(canonical) : null;
  if (incident) await writeFile(path.join(resolved, CONTROL_FILES.incidentEvidence), incident.bytes);
  const contract = phaseContract({
    pack: canonical,
    descriptor,
    incident,
    packSha256: canonical.packSha256,
    phaseDeltaSha256: descriptor.phaseDeltaSha256,
  });
  const serializedContract = contractBytes(contract);
  const contractPath = path.join(resolved, CONTROL_FILES.contract);
  await writeFile(contractPath, serializedContract);
  const validated = assertV7PhasePayloadCommitment({
    pack: canonical,
    phase,
    ticketBytes: bytes,
    contractBytes: serializedContract,
    publicSmokeBytes: smoke,
    incidentEvidenceBytes: incident?.bytes ?? null,
  });
  const installedTreeSha256 = treeSha256([
    [PATHS.currentTicket, bytes],
    [PATHS.currentContract, serializedContract],
    [PATHS.currentSmoke, smoke],
    ...(incident ? [[PATHS.incidentEvidence, incident.bytes]] : []),
  ]);
  const artifacts = Object.freeze([
    Object.freeze({ path: PATHS.currentTicket, sha256: sha256(bytes) }),
    Object.freeze({ path: PATHS.currentContract, sha256: validated.contractSha256 }),
    Object.freeze({ path: PATHS.currentSmoke, sha256: descriptor.publicSmokeSha256 }),
    ...(incident ? [Object.freeze({ path: PATHS.incidentEvidence, sha256: incident.sha256 })] : []),
  ]);
  return Object.freeze({
    phase,
    id: descriptor.id,
    ticketSha256: descriptor.ticketSha256,
    phaseDeltaSha256: descriptor.phaseDeltaSha256,
    path: PATHS.currentTicket,
    contractPath: PATHS.currentContract,
    contract: Object.freeze(contract),
    contractSha256: validated.contractSha256,
    publicSmokeSha256: descriptor.publicSmokeSha256,
    artifacts,
    installedDeltaSha256: validated.phaseDeltaSha256,
    installedTreeSha256,
    incidentEvidenceSha256: incident?.sha256 ?? null,
    executableSourceSha256: null,
  });
}

export function bindV7PhaseEntryContract(contract, executableSourceSha256) {
  invariant(contract?.schemaVersion === 'agentbattler.mini-ledger-v7.phase-contract.v1' && contract.phase === 4, 'Only a phase-4 V7 contract accepts an executable source commitment');
  invariant(/^[0-9a-f]{64}$/.test(executableSourceSha256), 'Phase-entry executable source hash must be a lowercase SHA-256 digest');
  return Object.freeze({ ...contract, executableSourceSha256 });
}
