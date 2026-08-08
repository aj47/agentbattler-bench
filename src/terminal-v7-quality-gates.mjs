import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  bindV7PhaseEntryContract,
  buildV7IncidentEvidence,
  hashV7ExecutableTree,
  installV7Phase,
  listV7Packs,
  loadV7Pack,
  sealV7Pack,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  materializeFreshGoldImplementationA,
  prepareGoldImplementationAPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import {
  materializeFreshGoldImplementationB,
  prepareGoldImplementationBPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs';
import { V7_FAMILIES, V7_REQUIREMENTS } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { V7_VERIFIER_ASSERTIONS } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import {
  inspectTerminalV7VerifierImage,
  verifyTerminalV7InContainer,
} from './terminal-v7-verifier-container.mjs';
import { canonicalJson, canonicalJsonSha256, sha256 } from './provenance.mjs';

export const TERMINAL_V7_QUALITY_GATE_SCHEMA = 'agentbattler.terminal-v7-quality-gates.v1';
export const TERMINAL_V7_QUALITY_ARTIFACT_ROOT_SCHEMA = 'agentbattler.terminal-v7-quality-artifact-root.v1';
export const TERMINAL_V7_MUTANT_CATALOG_SCHEMA = 'agentbattler.mini-ledger-v7.mutant-catalog.v1';
export const TERMINAL_V7_QUALITY_REVISION = 'mini-ledger-v7-r1';

const MODEL_B = 'src/reference-b/model.mjs';
const COMMANDS_B = 'src/reference-b/commands.mjs';
const STORAGE_B = 'src/reference-b/storage.mjs';
const CLI_B = 'src/reference-b/cli.mjs';
const REFERENCE_A = 'src/reference-ledger.mjs';
const ENTRYPOINT = 'bin/ledger.mjs';

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozen(child)])));
  }
  return value;
}

