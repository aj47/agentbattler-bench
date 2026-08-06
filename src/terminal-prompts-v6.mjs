import { MINI_LEDGER_V4_TURN_PROMPTS } from './terminal-prompts-v4.mjs';

export const MINI_LEDGER_V6_TURN_LIMIT_MINUTES = 60;
export const MINI_LEDGER_V6_TURN_LIMIT_MS = MINI_LEDGER_V6_TURN_LIMIT_MINUTES * 60 * 1_000;

export const MINI_LEDGER_V6_TIME_BUDGET_NOTICE = `This turn has a hard ${MINI_LEDGER_V6_TURN_LIMIT_MINUTES}-minute wall-clock limit enforced by the benchmark. Save a runnable ledger.mjs early, implement before spending time on broad local stress tests, and stop cleanly after the most important checks. Do not rely on another message before saving your progress.`;

export const MINI_LEDGER_V6_SOURCE_NOTICE = `The candidate starts in an empty source-only workspace. ledger.mjs must be one self-contained regular file and is the only candidate source copied into every verifier workspace. Runtime files you create for local checks—including ledger.json, batches, exports, locks, journals, snapshots, and example events—are never supplied to a verifier. Do not hard-code example IDs such as a1 or a2, seed events, expected fixture data, or verifier-specific answers into ledger.mjs. The evaluator supplies all runtime arguments and fixtures.`;

export const MINI_LEDGER_V6_WIRE_NOTICE = `The CLI wire contract is exact. ledger.json is the primary live state. Every successful command emits exactly one JSON value and no other stdout. append and get emit the event object directly; query emits the event array directly; append-batch, export, import, recover, compact, replay, and audit emit an object directly. replay and audit report success with ok:true or verified:true. Invalid input exits non-zero and must not mutate primary or logical state. --limit and --keep accept only strictly positive integers (1 or greater); zero, negatives, fractions, missing values, and non-numbers are invalid. Identical idempotent retries may either succeed with an explicit idempotent result or fail non-zero without mutation.`;

export const MINI_LEDGER_V6_LOCK_NOTICE = `Concurrency may use any correct lock or compare-and-swap implementation. For recovery interoperability, ledger.lock is a reserved canonical stale-lock artifact: when recover finds a candidate-owned regular file named ledger.lock with no valid live-owner metadata, it must treat that file as stale, remove it safely, and continue. Normal mutations do not have to use ledger.lock, and an active lock with verifiable live ownership must never be stolen.`;

export const MINI_LEDGER_V6_DURABILITY_NOTICE = `Verifier-spawned candidate processes run under Node's permission model. Real durability barriers are supported through file handles: open the file with fs.promises.open(), then await FileHandle.sync() or FileHandle.datasync(), and close it. Node disables the descriptor-only fs.fsync(), fs.fdatasync(), fs.fsyncSync(), and fs.fdatasyncSync() APIs whenever its permission model is active, even for a file inside the workspace. Do not call those disabled APIs, and do not omit durability barriers; use the supported FileHandle methods instead.`;

export const MINI_LEDGER_V6_EVALUATION_NOTICE = `After each turn the evaluator checks that turn's public stage in a fresh source-only workspace. After turn 15 it reruns every public stage against the final ledger.mjs and scores that final-correctness matrix separately from the historical turn-by-turn trajectory. Preserve and locally regression-test all earlier behavior; a transient earlier pass does not compensate for a final regression.`;

const turnPrompts = [...MINI_LEDGER_V4_TURN_PROMPTS];

turnPrompts[0] = `Implement the v6 candidate contract in this empty isolated workspace. First leave a minimal executable ledger.mjs that can be exercised, then complete append --id ID --kind KIND --payload JSON and get --id ID. Use only Node.js built-ins; do not use packages, network, host files, secrets, or files outside the workspace. The logical ledger is a deterministic event store. Later turns will require query, append-batch, export, import, recover, compact, replay, and audit, so choose a maintainable state representation. Start sequence numbers at 1. The live v2 state shape is {schemaVersion:"agentbattler.ledger.v2",events:[{id,kind,payload,sequence}],nextSequence:integer}. Duplicate IDs and malformed inputs must fail without mutation. If you create a1/task {title:first} and a2/note {title:second} to test locally, create them only by invoking the CLI; they are disposable runtime fixtures and must never be embedded as source defaults. Modify only ledger.mjs.`;

turnPrompts[7] = `Preserve all earlier behavior. Implement compact --keep N, where N must be a strictly positive integer; --keep 0 and every other invalid value must fail without mutation. Compaction must create a checksummed snapshot for the prefix and retain only the requested tail in the live state. get, query, export, replay, and recover must transparently read the snapshot plus tail. The complete logical ledger before and after compaction must be identical. Compact a disposable local ledger with keep 3 and verify every record remains addressable. Modify only ledger.mjs.`;

turnPrompts[13] = `Preserve all earlier behavior. Complete a fault-injection and validation audit. Reject --limit 0, --keep 0, all negative/fractional/non-numeric limit and keep values, malformed JSON, duplicate IDs inside one batch, duplicate IDs against existing state, unknown import schemas, and idempotency-key reuse with different content without changing primary or logical state. Recover safely from the canonical stale regular ledger.lock described below and from a valid newer ledger.json.tmp, but reject malformed temporary state while preserving a valid primary. Prove that no command reads or writes outside the workspace. Modify only ledger.mjs.`;

const protocolNotice = [
  MINI_LEDGER_V6_SOURCE_NOTICE,
  MINI_LEDGER_V6_WIRE_NOTICE,
  MINI_LEDGER_V6_LOCK_NOTICE,
  MINI_LEDGER_V6_DURABILITY_NOTICE,
  MINI_LEDGER_V6_EVALUATION_NOTICE,
  MINI_LEDGER_V6_TIME_BUDGET_NOTICE,
].join('\n\n');

export const MINI_LEDGER_V6_TURN_PROMPTS = Object.freeze(
  turnPrompts.map((prompt) => `${prompt}\n\n${protocolNotice}`),
);
