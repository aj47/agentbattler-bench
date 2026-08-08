import { createHash } from 'node:crypto';

export const V7_FAMILIES = Object.freeze([
  'migration-compatibility',
  'idempotency-pagination',
  'concurrency-atomicity',
  'crash-recovery',
  'audit-replay-scale',
]);

export const V7_PRIVATE_SCORE_CLASSES = Object.freeze({
  atomic: Object.freeze({
    id: 'atomic',
    description: 'Seeded variants of one disclosed behavioral contract.',
    perFamilyWeight: 6,
    totalWeight: 30,
  }),
  composed: Object.freeze({
    id: 'composed',
    description: 'Seeded cross-feature, interleaving, scale, or fault scenarios.',
    perFamilyWeight: 10,
    totalWeight: 50,
  }),
});

const FAMILY_BY_REQUIREMENT = Object.freeze({
  'V7-P1-PUBLIC-MIGRATE': 'migration-compatibility',
  'V7-P1-PRIVATE-COMPAT': 'migration-compatibility',
  'V7-P1-PRIVATE-REJECT': 'migration-compatibility',
  'V7-P2-PUBLIC-BATCH': 'idempotency-pagination',
  'V7-P2-PUBLIC-CURSOR': 'idempotency-pagination',
  'V7-P2-PRIVATE-IDEMPOTENCY': 'idempotency-pagination',
  'V7-P2-PRIVATE-PAGINATION': 'idempotency-pagination',
  'V7-P3-PUBLIC-SERIALIZE': 'concurrency-atomicity',
  'V7-P3-PRIVATE-ATOMICITY': 'concurrency-atomicity',
  'V7-P3-PRIVATE-TERMINATION': 'crash-recovery',
  'V7-P4-PUBLIC-INCIDENT': 'audit-replay-scale',
  'V7-P4-PRIVATE-PROVENANCE': 'audit-replay-scale',
  'V7-P4-PRIVATE-SOURCE': 'audit-replay-scale',
  'V7-P5-PUBLIC-RECOVER': 'crash-recovery',
  'V7-P5-PRIVATE-LINEAGE': 'crash-recovery',
  'V7-P5-PRIVATE-REPLAY': 'audit-replay-scale',
  'V7-P5-PRIVATE-SCALE': 'audit-replay-scale',
});

const PRIVATE_CLASS_WEIGHTS = Object.freeze({
  'V7-P1-PRIVATE-COMPAT': Object.freeze({ atomic: 4, composed: 4 }),
  'V7-P1-PRIVATE-REJECT': Object.freeze({ atomic: 2, composed: 6 }),
  'V7-P2-PRIVATE-IDEMPOTENCY': Object.freeze({ atomic: 3, composed: 5 }),
  'V7-P2-PRIVATE-PAGINATION': Object.freeze({ atomic: 3, composed: 5 }),
  'V7-P3-PRIVATE-ATOMICITY': Object.freeze({ atomic: 6, composed: 10 }),
  'V7-P3-PRIVATE-TERMINATION': Object.freeze({ atomic: 3, composed: 5 }),
  'V7-P4-PRIVATE-PROVENANCE': Object.freeze({ atomic: 2, composed: 2 }),
  'V7-P4-PRIVATE-SOURCE': Object.freeze({ atomic: 1, composed: 3 }),
  'V7-P5-PRIVATE-LINEAGE': Object.freeze({ atomic: 3, composed: 5 }),
  'V7-P5-PRIVATE-REPLAY': Object.freeze({ atomic: 1, composed: 3 }),
  'V7-P5-PRIVATE-SCALE': Object.freeze({ atomic: 2, composed: 2 }),
});

export const V7_REQUIREMENTS = Object.freeze([
  { id: 'V7-P1-PUBLIC-MIGRATE', phase: 1, group: 'public', weight: 4, description: 'Legacy v1 state migrates to v2 without losing events or ordering.' },
  { id: 'V7-P1-PRIVATE-COMPAT', phase: 1, group: 'private', weight: 8, description: 'Append, get, query, export, and re-import remain backward compatible after migration.' },
  { id: 'V7-P1-PRIVATE-REJECT', phase: 1, group: 'private', weight: 8, description: 'Malformed and unknown legacy inputs fail without changing canonical state.' },
  { id: 'V7-P2-PUBLIC-BATCH', phase: 2, group: 'public', weight: 2, description: 'A valid batch is applied once under an idempotency key.' },
  { id: 'V7-P2-PUBLIC-CURSOR', phase: 2, group: 'public', weight: 2, description: 'Query returns ordered pages with an opaque continuation cursor.' },
  { id: 'V7-P2-PRIVATE-IDEMPOTENCY', phase: 2, group: 'private', weight: 8, description: 'Batch retries are byte-idempotent and key collisions are rejected atomically.' },
  { id: 'V7-P2-PRIVATE-PAGINATION', phase: 2, group: 'private', weight: 8, description: 'Opaque cursors have stable boundaries, bind filters, and reject tampering.' },
  { id: 'V7-P3-PUBLIC-SERIALIZE', phase: 3, group: 'public', weight: 4, description: 'Append, import, and compaction preserve a valid serializable state under concurrency.' },
  { id: 'V7-P3-PRIVATE-ATOMICITY', phase: 3, group: 'private', weight: 16, description: 'Concurrent writers do not corrupt state, duplicate sequences, or expose partial commits.' },
  { id: 'V7-P3-PRIVATE-TERMINATION', phase: 3, group: 'private', weight: 8, description: 'Termination during a write leaves a recoverable prior-or-next commit and no permanent lock.' },
  { id: 'V7-P4-PUBLIC-INCIDENT', phase: 4, group: 'public', weight: 4, description: 'The supplied incident evidence is correctly classified as no canonical data loss.' },
  { id: 'V7-P4-PRIVATE-PROVENANCE', phase: 4, group: 'private', weight: 4, description: 'The conclusion cites falsifiable lineage, hashes, and deployment provenance.' },
  { id: 'V7-P4-PRIVATE-SOURCE', phase: 4, group: 'private', weight: 4, description: 'Correct executable source remains byte-identical while the incident response is produced.' },
  { id: 'V7-P5-PUBLIC-RECOVER', phase: 5, group: 'public', weight: 4, description: 'Recovery selects a valid lineage after primary corruption.' },
  { id: 'V7-P5-PRIVATE-LINEAGE', phase: 5, group: 'private', weight: 8, description: 'Recovery reconciles temporary, snapshot, and primary candidates by validated lineage.' },
  { id: 'V7-P5-PRIVATE-REPLAY', phase: 5, group: 'private', weight: 4, description: 'Replay and audit detect corruption and reconstruct exact logical history.' },
  { id: 'V7-P5-PRIVATE-SCALE', phase: 5, group: 'private', weight: 4, description: 'Mixed append, batch, query, import, compaction, replay, and audit workloads preserve all earlier contracts at scale.' },
].map((requirement) => Object.freeze({
  ...requirement,
  family: FAMILY_BY_REQUIREMENT[requirement.id],
  ...(requirement.group === 'private'
    ? { privateClassWeights: PRIVATE_CLASS_WEIGHTS[requirement.id] }
    : {}),
})));