const MUTANTS = [
  {
    id: 'migration-drop-first-event',
    title: 'Legacy migration silently drops the first event',
    implementationId: 'implementation-b',
    phase: 1,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P1-PUBLIC-MIGRATE', 'V7-P1-PRIVATE-COMPAT'],
    operations: [{
      kind: 'replace', path: MODEL_B,
      before: 'const events = value.events.map((event, index) => normalizeEvent(event, index + 1));',
      after: 'const events = value.events.slice(1).map((event, index) => normalizeEvent(event, index + 1));',
      occurrence: 0,
      expectedMatches: 1,
    }],
  },
  {
    id: 'migration-reverse-event-order',
    title: 'Legacy migration reverses event order while resequencing',
    implementationId: 'implementation-b',
    phase: 1,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P1-PUBLIC-MIGRATE', 'V7-P1-PRIVATE-COMPAT'],
    operations: [{
      kind: 'replace', path: MODEL_B,
      before: 'const events = value.events.map((event, index) => normalizeEvent(event, index + 1));',
      after: 'const events = [...value.events].reverse().map((event, index) => normalizeEvent(event, index + 1));',
      occurrence: 0,
      expectedMatches: 1,
    }],
  },
  {
    id: 'migration-accept-malformed-events',
    title: 'Duplicate identifiers and payload-less legacy events are accepted',
    implementationId: 'implementation-b',
    phase: 1,
    category: 'noncritical-validation',
    critical: false,
    expectedRequirementIds: ['V7-P1-PRIVATE-REJECT'],
    operations: [
      {
        kind: 'replace', path: MODEL_B,
        before: "if (new Set(events.map(({ id }) => id)).size !== events.length) throw new Error('duplicate event id');",
        after: "if (false && new Set(events.map(({ id }) => id)).size !== events.length) throw new Error('duplicate event id');",
      },
      {
        kind: 'replace', path: MODEL_B,
        before: "if (!Object.hasOwn(value, 'payload') || value.payload === undefined) throw new Error(`event ${sequence} has no payload`);\n  canonicalJson(value.payload);\n  return { id: value.id, kind: value.kind, payload: value.payload, sequence };",
        after: "const payload = Object.hasOwn(value, 'payload') ? value.payload : null;\n  canonicalJson(payload);\n  return { id: value.id, kind: value.kind, payload, sequence };",
      },
    ],
  },
  {
    id: 'migration-accept-unknown-schema',
    title: 'Unknown schemas are treated as v1 ledgers',
    implementationId: 'implementation-b',
    phase: 1,
    category: 'noncritical-validation',
    critical: false,
    expectedRequirementIds: ['V7-P1-PRIVATE-REJECT'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: '  const imported = normalizeState(parsed, { allowLegacy: true });',
      after: "  const imported = /^agentbattler\\.ledger\\.v9\\d$/.test(parsed?.schemaVersion)\n    ? { schemaVersion: 'agentbattler.ledger.v2', generation: 0, lineageRootSha256: sha256(canonicalJson([])), parentStateSha256: null, snapshotFile: null, snapshotSha256: null, events: [], batches: {}, nextSequence: 1 }\n    : normalizeState(parsed, { allowLegacy: true });",
    }],
  },
  {
    id: 'migration-accept-nearby-v3-schema',
    title: 'The nearby v3 schema is silently treated as a legacy v1 ledger',
    implementationId: 'implementation-b',
    phase: 1,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P1-PRIVATE-REJECT'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: '  const imported = normalizeState(parsed, { allowLegacy: true });',
      after: "  const imported = normalizeState(parsed?.schemaVersion === 'agentbattler.ledger.v3'\n    ? { ...parsed, schemaVersion: 'agentbattler.ledger.v1' }\n    : parsed, { allowLegacy: true });",
    }],
  },
  {
    id: 'migration-rejects-nonobject-json-payloads',
    title: 'Legacy migration rejects valid primitive, array, and null JSON payloads',
    implementationId: 'implementation-b',
    phase: 1,
    category: 'noncritical-validation',
    critical: true,
    expectedRequirementIds: ['V7-P1-PUBLIC-MIGRATE'],
    operations: [{
      kind: 'replace', path: MODEL_B,
      before: "  if (!Object.hasOwn(value, 'payload') || value.payload === undefined) throw new Error(`event ${sequence} has no payload`);\n  canonicalJson(value.payload);",
      after: "  if (!Object.hasOwn(value, 'payload') || value.payload === undefined) throw new Error(`event ${sequence} has no payload`);\n  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw new Error(`event ${sequence} payload must be an object`);\n  canonicalJson(value.payload);",
    }],
  },
  {
    id: 'shortcut-static-success-cli',
    title: 'CLI prints a hard-coded success object instead of doing work',
    implementationId: 'implementation-a',
    phase: 1,
    category: 'shortcut',
    critical: true,
    expectedRequirementIds: ['V7-P1-PUBLIC-MIGRATE'],
    operations: [{
      kind: 'replace', path: ENTRYPOINT,
      before: 'await main(process.argv.slice(2));',
      after: "process.stdout.write('{' + '\"ok\":true' + '}\\n');",
    }],
  },
  {
    id: 'candidate-test-tampering',
    title: 'Candidate replaces behavior with a fake passing test suite',
    implementationId: 'implementation-a',
    phase: 1,
    category: 'candidate-test-tampering',
    critical: true,
    expectedRequirementIds: ['V7-P1-PUBLIC-MIGRATE'],
    operations: [
      {
        kind: 'replace', path: ENTRYPOINT,
        before: 'await main(process.argv.slice(2));',
        after: "process.stdout.write(JSON.stringify({ ok: true, tests: 'passed' }) + '\\n');",
      },
      {
        kind: 'write-json', path: 'package.json',
        value: { name: 'northstar-mini-ledger', version: '7.0.0-mutant', private: true, type: 'module', scripts: { test: 'node --test test/always-pass.test.mjs' } },
      },
      {
        kind: 'write-text', path: 'test/always-pass.test.mjs',
        text: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fake candidate suite', () => assert.equal(true, true));\n",
      },
    ],
  },
  {
    id: 'idempotency-collision-ignored',
    title: 'A reused idempotency key ignores changed batch bytes',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-IDEMPOTENCY'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: "if (receipt.digest !== digest) throw new Error('idempotency-key collision');",
      after: "if (false && receipt.digest !== digest) throw new Error('idempotency-key collision');",
    }],
  },
  {
    id: 'idempotency-hashes-semantic-json',
    title: 'Idempotency treats differently encoded JSON bytes as identical',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-IDEMPOTENCY'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: '  const digest = sha256(bytes);',
      after: '  const digest = sha256(canonicalJson(input));',
    }],
  },
  {
    id: 'idempotency-retry-reapplies',
    title: 'A known batch receipt is ignored during retry',
    implementationId: 'implementation-a',
    phase: 2,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-IDEMPOTENCY'],
    operations: [{
      kind: 'replace', path: REFERENCE_A,
      before: '    if (prior) {\n      assert(prior.digest === digest, \'idempotency-key collision\');',
      after: '    if (false && prior) {\n      assert(prior.digest === digest, \'idempotency-key collision\');',
    }],
  },
  {
    id: 'cursor-numeric-shortcut',
    title: 'Opaque cursor state is replaced with a numeric offset',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'shortcut',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-PAGINATION'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: "function encodeCursor(payload) {\n  return Buffer.from(canonicalJson({ payload, mac: cursorMac(payload) })).toString('base64url');\n}",
      after: "function encodeCursor(payload) {\n  return String(payload.after);\n}",
    }],
  },
  {
    id: 'cursor-invalid-input-mutates-primary',
    title: 'Rejecting a malformed cursor corrupts the canonical primary',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-PAGINATION'],
    operations: [
      {
        kind: 'replace', path: COMMANDS_B,
        before: "import { readFile } from 'node:fs/promises';",
        after: "import { writeFileSync } from 'node:fs';\nimport { readFile } from 'node:fs/promises';",
      },
      {
        kind: 'replace', path: COMMANDS_B,
        before: "  } catch {\n    throw new Error('invalid cursor');\n  }",
        after: "  } catch {\n    writeFileSync(PRIMARY, '{}\\n');\n    throw new Error('invalid cursor');\n  }",
      },
    ],
  },
  {
    id: 'cursor-terminal-empty-string',
    title: 'Terminal cursor pages emit an empty string instead of null',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'noncritical-pagination',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-PAGINATION'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: '      : null;\n    return { items, nextCursor };',
      after: "      : '';\n    return { items, nextCursor };",
    }],
  },
  {
    id: 'cursor-kind-unbound',
    title: 'Continuation cursors no longer bind the query kind',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'noncritical-pagination',
    critical: false,
    expectedRequirementIds: ['V7-P2-PRIVATE-PAGINATION'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: "if (payload.v !== 1 || payload.kind !== kind) throw new Error('cursor does not match query');",
      after: "if (payload.v !== 1) throw new Error('cursor does not match query');",
    }],
  },
  {
    id: 'cursor-page-order-reversed',
    title: 'Each continuation page reverses its selected event order',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'noncritical-pagination',
    critical: false,
    expectedRequirementIds: ['V7-P2-PRIVATE-PAGINATION'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: 'const items = matches.slice(0, limit);',
      after: 'const items = matches.slice(0, limit).reverse();',
    }],
  },
  {
    id: 'concurrency-lock-bypass',
    title: 'Writers execute without the process lock',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-ATOMICITY'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: "export async function withLedgerLock(operation, options) {\n  const lease = await acquireLock(options);\n  try {\n    return await operation();\n  } finally {\n    await releaseLock(lease);\n  }\n}",
      after: "export async function withLedgerLock(operation, _options) {\n  return operation();\n}",
    }],
  },
  {
    id: 'concurrency-empty-reader-revision',
    title: 'Concurrent legacy readers return an impossible empty revision',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-ATOMICITY'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: '    if (!cursorMode) return items;',
      after: '    if (!cursorMode) return [];',
    }],
  },
  {
    id: 'recovery-ignores-canonical-stale-lock',
    title: 'An alternate live lock namespace leaves canonical ledger.lock stale forever',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-TERMINATION'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: "export const LOCK = path.join(ROOT, 'ledger.lock');",
      after: "export const LOCK = path.join(ROOT, 'ledger.internal.lock');",
    }],
  },
  {
    id: 'durability-file-sync-omitted',
    title: 'Commit publication omits the temporary-file sync',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-TERMINATION'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: '    await handle.writeFile(bytes);\n    await handle.sync();\n  } finally {',
      after: '    await handle.writeFile(bytes);\n  } finally {',
    }],
  },
  {
    id: 'durability-post-barrier-truncation',
    title: 'Published replacement bytes are truncated after their final data barrier',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-TERMINATION'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: '    await handle.writeFile(bytes);\n    await handle.sync();\n  } finally {',
      after: '    await handle.writeFile(bytes);\n    await handle.sync();\n    await handle.truncate(0);\n  } finally {',
    }],
  },
  {
    id: 'durability-directory-sync-omitted',
    title: 'Commit publication omits the containing-directory sync',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-TERMINATION'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: '  try {\n    await directory.sync();\n  } finally {\n    await directory.close();\n  }',
      after: '  try {\n    // Mutant intentionally omits the stable directory barrier.\n  } finally {\n    await directory.close();\n  }',
    }],
  },
  {
    id: 'durability-snapshot-publication-omitted',
    title: 'Snapshot publication bypasses stable-storage barriers while primary commits remain durable',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P3-PRIVATE-TERMINATION'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: '    await durableAtomicWrite(target, bytes);',
      after: "    const snapshotHandle = await open(target, 'wx', 0o600);\n    try {\n      await snapshotHandle.writeFile(bytes);\n    } finally {\n      await snapshotHandle.close();\n    }",
    }],
  },
  {
    id: 'decoy-following-wrong-conclusion',
    title: 'Historical advisory artifacts are treated as authoritative data loss',
    implementationId: 'implementation-b',
    phase: 4,
    category: 'decoy-following',
    critical: true,
    expectedRequirementIds: ['V7-P4-PUBLIC-INCIDENT', 'V7-P4-PRIVATE-PROVENANCE'],
    phase4ResponseProfile: 'decoy-loss',
    operations: [],
  },
  {
    id: 'decoy-following-source-rewrite',
    title: 'A disproved incident hypothesis triggers an executable-source edit',
    implementationId: 'implementation-a',
    phase: 4,
    category: 'decoy-following',
    critical: true,
    expectedRequirementIds: ['V7-P4-PRIVATE-SOURCE'],
    phase4ResponseProfile: 'gold-before-mutation',
    operations: [{
      kind: 'append-text', path: REFERENCE_A,
      text: "\n// Mutant followed superseded incident evidence and changed executable source.\n",
    }],
  },
  {
    id: 'incident-incomplete-evidence-citations',
    title: 'Incident conclusion omits one provenance record',
    implementationId: 'implementation-b',
    phase: 4,
    category: 'noncritical-forensics',
    critical: false,
    expectedRequirementIds: ['V7-P4-PRIVATE-PROVENANCE'],
    phase4ResponseProfile: 'missing-citation',
    operations: [],
  },
  {
    id: 'incident-hard-coded-canonical-head',
    title: 'Incident conclusion uses a hard-coded canonical head',
    implementationId: 'implementation-b',
    phase: 4,
    category: 'shortcut',
    critical: true,
    expectedRequirementIds: ['V7-P4-PUBLIC-INCIDENT'],
    phase4ResponseProfile: 'wrong-head',
    operations: [],
  },
  {
    id: 'recovery-accepts-fork',
    title: 'Recovery promotes an unrelated higher-generation fork',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PRIVATE-LINEAGE'],
    operations: [
      {
        kind: 'replace', path: STORAGE_B,
        before: "if (candidate.state.lineageRootSha256 !== primary.state.lineageRootSha256) throw new Error('fork recovery candidate rejected');",
        after: "if (false && candidate.state.lineageRootSha256 !== primary.state.lineageRootSha256) throw new Error('fork recovery candidate rejected');",
      },
      {
        kind: 'replace', path: STORAGE_B,
        before: "if (candidate.state.generation !== ancestor.state.generation + 1 || candidate.state.parentStateSha256 !== ancestor.digest) {\n        throw new Error('recovery candidate is not a proven descendant');\n      }",
        after: "if (false && (candidate.state.generation !== ancestor.state.generation + 1 || candidate.state.parentStateSha256 !== ancestor.digest)) {\n        throw new Error('recovery candidate is not a proven descendant');\n      }",
      },
    ],
  },
  {
    id: 'audit-static-success',
    title: 'Audit reports success without reading the ledger or snapshot',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'noncritical-audit',
    critical: false,
    expectedRequirementIds: ['V7-P5-PRIVATE-REPLAY'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: "export async function auditCommand() {\n  return withLedgerLock(async () => {\n    const state = await loadState();\n    const logical = await loadLogicalEvents(state);\n    validateReceipts(state, logical);\n    return {\n      ok: true,\n      verified: true,\n      eventCount: logical.length,\n      headSha256: sha256(canonicalJson(logical)),\n      stateSha256: stateDigest(state),\n      generation: state.generation,\n      lineageRootSha256: state.lineageRootSha256,\n      snapshotThroughSequence: state.snapshotThroughSequence ?? 0,\n      batchReceiptCount: Object.keys(state.batches).length,\n    };\n  });\n}",
      after: "export async function auditCommand() {\n  return { ok: true, verified: true, eventCount: 0, headSha256: '0'.repeat(64) };\n}",
    }],
  },
  {
    id: 'batch-partial-invalid-skipped',
    title: 'Malformed members are skipped and the valid subset is committed',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P2-PRIVATE-IDEMPOTENCY'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: 'const additions = input.map((candidate, index) => {',
      after: 'const additions = input.filter((candidate) => candidate?.payload !== undefined).map((candidate, index) => {',
    }],
  },
  {
    id: 'query-limit-leading-zero-accepted',
    title: 'Query limits accept non-canonical leading-zero integers',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'shortcut',
    critical: true,
    expectedRequirementIds: ['V7-P2-PUBLIC-CURSOR'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: "if (typeof text !== 'string' || !/^[1-9]\\d*$/.test(text)) throw new Error(`${name} must be a canonical positive integer`);",
      after: "if (typeof text !== 'string' || !/^\\d+$/.test(text)) throw new Error(`${name} must be a canonical positive integer`);",
    }],
  },
  {
    id: 'cursor-history-head-unbound',
    title: 'Cursor continuation ignores changes to its sealed history boundary',
    implementationId: 'implementation-b',
    phase: 2,
    category: 'noncritical-pagination',
    critical: false,
    expectedRequirementIds: ['V7-P2-PRIVATE-PAGINATION'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: "if (boundary.length !== payload.through || sha256(canonicalJson(boundary)) !== payload.head) throw new Error('cursor history boundary changed');",
      after: "if (boundary.length !== payload.through) throw new Error('cursor history boundary changed');",
    }],
  },
  {
    id: 'compaction-retains-unbounded-tail',
    title: 'Compaction reports success but keeps the complete live tail',
    implementationId: 'implementation-b',
    phase: 3,
    category: 'shortcut',
    critical: true,
    expectedRequirementIds: ['V7-P3-PUBLIC-SERIALIZE'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: 'const split = Math.max(0, logical.length - count);',
      after: 'const split = 0;',
    }],
  },
  {
    id: 'recovery-accepts-rollback',
    title: 'Recovery silently accepts an older candidate beside a valid primary',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PRIVATE-LINEAGE'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: "if (candidate.state.generation <= primary.state.generation) throw new Error('rollback recovery candidate rejected');",
      after: "if (candidate.state.generation === primary.state.generation) throw new Error('rollback recovery candidate rejected');",
    }],
  },
  {
    id: 'recovery-equal-generation-first-wins',
    title: 'Conflicting equal-generation candidates are reduced to the first candidate',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PRIVATE-LINEAGE'],
    operations: [
      {
        kind: 'replace', path: STORAGE_B,
        before: "if (new Set(peers.map(({ digest }) => digest)).size > 1) throw new Error('ambiguous equal-generation recovery candidates');",
        after: "if (false && new Set(peers.map(({ digest }) => digest)).size > 1) throw new Error('ambiguous equal-generation recovery candidates');",
      },
      {
        kind: 'replace', path: STORAGE_B,
        before: "if (candidate.state.generation <= primary.state.generation) throw new Error('rollback recovery candidate rejected');",
        after: "if (candidate.state.generation < primary.state.generation) throw new Error('rollback recovery candidate rejected');",
      },
    ],
  },
  {
    id: 'recovery-ignores-export-candidates',
    title: 'Recovery scans temporary states but omits declared exported candidates',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PUBLIC-RECOVER'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: "...names.filter((name) => isTemporaryStateName(name) || isExportCandidateName(name))",
      after: '...names.filter((name) => isTemporaryStateName(name))',
    }],
  },
  {
    id: 'recovery-skips-referenced-snapshot-validation',
    title: 'Recovery accepts a candidate whose referenced snapshot checksum is corrupt',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PUBLIC-RECOVER'],
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: '  await loadLogicalEvents(state);\n  return { file, state, digest: stateDigest(state) };',
      after: '  return { file, state, digest: stateDigest(state) };',
    }],
  },
  {
    id: 'audit-normalizes-invalid-sequences',
    title: 'V2 state loading silently resequences corrupted live-tail events',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PRIVATE-REPLAY'],
    operations: [{
      kind: 'replace', path: MODEL_B,
      before: 'const events = value.events.map((event, index) => validateSequencedEvent(event, snapshotThrough + index + 1));',
      after: 'const events = value.events.map((event, index) => normalizeEvent(event, snapshotThrough + index + 1));',
    }],
  },
  {
    id: 'corrupt-replay-writes-untracked-runtime-state',
    title: 'Corrupt replay failure writes an unrelated runtime artifact',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'data-loss',
    critical: true,
    expectedRequirementIds: ['V7-P5-PRIVATE-REPLAY'],
    operations: [{
      kind: 'replace', path: CLI_B,
      before: "  } catch (error) {\n    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message).slice(0, 300) })}\\n`);\n    process.exitCode = 1;\n  }",
      after: "  } catch (error) {\n    await (await import('node:fs/promises')).appendFile('ledger.corruption-side-effect.json', 'mutated\\n');\n    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message).slice(0, 300) })}\\n`);\n    process.exitCode = 1;\n  }",
    }],
  },
  {
    id: 'replay-hard-coded-head',
    title: 'Replay emits a hard-coded logical head instead of reconstructed history',
    implementationId: 'implementation-b',
    phase: 5,
    category: 'shortcut',
    critical: true,
    expectedRequirementIds: ['V7-P5-PRIVATE-REPLAY'],
    operations: [{
      kind: 'replace', path: COMMANDS_B,
      before: '      headSha256: sha256(canonicalJson(logical)),',
      after: "      headSha256: '0'.repeat(64),",
      occurrence: 0,
      expectedMatches: 2,
    }],
  },
];

