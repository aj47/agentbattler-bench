import { MINI_LEDGER_V4_TURN_PROMPTS } from './terminal-prompts-v4.mjs';

export const MINI_LEDGER_V5_TURN_LIMIT_MINUTES = 30;
export const MINI_LEDGER_V5_TURN_LIMIT_MS = MINI_LEDGER_V5_TURN_LIMIT_MINUTES * 60 * 1_000;
export const MINI_LEDGER_V5_TIME_BUDGET_NOTICE = `This turn has a hard ${MINI_LEDGER_V5_TURN_LIMIT_MINUTES}-minute wall-clock limit enforced by the benchmark. Complete the requested work, run the most important checks you can, and leave the workspace in a runnable state before the limit. Do not rely on another message before saving your progress.`;

export const MINI_LEDGER_V5_TURN_PROMPTS = Object.freeze(
  MINI_LEDGER_V4_TURN_PROMPTS.map((prompt) => `${prompt}\n\n${MINI_LEDGER_V5_TIME_BUDGET_NOTICE}`),
);
