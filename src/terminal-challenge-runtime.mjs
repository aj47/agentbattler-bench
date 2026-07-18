const version = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';

export const terminalChallengeVersion = version;
export const terminalChallengeRuntime = version === 'v3'
  ? {
      prompts: (await import('./terminal-prompts-v3.mjs')).MINI_LEDGER_V3_TURN_PROMPTS,
      publicVerifier: await import('../benchmark/challenges/mini-ledger-v3/public-verifier.mjs'),
      holdoutVerifier: await import('../benchmark/challenges/mini-ledger-v3/holdout-verifier.mjs'),
    }
  : {
      prompts: (await import('./terminal-prompts.mjs')).MINI_LEDGER_TURN_PROMPTS,
      publicVerifier: await import('../benchmark/challenges/mini-ledger-v2/public-verifier.mjs'),
      holdoutVerifier: await import('../benchmark/challenges/mini-ledger-v2/holdout-verifier.mjs'),
    };