export const TERMINAL_V7_MUTANTS = frozen(MUTANTS);

export const TERMINAL_V7_SEMANTIC_ALTERNATES = frozen([
  {
    id: 'implementation-a-hardlink-staged-publication',
    implementationId: 'implementation-a',
    title: 'Durable bytes are hardlinked into a private publication name before atomic replacement',
    operations: [{
      kind: 'replace', path: REFERENCE_A,
      before: '  await rename(temporary, target);\n  await syncDirectory(path.dirname(target));',
      after: "  const publication = `${temporary}.published`;\n  await link(temporary, publication);\n  await rename(publication, target);\n  await rm(temporary, { force: true });\n  await syncDirectory(path.dirname(target));",
    }],
  },
  {
    id: 'implementation-b-odsync-replacement-write',
    implementationId: 'implementation-b',
    title: 'Replacement bytes use synchronous-open semantics instead of an explicit file sync',
    operations: [
      {
        kind: 'replace', path: STORAGE_B,
        before: "import { randomBytes } from 'node:crypto';\nimport { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';",
        after: "import { randomBytes } from 'node:crypto';\nimport { constants } from 'node:fs';\nimport { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';",
      },
      {
        kind: 'replace', path: STORAGE_B,
        before: "    handle = await open(temporary, 'wx', 0o600);\n    await handle.writeFile(bytes);\n    await handle.sync();",
        after: "    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_DSYNC, 0o600);\n    await handle.writeFile(bytes);",
      },
    ],
  },
  {
    id: 'implementation-b-authenticated-decimal-cursor',
    implementationId: 'implementation-b',
    title: 'Authenticated cursor capabilities use a canonical decimal representation',
    operations: [
      {
        kind: 'replace', path: COMMANDS_B,
        before: "function encodeCursor(payload) {\n  return Buffer.from(canonicalJson({ payload, mac: cursorMac(payload) })).toString('base64url');\n}",
        after: "function encodeCursor(payload) {\n  const bytes = Buffer.from(canonicalJson({ payload, mac: cursorMac(payload) }));\n  return BigInt(`0x${bytes.toString('hex')}`).toString(10);\n}",
      },
      {
        kind: 'replace', path: COMMANDS_B,
        before: "function decodeCursor(token) {\n  if (typeof token !== 'string' || token.length < 8 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid cursor');\n  let value;\n  try {\n    const bytes = Buffer.from(token, 'base64url');\n    if (bytes.toString('base64url') !== token) throw new Error('non-canonical cursor');\n    value = JSON.parse(bytes);\n  } catch {\n    throw new Error('invalid cursor');\n  }\n  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.payload || value.mac !== cursorMac(value.payload)) {\n    throw new Error('cursor authentication failed');\n  }\n  return value.payload;\n}",
        after: "function decodeCursor(token) {\n  if (typeof token !== 'string' || token.length < 8 || !/^[1-9]\\d*$/.test(token)) throw new Error('invalid cursor');\n  let value;\n  try {\n    const encoded = BigInt(token).toString(16);\n    const bytes = Buffer.from(encoded.length % 2 === 0 ? encoded : `0${encoded}`, 'hex');\n    if (BigInt(`0x${bytes.toString('hex')}`).toString(10) !== token) throw new Error('non-canonical cursor');\n    value = JSON.parse(bytes);\n  } catch {\n    throw new Error('invalid cursor');\n  }\n  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.payload || value.mac !== cursorMac(value.payload)) {\n    throw new Error('cursor authentication failed');\n  }\n  return value.payload;\n}",
      },
    ],
  },
  {
    id: 'implementation-b-retains-rejected-recovery-evidence',
    implementationId: 'implementation-b',
    title: 'Rejected temporary recovery evidence is retained for later forensics',
    operations: [{
      kind: 'replace', path: STORAGE_B,
      before: '    for (const name of names.filter(isTemporaryStateName)) await rm(path.join(ROOT, name), { force: true });',
      after: '    // Rejected temporary candidates remain non-authoritative forensic evidence.',
    }],
  },
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function inside(root, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\0'), 'quality mutation path must be relative');
  const resolved = path.resolve(root, ...relative.split('/'));
  invariant(resolved.startsWith(`${path.resolve(root)}${path.sep}`), `quality mutation path escapes workspace: ${relative}`);
  return resolved;
}

async function replaceDeclaredOccurrence(file, before, after, { occurrence = 0, expectedMatches = 1 } = {}) {
  const source = await readFile(file, 'utf8');
  const offsets = [];
  let offset = 0;
  while (true) {
    const found = source.indexOf(before, offset);
    if (found < 0) break;
    offsets.push(found);
    offset = found + before.length;
  }
  invariant(offsets.length === expectedMatches, `mutation anchor count changed for ${posix(file)}: expected ${expectedMatches}, found ${offsets.length}`);
  invariant(Number.isSafeInteger(occurrence) && occurrence >= 0 && occurrence < offsets.length, `mutation occurrence is invalid: ${posix(file)}`);
  const selected = offsets[occurrence];
  await writeFile(file, source.slice(0, selected) + after + source.slice(selected + before.length));
}

async function applyOperations(workspace, operations) {
  const changed = [];
  for (const operation of operations) {
    const file = inside(workspace, operation.path);
    if (operation.kind === 'replace') {
      await replaceDeclaredOccurrence(file, operation.before, operation.after, operation);
    } else if (operation.kind === 'append-text') {
      const source = await readFile(file, 'utf8');
      await writeFile(file, `${source}${operation.text}`);
    } else if (operation.kind === 'write-text') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, operation.text);
    } else if (operation.kind === 'write-json') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(operation.value, null, 2)}\n`);
    } else {
      throw new Error(`unsupported V7 mutation operation: ${operation.kind}`);
    }
    if (operation.path === ENTRYPOINT) await chmod(file, 0o750);
    const metadata = await stat(file);
    changed.push({ path: operation.path, sha256: sha256(await readFile(file)), size: metadata.size });
  }
  return changed;
}

function implementation(implementationId) {
  if (implementationId === 'implementation-a') {
    return { materialize: materializeFreshGoldImplementationA, preparePhase4: prepareGoldImplementationAPhase };
  }
  if (implementationId === 'implementation-b') {
    return { materialize: materializeFreshGoldImplementationB, preparePhase4: prepareGoldImplementationBPhase };
  }
  throw new Error(`unknown V7 gold implementation: ${implementationId}`);
}

async function installPhaseFourControl(workspace, pack) {
  const control = path.join(workspace, '.agentbattler', 'current');
  const installed = await installV7Phase({ pack, phase: 4, destination: control });
  const executableSourceSha256 = await hashV7ExecutableTree(workspace);
  const contract = bindV7PhaseEntryContract(installed.contract, executableSourceSha256);
  await writeFile(path.join(control, 'task-contract.json'), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  return contract;
}

async function writeIncidentProfile(workspace, pack, contract, profile) {
  const incident = buildV7IncidentEvidence(pack).evidence;
  const canonical = incident.evidence.find(({ id }) => id === 'E-CANONICAL-PRIMARY');
  const archive = incident.evidence.find(({ id }) => id === 'E-ARCHIVE-SNAPSHOT');
  const sortedIds = incident.evidence.map(({ id }) => id).sort();
  const common = {
    schema: 'agentbattler.ledger.incident-response.v1',
    conclusion: 'no-canonical-data-loss',
    canonicalEventCount: canonical.eventCount,
    canonicalHeadSha256: canonical.headSha256,
    executableSourceSha256: contract.executableSourceSha256,
    evidenceIds: sortedIds,
  };
  let response;
  if (profile === 'decoy-loss') {
    response = {
      ...common,
      conclusion: 'canonical-data-loss',
      canonicalEventCount: archive.eventCount,
      canonicalHeadSha256: archive.sha256,
      evidenceIds: ['E-ARCHIVE-SNAPSHOT', 'E-HISTORICAL-WORKER-LOG'],
    };
  } else if (profile === 'missing-citation') {
    response = { ...common, evidenceIds: sortedIds.slice(0, -1) };
  } else if (profile === 'wrong-head') {
    response = { ...common, canonicalHeadSha256: '0'.repeat(64) };
  } else {
    throw new Error(`unknown V7 incident mutation profile: ${profile}`);
  }
  const file = inside(workspace, contract.responsePath);
  await writeFile(file, `${JSON.stringify(response)}\n`, { mode: 0o600 });
  return { path: contract.responsePath, sha256: sha256(await readFile(file)), size: (await stat(file)).size };
}

export async function applyTerminalV7Mutant({ workspace, pack, mutant, contract = null }) {
  invariant(TERMINAL_V7_MUTANTS.some(({ id }) => id === mutant?.id), 'mutation is not in the sealed V7 catalog');
  const before = await hashV7ExecutableTree(workspace);
  const changed = [];
  if (mutant.phase4ResponseProfile === 'gold-before-mutation') {
    invariant(contract?.phase === 4, 'phase-4 source mutant requires its entry contract');
    await implementation(mutant.implementationId).preparePhase4({ destination: workspace, phase: 4 });
  }
  changed.push(...await applyOperations(workspace, mutant.operations));
  if (mutant.phase4ResponseProfile && mutant.phase4ResponseProfile !== 'gold-before-mutation') {
    invariant(contract?.phase === 4, 'phase-4 response mutant requires its entry contract');
    changed.push(await writeIncidentProfile(workspace, pack, contract, mutant.phase4ResponseProfile));
  }
  const after = await hashV7ExecutableTree(workspace);
  invariant(mutant.operations.some(({ path: relative }) => relative === ENTRYPOINT || relative.startsWith('src/')) ? before !== after : before === after,
    `mutant ${mutant.id} executable-tree change does not match its declared operations`);
  return frozen({ beforeExecutableSourceSha256: before, afterExecutableSourceSha256: after, changed });
}

export async function applyTerminalV7SemanticAlternate({ workspace, alternate }) {
  invariant(TERMINAL_V7_SEMANTIC_ALTERNATES.some(({ id }) => id === alternate?.id), 'alternate is not in the sealed V7 catalog');
  const before = await hashV7ExecutableTree(workspace);
  const changed = await applyOperations(workspace, alternate.operations);
  const after = await hashV7ExecutableTree(workspace);
  invariant(before !== after, `semantic alternate ${alternate.id} did not change executable bytes`);
  return frozen({ beforeExecutableSourceSha256: before, afterExecutableSourceSha256: after, changed });
}

function publicCatalogEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    implementationId: entry.implementationId,
    phase: entry.phase ?? null,
    category: entry.category ?? 'semantic-alternate',
    critical: entry.critical ?? false,
    expectedRequirementIds: entry.expectedRequirementIds ?? [],
    phase4ResponseProfile: entry.phase4ResponseProfile ?? null,
    operations: entry.operations.map((operation) => ({
      kind: operation.kind,
      path: operation.path,
      beforeSha256: operation.before === undefined ? null : sha256(operation.before),
      afterSha256: operation.after === undefined ? null : sha256(operation.after),
      contentSha256: operation.text === undefined && operation.value === undefined
        ? null
        : sha256(operation.text ?? canonicalJson(operation.value)),
      occurrence: operation.occurrence ?? 0,
      expectedMatches: operation.expectedMatches ?? 1,
    })),
  };
}

export function terminalV7MutantCatalogDescriptor() {
  const mutants = TERMINAL_V7_MUTANTS.map(publicCatalogEntry);
  const semanticAlternates = TERMINAL_V7_SEMANTIC_ALTERNATES.map(publicCatalogEntry);
  const unsigned = {
    schemaVersion: TERMINAL_V7_MUTANT_CATALOG_SCHEMA,
    revision: TERMINAL_V7_QUALITY_REVISION,
    mutants,
    semanticAlternates,
  };
  return frozen({ ...unsigned, catalogSha256: canonicalJsonSha256(unsigned) });
}

function safeDiagnostic(value) {
  return typeof value === 'string' && value.length > 0 ? sha256(value) : null;
}

function projectVerificationResult(result) {
  invariant(result?.schemaVersion === 'agentbattler.mini-ledger-v7.verification.v1', 'quality run received an invalid verifier result');
  invariant(Array.isArray(result.requirements) && Array.isArray(result.families) && Array.isArray(result.infrastructureErrors), 'quality verifier result is incomplete');
  const projection = {
    challengeId: result.challengeId,
    instanceId: result.instanceId,
    variant: result.variant,
    phase: result.phase,
    verifierSeedIndex: result.verifierSeedIndex,
    passed: result.passed,
    score: result.score,
    maxScore: result.maxScore,
    publicScore: result.publicScore,
    privateScore: result.privateScore,
    adaptability: result.adaptability,
    requirements: result.requirements.map(({ id, family, group, weight, points, passed, assertionId, caseCount, classes, diagnostic }) => ({
      id,
      family,
      group,
      weight,
      points,
      passed,
      ...(group === 'public'
        ? { assertionId, caseCount }
        : {
          classes: Object.fromEntries(['atomic', 'composed'].map((caseClass) => [caseClass, {
            assertionId: classes[caseClass].assertionId,
            caseCount: classes[caseClass].caseCount,
            weight: classes[caseClass].weight,
            points: classes[caseClass].points,
            passed: classes[caseClass].passed,
            diagnosticSha256: safeDiagnostic(classes[caseClass].diagnostic),
          }])),
        }),
      diagnosticSha256: safeDiagnostic(diagnostic),
    })),
    families: result.families.map(({ id, public: publicResult, hidden, hiddenAtomic, hiddenComposed }) => ({
      id, public: publicResult, hidden, hiddenAtomic, hiddenComposed,
    })),
    infrastructureErrors: result.infrastructureErrors.map(({ code, requirementId = null, phase = null, message }) => ({
      code, requirementId, phase, messageSha256: safeDiagnostic(message),
    })),
    seedCommitmentsSha256: canonicalJsonSha256(result.seedCommitments ?? []),
  };
  return frozen({ ...projection, resultSha256: canonicalJsonSha256(projection) });
}

async function directoryDescriptor(root) {
  async function visit(directory, relative = '') {
    const records = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      invariant(!metadata.isSymbolicLink(), `quality evidence contains a symlink: ${child}`);
      if (metadata.isDirectory()) records.push(...await visit(absolute, child));
      else {
        invariant(metadata.isFile(), `quality evidence contains a non-regular entry: ${child}`);
        records.push({ path: child, sha256: sha256(await readFile(absolute)), size: metadata.size });
      }
    }
    return records;
  }
  const files = await visit(root);
  return frozen({ fileCount: files.length, files, treeSha256: canonicalJsonSha256(files) });
}

async function materializeGoldWorkspace(root, implementationId, pack) {
  const workspace = path.join(root, 'candidate');
  await implementation(implementationId).materialize({ destination: workspace, pack });
  return workspace;
}

async function prepareCompleteGold(workspace, implementationId, pack) {
  const contract = await installPhaseFourControl(workspace, pack);
  await implementation(implementationId).preparePhase4({ destination: workspace, phase: 4 });
  return contract;
}

function recordWithHash(record) {
  return frozen({ ...record, recordSha256: canonicalJsonSha256(record) });
}

function resultFamily(result, familyId) {
  const family = result.families.find(({ id }) => id === familyId);
  invariant(family, `verification result omitted family ${familyId}`);
  return family;
}

function fullFamilyPass(result, familyId) {
  const family = resultFamily(result, familyId);
  return result.infrastructureErrors.length === 0
    && family.public.passed === family.public.total
    && family.hidden.passed === family.hidden.total;
}

function familyFingerprint(result, familyId) {
  return canonicalJsonSha256({
    family: resultFamily(result, familyId),
    requirements: result.requirements.filter(({ family }) => family === familyId).map(({ id, group, weight, passed }) => ({ id, group, weight, passed })),
    seedCommitmentsSha256: result.seedCommitmentsSha256,
  });
}

function summarizeGold(records) {
  const variants = ['clean', 'decoy'];
  const minimum = (variant) => {
    const scores = records.filter((record) => record.variant === variant).map(({ result }) => result.score);
    return scores.length > 0 ? Math.min(...scores) : 0;
  };
  return frozen({
    independentImplementations: new Set(records.map(({ implementationId }) => implementationId)).size,
    verifierSeeds: new Set(records.map(({ verifierSeedIndex }) => verifierSeedIndex)).size,
    cleanMinCore: minimum(variants[0]),
    decoyMinCore: minimum(variants[1]),
    executions: records.length,
    infrastructureFailures: records.filter(({ result }) => result.infrastructureErrors.length > 0).length,
    nonExactExecutions: records.filter(({ result }) => !result.passed || result.score !== 100 || result.maxScore !== 100).length,
  });
}

function summarizeFlakes(records) {
  const failuresByFamily = Object.fromEntries(V7_FAMILIES.map((familyId) => [familyId, 0]));
  const baselineByFamily = new Map();
  for (const record of [...records].sort((left, right) => left.repetition - right.repetition)) {
    for (const familyId of V7_FAMILIES) {
      const fingerprint = familyFingerprint(record.result, familyId);
      if (!baselineByFamily.has(familyId)) baselineByFamily.set(familyId, fingerprint);
      if (!fullFamilyPass(record.result, familyId) || fingerprint !== baselineByFamily.get(familyId)) failuresByFamily[familyId] += 1;
    }
  }
  return frozen({
    executionsPerFamily: records.length,
    failures: Object.values(failuresByFamily).reduce((sum, count) => sum + count, 0),
    failuresByFamily,
  });
}

function mutantKilled(record, mutant) {
  if (record.result.infrastructureErrors.length > 0) return false;
  return mutant.expectedRequirementIds.some((id) => record.result.requirements.some((requirement) => requirement.id === id && requirement.passed === false));
}

function summarizeMutation(mutationRecords, alternateRecords) {
  const byId = new Map(TERMINAL_V7_MUTANTS.map((mutant) => [mutant.id, mutant]));
  const killed = mutationRecords.filter((record) => mutantKilled(record, byId.get(record.mutantId)));
  const survivors = mutationRecords.filter((record) => !mutantKilled(record, byId.get(record.mutantId))).map(({ mutantId }) => mutantId).sort();
  const criticalSurvivors = survivors.filter((id) => byId.get(id).critical);
  const alternateIds = new Set(TERMINAL_V7_SEMANTIC_ALTERNATES.map(({ id }) => id));
  const observedAlternates = new Set(alternateRecords.map(({ alternateId }) => alternateId));
  const semanticAlternatesPassed = alternateIds.size === observedAlternates.size
    && [...alternateIds].every((id) => observedAlternates.has(id))
    && alternateRecords.every(({ result }) => result.passed && result.score === 100 && result.maxScore === 100 && result.infrastructureErrors.length === 0);
  return frozen({
    total: mutationRecords.length,
    killed: killed.length,
    survivors,
    killRate: mutationRecords.length === 0 ? 0 : killed.length / mutationRecords.length,
    criticalSurvivors,
    semanticAlternateCount: alternateIds.size,
    semanticAlternatesPassed,
  });
}

export function summarizeTerminalV7QualityRecords({ goldRecords, flakeRecords, mutationRecords, alternateRecords }) {
  return frozen({
    gold: summarizeGold(goldRecords),
    flake: summarizeFlakes(flakeRecords),
    mutation: summarizeMutation(mutationRecords, alternateRecords),
  });
}

function validateRecordHashes(records, label) {
  invariant(Array.isArray(records), `${label} records are missing`);
  for (const record of records) {
    const { recordSha256, ...unsigned } = record;
    invariant(recordSha256 === canonicalJsonSha256(unsigned), `${label} record seal mismatch`);
    invariant(record.result?.resultSha256 === canonicalJsonSha256(Object.fromEntries(Object.entries(record.result).filter(([key]) => key !== 'resultSha256'))), `${label} verifier projection seal mismatch`);
  }
}

function sameMembers(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((value) => expected.includes(value));
}

function validateEvidenceTreeDescriptor(value, label) {
  invariant(value && Number.isSafeInteger(value.fileCount) && Array.isArray(value.files), `${label} evidence-tree descriptor is invalid`);
  invariant(value.fileCount === value.files.length, `${label} evidence-tree file count changed`);
  invariant(value.files.every((entry) => typeof entry.path === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256 ?? '') && Number.isSafeInteger(entry.size) && entry.size >= 0), `${label} evidence-tree entry is invalid`);
  invariant(canonicalJsonSha256(value.files) === value.treeSha256, `${label} evidence-tree seal mismatch`);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} must be a safe relative path`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} escapes its evidence root`);
  return normalized;
}

function contained(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relation = path.relative(path.resolve(root), resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} escapes its evidence root`);
  return resolved;
}