export const V7_PRIVATE_REQUIREMENT_CLASSIFICATION = Object.freeze(V7_REQUIREMENTS
  .filter(({ group }) => group === 'private')
  .map(({ id, phase, family, weight, privateClassWeights }) => Object.freeze({
    requirementId: id,
    phase,
    family,
    weight,
    atomicWeight: privateClassWeights.atomic,
    composedWeight: privateClassWeights.composed,
  })));

export const V7_PHASES = Object.freeze([
  { phase: 1, id: 'legacy-migration', title: 'Repair migration without breaking clients' },
  { phase: 2, id: 'batch-pagination', title: 'Make ingestion and pagination replay-safe' },
  { phase: 3, id: 'concurrent-lifecycle', title: 'Serialize writes through process failure' },
  { phase: 4, id: 'incident-evidence', title: 'Resolve the data-loss report from evidence' },
  { phase: 5, id: 'recovery-scale', title: 'Reconcile lineage and survive mixed scale' },
].map((entry) => Object.freeze({
  ...entry,
  familyIds: Object.freeze([...new Set(V7_REQUIREMENTS.filter(({ phase }) => phase === entry.phase).map(({ family }) => family))]),
  requirementIds: Object.freeze(V7_REQUIREMENTS.filter(({ phase }) => phase === entry.phase).map(({ id }) => id)),
  weight: V7_REQUIREMENTS.filter(({ phase }) => phase === entry.phase).reduce((sum, { weight }) => sum + weight, 0),
})));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const V7_REQUIREMENTS_SHA256 = sha256(canonicalJson(V7_REQUIREMENTS));

export const V7_SCORE_GROUPS = Object.freeze({
  public: Object.freeze({ weight: 20, requirementIds: Object.freeze(V7_REQUIREMENTS.filter(({ group }) => group === 'public').map(({ id }) => id)) }),
  private: Object.freeze({
    weight: 80,
    requirementIds: Object.freeze(V7_REQUIREMENTS.filter(({ group }) => group === 'private').map(({ id }) => id)),
    classes: V7_PRIVATE_SCORE_CLASSES,
  }),
});

const totalWeight = V7_REQUIREMENTS.reduce((sum, { weight }) => sum + weight, 0);
if (totalWeight !== 100) throw new Error(`Mini Ledger V7 requirement weights total ${totalWeight}, not 100`);

for (const [group, expected] of [['public', 20], ['private', 80]]) {
  const weight = V7_REQUIREMENTS.filter((requirement) => requirement.group === group).reduce((sum, requirement) => sum + requirement.weight, 0);
  if (weight !== expected) throw new Error(`Mini Ledger V7 ${group} group weighs ${weight}, not ${expected}`);
}

for (const family of V7_FAMILIES) {
  for (const [group, expected] of [['public', 4], ['private', 16]]) {
    const weight = V7_REQUIREMENTS.filter((requirement) => requirement.family === family && requirement.group === group)
      .reduce((sum, requirement) => sum + requirement.weight, 0);
    if (weight !== expected) throw new Error(`Mini Ledger V7 ${family} ${group} weight is ${weight}, not ${expected}`);
  }
  for (const [scoreClass, expected] of [['atomic', 6], ['composed', 10]]) {
    const weight = V7_REQUIREMENTS
      .filter((requirement) => requirement.family === family && requirement.group === 'private')
      .reduce((sum, requirement) => sum + requirement.privateClassWeights[scoreClass], 0);
    if (weight !== expected) throw new Error(`Mini Ledger V7 ${family} private ${scoreClass} weight is ${weight}, not ${expected}`);
  }
}

for (const requirement of V7_REQUIREMENTS.filter(({ group }) => group === 'private')) {
  if (!requirement.privateClassWeights) throw new Error(`Mini Ledger V7 private requirement ${requirement.id} has no case classification`);
  const classified = requirement.privateClassWeights.atomic + requirement.privateClassWeights.composed;
  if (classified !== requirement.weight) throw new Error(`Mini Ledger V7 private requirement ${requirement.id} classifies ${classified} of ${requirement.weight} points`);
}
