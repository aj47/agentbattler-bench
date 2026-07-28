import { MINI_LEDGER_V4_TURN_PROMPTS } from './terminal-prompts-v4.mjs';

export const MINI_LEDGER_V5_TURN_LIMIT_MINUTES = 30;
export const MINI_LEDGER_V5_TURN_LIMIT_MS = MINI_LEDGER_V5_TURN_LIMIT_MINUTES * 60 * 1_000;
export const MINI_LEDGER_V5_TIME_BUDGET_NOTICE = `This turn has a hard ${MINI_LEDGER_V5_TURN_LIMIT_MINUTES}-minute wall-clock limit enforced by the benchmark. Complete the requested work, run the most important checks you can, and leave the workspace in a runnable state before the limit. Do not rely on another message before saving your progress.`;
export const MINI_LEDGER_V5_PROTOCOL_NOTICE = `The sealed CLI wire contract is exact: ledger.mjs is the only candidate source entry point and ledger.json is the primary live state. Every successful command emits exactly one JSON value and no other stdout. append and get emit the event object directly; query emits the event array directly; append-batch, export, import, recover, compact, replay, and audit emit an object directly. replay and audit must report success with ok:true or verified:true. Invalid input exits non-zero. Identical idempotent retries may either succeed with an explicit idempotent result or fail non-zero without mutation. Verifier checks run in fresh source-only workspaces, so correctness must not depend on files created during an earlier check.`;

export const MINI_LEDGER_V5_TURN_PROMPTS = Object.freeze(
  MINI_LEDGER_V4_TURN_PROMPTS.map((prompt) => `${prompt}\n\n${MINI_LEDGER_V5_PROTOCOL_NOTICE}\n\n${MINI_LEDGER_V5_TIME_BUDGET_NOTICE}`),
);