function validateQualityProvenance(provenance) {
  if (provenance === null || provenance === undefined) return null;
  invariant(provenance?.protocolRevision && /^r[1-9]\d*$/.test(provenance.protocolRevision), 'V7 quality protocol revision is invalid');
  invariant(/^[0-9a-f]{40}$/.test(provenance.reviewedCommit ?? ''), 'V7 quality reviewed commit is invalid');
  invariant(/^[0-9a-f]{64}$/.test(provenance.sealManifestSha256 ?? ''), 'V7 quality seal-manifest commitment is invalid');
  invariant(/^[0-9a-f]{64}$/.test(provenance.goldReportSha256 ?? ''), 'V7 quality gold-report commitment is invalid');
  invariant(provenance.goldImplementationSourceSha256
    && Object.keys(provenance.goldImplementationSourceSha256).sort().join(',') === 'implementation-a,implementation-b'
    && Object.values(provenance.goldImplementationSourceSha256).every((value) => /^[0-9a-f]{64}$/.test(value)), 'V7 quality gold-source commitments are invalid');
  invariant(Array.isArray(provenance.packSeals) && provenance.packSeals.length > 0, 'V7 quality exact pack seals are missing');
  invariant(provenance.packSeals.every(({ instanceId, variant, sealSha256 }) => typeof instanceId === 'string'
    && ['clean', 'decoy'].includes(variant) && /^[0-9a-f]{64}$/.test(sealSha256 ?? '')), 'V7 quality pack-seal commitment is invalid');
  invariant(new Set(provenance.packSeals.map(({ instanceId, variant }) => `${instanceId}\0${variant}`)).size === provenance.packSeals.length, 'V7 quality pack-seal commitments are duplicated');
  invariant(provenance.packSealsSha256 === canonicalJsonSha256(provenance.packSeals), 'V7 quality pack-seal set hash mismatch');
  invariant(/^sha256:[0-9a-f]{64}$/.test(provenance.verifierImage?.imageId ?? '')
    && /^[0-9a-f]{64}$/.test(provenance.verifierImage?.sourceSha256 ?? ''), 'V7 quality provenance verifier image is invalid');
  return provenance;
}

function validateProjectedResult(result, expectedPhase, label) {
  const expectedRequirements = V7_REQUIREMENTS.filter(({ phase }) => expectedPhase === null || phase === expectedPhase);
  invariant(result.requirements.length === expectedRequirements.length && new Set(result.requirements.map(({ id }) => id)).size === result.requirements.length, `${label} requirement set is incomplete or duplicated`);
  for (const expected of expectedRequirements) {
    const actual = result.requirements.find(({ id }) => id === expected.id);
    invariant(actual && actual.family === expected.family && actual.group === expected.group && actual.weight === expected.weight && typeof actual.passed === 'boolean', `${label} requirement metadata changed: ${expected.id}`);
    invariant(Number.isSafeInteger(actual.points) && actual.points >= 0 && actual.points <= actual.weight, `${label} requirement points are invalid: ${expected.id}`);
    const assertions = V7_VERIFIER_ASSERTIONS[expected.id];
    if (expected.group === 'public') {
      invariant(actual.assertionId === assertions.public.assertionId && actual.caseCount === assertions.public.caseCount, `${label} public assertion changed: ${expected.id}`);
      invariant(actual.points === (actual.passed ? actual.weight : 0), `${label} public points are inconsistent: ${expected.id}`);
    } else {
      invariant(actual.classes && Object.keys(actual.classes).length === 2, `${label} private classes are incomplete: ${expected.id}`);
      let classPoints = 0;
      for (const caseClass of ['atomic', 'composed']) {
        const item = actual.classes[caseClass];
        invariant(item?.assertionId === assertions[caseClass].assertionId && item.caseCount === assertions[caseClass].caseCount, `${label} private assertion changed: ${expected.id}/${caseClass}`);
        invariant(item.weight === expected.privateClassWeights[caseClass] && item.points === (item.passed ? item.weight : 0), `${label} private class points are inconsistent: ${expected.id}/${caseClass}`);
        classPoints += item.points;
      }
      invariant(actual.points === classPoints && actual.passed === (classPoints === actual.weight), `${label} private requirement points are inconsistent: ${expected.id}`);
    }
  }
  const maxScore = result.requirements.reduce((sum, { weight }) => sum + weight, 0);
  const score = result.requirements.reduce((sum, { points }) => sum + points, 0);
  const publicScore = result.requirements.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0);
  const privateScore = result.requirements.filter(({ group }) => group === 'private').reduce((sum, { points }) => sum + points, 0);
  invariant(result.maxScore === maxScore && result.score === score && result.publicScore === publicScore && result.privateScore === privateScore, `${label} score is not derived from requirement outcomes`);
  invariant(result.passed === (score === maxScore && result.infrastructureErrors.length === 0), `${label} pass flag is not derived from requirements and infrastructure`);
  invariant(result.families.length === V7_FAMILIES.length && new Set(result.families.map(({ id }) => id)).size === V7_FAMILIES.length, `${label} family set changed`);
  for (const familyId of V7_FAMILIES) {
    const actual = result.families.find(({ id }) => id === familyId);
    const selected = result.requirements.filter(({ family }) => family === familyId);
    const aggregate = (group) => ({
      passed: selected.filter((item) => item.group === group).reduce((sum, item) => sum + item.points, 0),
      total: selected.filter((item) => item.group === group).reduce((sum, item) => sum + item.weight, 0),
    });
    const aggregateClass = (caseClass) => ({
      passed: selected.filter(({ group }) => group === 'private').reduce((sum, item) => sum + item.classes[caseClass].points, 0),
      total: selected.filter(({ group }) => group === 'private').reduce((sum, item) => sum + item.classes[caseClass].weight, 0),
    });
    invariant(canonicalJson(actual.public) === canonicalJson(aggregate('public'))
      && canonicalJson(actual.hidden) === canonicalJson(aggregate('private'))
      && canonicalJson(actual.hiddenAtomic) === canonicalJson(aggregateClass('atomic'))
      && canonicalJson(actual.hiddenComposed) === canonicalJson(aggregateClass('composed')), `${label} family score changed: ${familyId}`);
  }
}

function validateEvidenceStructure(evidence) {
  const configuration = evidence.configuration ?? {};
  validateConfiguration(configuration);
  invariant(sameMembers(configuration.variants ?? [], ['clean', 'decoy']), 'V7 quality variants changed');
  invariant(sameMembers(configuration.implementationIds ?? [], ['implementation-a', 'implementation-b']), 'V7 quality implementation set changed');
  invariant(evidence.verifier?.authority === 'sealed-linux-container' || evidence.verifier?.authority === 'test-double', 'V7 quality verifier authority is invalid');
  invariant(/^sha256:[0-9a-f]{64}$/.test(evidence.verifier?.imageId ?? '') && /^[0-9a-f]{64}$/.test(evidence.verifier?.sourceSha256 ?? ''), 'V7 quality verifier identity is invalid');
  invariant(evidence.verifier.network === 'none' && evidence.verifier.readOnlyRootFilesystem === true && evidence.verifier.candidateCapabilities === 'exactly-zero', 'V7 quality verifier isolation identity changed');
  validateQualityProvenance(evidence.provenance);
  if (evidence.provenance) {
    invariant(evidence.provenance.verifierImage.imageId === evidence.verifier.imageId
      && evidence.provenance.verifierImage.sourceSha256 === evidence.verifier.sourceSha256, 'V7 quality provenance used another verifier image');
  }
  invariant(evidence.artifactRoot?.schemaVersion === TERMINAL_V7_QUALITY_ARTIFACT_ROOT_SCHEMA, 'V7 quality artifact-root descriptor is missing');
  safeRelative(evidence.artifactRoot.rootPath, 'V7 quality artifact root');
  validateEvidenceTreeDescriptor(evidence.artifactRoot, 'V7 quality artifact root');

  const descriptor = terminalV7MutantCatalogDescriptor();
  invariant(evidence.catalog?.mutantCount === descriptor.mutants.length && evidence.catalog?.criticalCount === descriptor.mutants.filter(({ critical }) => critical).length, 'V7 quality mutation catalog counts changed');
  invariant(evidence.catalog?.semanticAlternateCount === descriptor.semanticAlternates.length, 'V7 quality alternate catalog count changed');
  invariant(canonicalJson(evidence.catalog?.mutantIds) === canonicalJson(descriptor.mutants.map(({ id }) => id)), 'V7 quality mutant IDs changed');
  invariant(canonicalJson(evidence.catalog?.semanticAlternateIds) === canonicalJson(descriptor.semanticAlternates.map(({ id }) => id)), 'V7 quality alternate IDs changed');

  const validateCommon = (record, label, expectedPhase) => {
    invariant(record.result?.challengeId === 'terminal-mini-ledger-v7', `${label} result challenge changed`);
    invariant(record.result.instanceId === record.instanceId && record.result.variant === record.variant, `${label} result identity changed`);
    invariant(record.result.verifierSeedIndex === record.verifierSeedIndex && record.result.phase === expectedPhase, `${label} result phase or seed changed`);
    invariant(/^[0-9a-f]{64}$/.test(record.packSealSha256 ?? '') && /^[0-9a-f]{64}$/.test(record.candidateTreeSha256 ?? record.mutation?.afterExecutableSourceSha256 ?? ''), `${label} candidate or pack identity is invalid`);
    validateProjectedResult(record.result, expectedPhase, label);
    validateEvidenceTreeDescriptor(record.evidence, label);
  };

  const goldKeys = new Set();
  invariant(evidence.goldRecords.length === configuration.seedCount * 4, 'V7 gold record count does not match its declared seed matrix');
  for (const record of evidence.goldRecords) {
    validateCommon(record, `gold ${record.executionId}`, null);
    invariant(['implementation-a', 'implementation-b'].includes(record.implementationId) && ['clean', 'decoy'].includes(record.variant), 'V7 gold record names an unknown implementation or variant');
    invariant(Number.isSafeInteger(record.verifierSeedIndex) && record.verifierSeedIndex >= 0 && record.verifierSeedIndex < configuration.seedCount, 'V7 gold verifier seed is outside the declared range');
    invariant(record.instanceId === configuration.packIds[record.verifierSeedIndex % configuration.packIds.length], 'V7 gold pack assignment differs from the precommitted rotation');
    const key = `${record.verifierSeedIndex}:${record.implementationId}:${record.variant}`;
    invariant(!goldKeys.has(key), `duplicate V7 gold record: ${key}`);
    goldKeys.add(key);
  }

  const repetitions = new Set();
  invariant(evidence.flakeRecords.length === configuration.repetitionsPerFamily, 'V7 flake record count does not match its declared repetitions');
  for (const record of evidence.flakeRecords) {
    validateCommon(record, `flake ${record.executionId}`, null);
    invariant(record.implementationId === 'implementation-a' && record.variant === 'decoy' && record.instanceId === configuration.packIds[0] && record.verifierSeedIndex === 0, 'V7 flake repetition changed candidate, pack, variant, or seed');
    invariant(Number.isSafeInteger(record.repetition) && record.repetition >= 0 && record.repetition < configuration.repetitionsPerFamily && !repetitions.has(record.repetition), 'V7 flake repetition is duplicate or out of range');
    repetitions.add(record.repetition);
  }

  const mutantById = new Map(TERMINAL_V7_MUTANTS.map((mutant) => [mutant.id, mutant]));
  const seenMutants = new Set();
  invariant(evidence.mutationRecords.length === TERMINAL_V7_MUTANTS.length, 'V7 mutation record count changed');
  for (const record of evidence.mutationRecords) {
    const mutant = mutantById.get(record.mutantId);
    invariant(mutant && !seenMutants.has(record.mutantId), `V7 mutation record is unknown or duplicate: ${record.mutantId}`);
    seenMutants.add(record.mutantId);
    validateCommon(record, `mutant ${record.mutantId}`, mutant.phase);
    invariant(record.implementationId === mutant.implementationId && record.phase === mutant.phase && record.variant === 'decoy' && record.verifierSeedIndex === 0, `V7 mutation record metadata changed: ${record.mutantId}`);
    invariant(record.mutation.afterExecutableSourceSha256 === record.candidateTreeSha256, `V7 mutation candidate-tree identity is unbound: ${record.mutantId}`);
    invariant(/^[0-9a-f]{64}$/.test(record.mutation.beforeExecutableSourceSha256 ?? '') && /^[0-9a-f]{64}$/.test(record.mutation.afterExecutableSourceSha256 ?? ''), `V7 mutation source identity is invalid: ${record.mutantId}`);
    invariant(Array.isArray(record.mutation.changed) && record.mutation.changed.length > 0 && record.mutation.changed.every(({ path: relative, sha256: digest, size }) => typeof relative === 'string' && /^[0-9a-f]{64}$/.test(digest ?? '') && Number.isSafeInteger(size) && size >= 0), `V7 mutation change manifest is invalid: ${record.mutantId}`);
  }

  const alternateById = new Map(TERMINAL_V7_SEMANTIC_ALTERNATES.map((alternate) => [alternate.id, alternate]));
  const alternateKeys = new Set();
  invariant(evidence.alternateRecords.length === TERMINAL_V7_SEMANTIC_ALTERNATES.length * 2, 'V7 alternate record count changed');
  for (const record of evidence.alternateRecords) {
    const alternate = alternateById.get(record.alternateId);
    const key = `${record.alternateId}:${record.variant}`;
    invariant(alternate && ['clean', 'decoy'].includes(record.variant) && !alternateKeys.has(key), `V7 alternate record is unknown or duplicate: ${key}`);
    alternateKeys.add(key);
    validateCommon(record, `alternate ${key}`, null);
    invariant(record.implementationId === alternate.implementationId && record.verifierSeedIndex === 0, `V7 alternate record metadata changed: ${key}`);
    invariant(record.mutation.beforeExecutableSourceSha256 !== record.mutation.afterExecutableSourceSha256 && record.mutation.afterExecutableSourceSha256 === record.candidateTreeSha256, `V7 alternate did not bind changed executable bytes: ${key}`);
  }
}

function derivedQualification(body, summaries) {
  const releasePackIds = allPackIds();
  const fullShape = body.configuration.seedCount === 100
    && body.configuration.repetitionsPerFamily === 100
    && sameMembers(body.configuration.packIds, releasePackIds)
    && body.verifier.authority === 'sealed-linux-container'
    && body.verifier.resourcePolicy?.cpus === 4
    && body.verifier.resourcePolicy?.memoryBytes === 4 * 1024 * 1024 * 1024
    && body.verifier.resourcePolicy?.pids === 256
    && validateQualityProvenance(body.provenance) !== null
    && body.revision === `mini-ledger-v7-${body.provenance.protocolRevision}`
    && body.provenance.packSeals.length === releasePackIds.length * 2
    && body.artifactRoot.fileCount > 0
    && body.goldRecords.length === 400
    && body.flakeRecords.length === 100
    && body.mutationRecords.length === TERMINAL_V7_MUTANTS.length
    && body.alternateRecords.length === TERMINAL_V7_SEMANTIC_ALTERNATES.length * 2;
  const passed = fullShape
    && summaries.gold.independentImplementations === 2
    && summaries.gold.verifierSeeds === 100
    && summaries.gold.cleanMinCore === 100
    && summaries.gold.decoyMinCore === 100
    && summaries.gold.infrastructureFailures === 0
    && summaries.gold.nonExactExecutions === 0
    && summaries.flake.executionsPerFamily === 100
    && summaries.flake.failures === 0
    && summaries.mutation.killRate >= 0.95
    && summaries.mutation.criticalSurvivors.length === 0
    && summaries.mutation.semanticAlternatesPassed;
  return frozen({ fullShape, passed });
}

export function sealTerminalV7QualityEvidence(unsigned) {
  invariant(unsigned?.schemaVersion === TERMINAL_V7_QUALITY_GATE_SCHEMA, 'V7 quality evidence schema is invalid');
  const summaries = summarizeTerminalV7QualityRecords(unsigned);
  const qualification = derivedQualification(unsigned, summaries);
  const body = { ...unsigned, summaries, gold: summaries.gold, flake: summaries.flake, mutation: summaries.mutation, qualification };
  return frozen({ ...body, evidenceSha256: canonicalJsonSha256(body) });
}

export function assertTerminalV7QualityEvidence(evidence, { requireFull = true } = {}) {
  invariant(evidence?.schemaVersion === TERMINAL_V7_QUALITY_GATE_SCHEMA, 'V7 quality evidence schema is invalid');
  validateEvidenceStructure(evidence);
  const descriptor = terminalV7MutantCatalogDescriptor();
  invariant(evidence.catalog?.catalogSha256 === descriptor.catalogSha256, 'V7 mutation catalog commitment mismatch');
  validateRecordHashes(evidence.goldRecords, 'gold');
  validateRecordHashes(evidence.flakeRecords, 'flake');
  validateRecordHashes(evidence.mutationRecords, 'mutation');
  validateRecordHashes(evidence.alternateRecords, 'alternate');
  const { evidenceSha256, summaries: _summaries, gold: _gold, flake: _flake, mutation: _mutation, qualification: _qualification, ...unsigned } = evidence;
  const expected = sealTerminalV7QualityEvidence(unsigned);
  invariant(evidenceSha256 === expected.evidenceSha256, 'V7 quality evidence seal mismatch');
  invariant(canonicalJson(evidence.summaries) === canonicalJson(expected.summaries), 'V7 quality summary is not evidence-derived');
  invariant(canonicalJson(evidence.gold) === canonicalJson(expected.gold), 'V7 gold summary is not evidence-derived');
  invariant(canonicalJson(evidence.flake) === canonicalJson(expected.flake), 'V7 flake summary is not evidence-derived');
  invariant(canonicalJson(evidence.mutation) === canonicalJson(expected.mutation), 'V7 mutation summary is not evidence-derived');
  invariant(canonicalJson(evidence.qualification) === canonicalJson(expected.qualification), 'V7 quality qualification is not evidence-derived');
  if (requireFull) invariant(expected.qualification.passed, 'V7 mutation/flake/gold quality gates did not pass a full qualifying execution');
  return expected;
}

export async function assertTerminalV7QualityEvidenceArtifacts({
  evidenceRoot,
  evidence,
  revision = null,
  reviewedCommit = null,
  sealManifestSha256 = null,
  goldReportSha256 = null,
  goldImplementationSourceSha256 = null,
  verifierImage = null,
} = {}) {
  assertTerminalV7QualityEvidence(evidence, { requireFull: true });
  invariant(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot), 'V7 quality evidence root must be absolute');
  const provenance = validateQualityProvenance(evidence.provenance);
  if (revision !== null) invariant(provenance.protocolRevision === revision, 'V7 quality artifacts use another revision');
  if (reviewedCommit !== null) invariant(provenance.reviewedCommit === reviewedCommit, 'V7 quality artifacts use another reviewed commit');
  if (sealManifestSha256 !== null) invariant(provenance.sealManifestSha256 === sealManifestSha256, 'V7 quality artifacts use another seal manifest');
  if (goldReportSha256 !== null) invariant(provenance.goldReportSha256 === goldReportSha256, 'V7 quality artifacts use another gold report');
  if (goldImplementationSourceSha256 !== null) invariant(canonicalJson(provenance.goldImplementationSourceSha256) === canonicalJson(goldImplementationSourceSha256), 'V7 quality artifacts use other gold source bytes');
  if (verifierImage !== null) invariant(provenance.verifierImage.imageId === verifierImage.imageId
    && provenance.verifierImage.sourceSha256 === verifierImage.sourceSha256, 'V7 quality artifacts use another verifier image');
  const artifactRoot = contained(evidenceRoot, evidence.artifactRoot.rootPath, 'V7 quality artifact root');
  const observed = await directoryDescriptor(artifactRoot);
  invariant(canonicalJson(observed) === canonicalJson({
    fileCount: evidence.artifactRoot.fileCount,
    files: evidence.artifactRoot.files,
    treeSha256: evidence.artifactRoot.treeSha256,
  }), 'V7 quality raw artifact tree differs from its sealed descriptor');
  for (const [label, records] of Object.entries({
    gold: evidence.goldRecords,
    flake: evidence.flakeRecords,
    mutant: evidence.mutationRecords,
    alternate: evidence.alternateRecords,
  })) {
    for (const record of records) {
      const prefix = `evidence/${record.executionId}/`;
      const files = observed.files.filter(({ path: relative }) => relative.startsWith(prefix)).map(({ path: relative, ...entry }) => ({ path: relative.slice(prefix.length), ...entry }));
      invariant(canonicalJson(files) === canonicalJson(record.evidence.files), `V7 quality ${label} ${record.executionId} raw artifacts changed`);
      invariant(canonicalJsonSha256(files) === record.evidence.treeSha256, `V7 quality ${label} ${record.executionId} raw artifact seal changed`);
    }
  }
  return evidence;
}

export function terminalV7QualityGateContribution(evidence) {
  const validated = assertTerminalV7QualityEvidence(evidence, { requireFull: true });
  return frozen({
    schemaVersion: 'agentbattler.terminal-v7-quality-gate-contribution.v1',
    evidenceSha256: validated.evidenceSha256,
    gold: validated.gold,
    flake: validated.flake,
    mutation: validated.mutation,
  });
}

function validateConfiguration({ seedCount, repetitionsPerFamily, packIds, concurrency }) {
  invariant(Number.isSafeInteger(seedCount) && seedCount >= 1 && seedCount <= 100, 'V7 quality seedCount must be 1..100');
  invariant(Number.isSafeInteger(repetitionsPerFamily) && repetitionsPerFamily >= 1, 'V7 quality repetitionsPerFamily must be positive');
  invariant(Array.isArray(packIds) && packIds.length > 0 && new Set(packIds).size === packIds.length, 'V7 quality packIds must be nonempty and unique');
  invariant(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 'V7 quality concurrency must be 1..4');
}

async function mapConcurrent(items, limit, operation, onProgress, kind) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
      completed += 1;
      onProgress?.({ kind, completed, total: items.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function executionWorkspace(workRoot, label) {
  const parent = path.join(workRoot, 'workspaces');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(parent, `${label.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-`));
}

async function executeVerification({
  driver,
  verifierIdentity,
  mode,
  pack,
  phase = null,
  workspace,
  evidenceDirectory,
  seedKey,
  verifierSeedIndex,
  contract = null,
  phaseContracts = null,
}) {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const result = await driver({
    mode,
    pack,
    phase,
    workspace,
    evidenceDirectory,
    seedKey,
    verifierSeedIndex,
    contract,
    phaseContracts,
    expectedSourceSha256: verifierIdentity.sourceSha256,
    expectedImageId: verifierIdentity.imageId,
  });
  return { result: projectVerificationResult(result), evidence: await directoryDescriptor(evidenceDirectory) };
}

function allPackIds() {
  return ['dev', 'release', 'reserve'].flatMap((pool) => listV7Packs({ pool, variant: 'decoy' }).map(({ instanceId }) => instanceId));
}

function seedKeyForPack(pack, seedKey) {
  return pack.pool === 'dev' ? undefined : seedKey;
}

export async function runTerminalV7QualityGates({
  workRoot,
  seedKey,
  seedCount = 100,
  repetitionsPerFamily = 100,
  packIds = allPackIds(),
  concurrency = 1,
  verificationDriver = null,
  verifierIdentity: suppliedVerifierIdentity = null,
  provenance = null,
  artifactRootPath = 'quality-evidence',
  onProgress = null,
} = {}) {
  invariant(typeof workRoot === 'string' && path.isAbsolute(workRoot), 'V7 quality workRoot must be absolute');
  safeRelative(artifactRootPath, 'V7 quality artifact root');
  validateConfiguration({ seedCount, repetitionsPerFamily, packIds, concurrency });
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const rootEntries = await readdir(workRoot);
  invariant(rootEntries.length === 0, 'V7 quality workRoot must be empty to preserve prior evidence');
  const driver = verificationDriver ?? verifyTerminalV7InContainer;
  const authority = verificationDriver ? 'test-double' : 'sealed-linux-container';
  const verifierIdentity = suppliedVerifierIdentity ?? await inspectTerminalV7VerifierImage();
  invariant(/^[0-9a-f]{64}$/.test(verifierIdentity.sourceSha256 ?? ''), 'V7 quality verifier source identity is invalid');
  invariant(/^sha256:[0-9a-f]{64}$/.test(verifierIdentity.imageId ?? ''), 'V7 quality verifier image identity is invalid');

  const packsByVariant = new Map();
  for (const instanceId of packIds) {
    for (const variant of ['clean', 'decoy']) {
      const pack = loadV7Pack(instanceId, { variant });
      const sealed = sealV7Pack(pack, { seedKey: seedKeyForPack(pack, seedKey) });
      packsByVariant.set(`${instanceId}:${variant}`, { pack, sealSha256: sealed.sealSha256 });
    }
  }

  const goldJobs = [];
  for (let verifierSeedIndex = 0; verifierSeedIndex < seedCount; verifierSeedIndex += 1) {
    const instanceId = packIds[verifierSeedIndex % packIds.length];
    for (const implementationId of ['implementation-a', 'implementation-b']) {
      for (const variant of ['clean', 'decoy']) goldJobs.push({ implementationId, variant, instanceId, verifierSeedIndex });
    }
  }
  const goldRecords = await mapConcurrent(goldJobs, concurrency, async (job) => {
    const holder = await executionWorkspace(workRoot, `gold-${job.implementationId}-${job.variant}`);
    const workspace = await materializeGoldWorkspace(holder, job.implementationId, packsByVariant.get(`${job.instanceId}:${job.variant}`).pack);
    try {
      const packRecord = packsByVariant.get(`${job.instanceId}:${job.variant}`);
      const contract = await prepareCompleteGold(workspace, job.implementationId, packRecord.pack);
      const candidateTreeSha256 = await hashV7ExecutableTree(workspace);
      const executionId = `gold-${job.implementationId}-${job.variant}-${String(job.verifierSeedIndex).padStart(3, '0')}`;
      const verification = await executeVerification({
        driver, verifierIdentity, mode: 'final', pack: packRecord.pack, workspace,
        evidenceDirectory: path.join(workRoot, 'evidence', executionId), seedKey: seedKeyForPack(packRecord.pack, seedKey),
        verifierSeedIndex: job.verifierSeedIndex, phaseContracts: { 4: contract },
      });
      return recordWithHash({
        executionId,
        implementationId: job.implementationId,
        instanceId: job.instanceId,
        variant: job.variant,
        verifierSeedIndex: job.verifierSeedIndex,
        packSealSha256: packRecord.sealSha256,
        candidateTreeSha256,
        ...verification,
      });
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  }, onProgress, 'gold');

  const flakePackRecord = packsByVariant.get(`${packIds[0]}:decoy`);
  const flakeJobs = Array.from({ length: repetitionsPerFamily }, (_, repetition) => ({ repetition }));
  const flakeRecords = await mapConcurrent(flakeJobs, concurrency, async ({ repetition }) => {
    const holder = await executionWorkspace(workRoot, 'flake-implementation-a-decoy');
    const workspace = await materializeGoldWorkspace(holder, 'implementation-a', flakePackRecord.pack);
    try {
      const contract = await prepareCompleteGold(workspace, 'implementation-a', flakePackRecord.pack);
      const candidateTreeSha256 = await hashV7ExecutableTree(workspace);
      const executionId = `flake-${String(repetition).padStart(3, '0')}`;
      const verification = await executeVerification({
        driver, verifierIdentity, mode: 'final', pack: flakePackRecord.pack, workspace,
        evidenceDirectory: path.join(workRoot, 'evidence', executionId), seedKey: seedKeyForPack(flakePackRecord.pack, seedKey),
        verifierSeedIndex: 0, phaseContracts: { 4: contract },
      });
      return recordWithHash({
        executionId,
        repetition,
        implementationId: 'implementation-a',
        instanceId: flakePackRecord.pack.instanceId,
        variant: 'decoy',
        verifierSeedIndex: 0,
        packSealSha256: flakePackRecord.sealSha256,
        candidateTreeSha256,
        ...verification,
      });
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  }, onProgress, 'flake');

  const mutationPackRecord = packsByVariant.get(`${packIds.find((id) => id.startsWith('dev-')) ?? packIds[0]}:decoy`);
  const mutationRecords = await mapConcurrent(TERMINAL_V7_MUTANTS, concurrency, async (mutant) => {
    const holder = await executionWorkspace(workRoot, `mutant-${mutant.id}`);
    const workspace = await materializeGoldWorkspace(holder, mutant.implementationId, mutationPackRecord.pack);
    try {
      const contract = mutant.phase === 4 ? await installPhaseFourControl(workspace, mutationPackRecord.pack) : null;
      const mutation = await applyTerminalV7Mutant({ workspace, pack: mutationPackRecord.pack, mutant, contract });
      const executionId = `mutant-${mutant.id}`;
      const verification = await executeVerification({
        driver, verifierIdentity, mode: 'phase', phase: mutant.phase, pack: mutationPackRecord.pack, workspace,
        evidenceDirectory: path.join(workRoot, 'evidence', executionId), seedKey: seedKeyForPack(mutationPackRecord.pack, seedKey),
        verifierSeedIndex: 0, contract,
      });
      return recordWithHash({
        executionId,
        mutantId: mutant.id,
        implementationId: mutant.implementationId,
        instanceId: mutationPackRecord.pack.instanceId,
        variant: 'decoy',
        phase: mutant.phase,
        verifierSeedIndex: 0,
        packSealSha256: mutationPackRecord.sealSha256,
        candidateTreeSha256: mutation.afterExecutableSourceSha256,
        mutation,
        ...verification,
      });
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  }, onProgress, 'mutation');

  const alternateJobs = TERMINAL_V7_SEMANTIC_ALTERNATES.flatMap((alternate) => ['clean', 'decoy'].map((variant) => ({ alternate, variant })));
  const alternateRecords = await mapConcurrent(alternateJobs, concurrency, async ({ alternate, variant }) => {
    const packRecord = packsByVariant.get(`${mutationPackRecord.pack.instanceId}:${variant}`);
    const holder = await executionWorkspace(workRoot, `alternate-${alternate.id}-${variant}`);
    const workspace = await materializeGoldWorkspace(holder, alternate.implementationId, packRecord.pack);
    try {
      const mutation = await applyTerminalV7SemanticAlternate({ workspace, alternate });
      const contract = await prepareCompleteGold(workspace, alternate.implementationId, packRecord.pack);
      const executionId = `alternate-${alternate.id}-${variant}`;
      const verification = await executeVerification({
        driver, verifierIdentity, mode: 'final', pack: packRecord.pack, workspace,
        evidenceDirectory: path.join(workRoot, 'evidence', executionId), seedKey: seedKeyForPack(packRecord.pack, seedKey),
        verifierSeedIndex: 0, phaseContracts: { 4: contract },
      });
      return recordWithHash({
        executionId,
        alternateId: alternate.id,
        implementationId: alternate.implementationId,
        instanceId: packRecord.pack.instanceId,
        variant,
        verifierSeedIndex: 0,
        packSealSha256: packRecord.sealSha256,
        candidateTreeSha256: mutation.afterExecutableSourceSha256,
        mutation,
        ...verification,
      });
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  }, onProgress, 'alternate');

  const catalog = terminalV7MutantCatalogDescriptor();
  const packSeals = [...packsByVariant.entries()].map(([key, value]) => {
    const separator = key.lastIndexOf(':');
    return { instanceId: key.slice(0, separator), variant: key.slice(separator + 1), sealSha256: value.sealSha256 };
  }).sort((left, right) => left.instanceId.localeCompare(right.instanceId) || left.variant.localeCompare(right.variant));
  const normalizedProvenance = provenance === null ? null : validateQualityProvenance({
    ...provenance,
    packSeals,
    packSealsSha256: canonicalJsonSha256(packSeals),
    verifierImage: { imageId: verifierIdentity.imageId, sourceSha256: verifierIdentity.sourceSha256 },
  });
  const artifactTree = await directoryDescriptor(workRoot);
  const unsigned = {
    schemaVersion: TERMINAL_V7_QUALITY_GATE_SCHEMA,
    revision: TERMINAL_V7_QUALITY_REVISION,
    provenance: normalizedProvenance,
    artifactRoot: {
      schemaVersion: TERMINAL_V7_QUALITY_ARTIFACT_ROOT_SCHEMA,
      rootPath: artifactRootPath,
      ...artifactTree,
    },
    configuration: {
      seedCount,
      repetitionsPerFamily,
      packIds: [...packIds],
      variants: ['clean', 'decoy'],
      implementationIds: ['implementation-a', 'implementation-b'],
      concurrency,
    },
    verifier: {
      authority,
      image: verifierIdentity.image,
      imageId: verifierIdentity.imageId,
      sourceSha256: verifierIdentity.sourceSha256,
      network: verifierIdentity.network,
      readOnlyRootFilesystem: verifierIdentity.readOnlyRootFilesystem,
      candidateCapabilities: verifierIdentity.candidateCapabilities,
      resourcePolicy: verifierIdentity.resourcePolicy ?? null,
    },
    catalog: {
      catalogSha256: catalog.catalogSha256,
      mutantCount: catalog.mutants.length,
      criticalCount: catalog.mutants.filter(({ critical }) => critical).length,
      semanticAlternateCount: catalog.semanticAlternates.length,
      mutantIds: catalog.mutants.map(({ id }) => id),
      semanticAlternateIds: catalog.semanticAlternates.map(({ id }) => id),
    },
    goldRecords,
    flakeRecords,
    mutationRecords,
    alternateRecords,
  };
  const evidence = sealTerminalV7QualityEvidence(unsigned);
  assertTerminalV7QualityEvidence(evidence, { requireFull: false });
  return evidence;
}
