const version = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';

export const terminalChallengeVersion = version;
export const terminalChallengeRuntime = version === 'v7'
  ? {
      prompts: Object.freeze(Array.from({ length: 5 }, () => null)),
      publicVerifier: null,
      holdoutVerifier: null,
      descriptorDrivenPhases: true,
    }
  : version === 'v6'
  ? {
      prompts: (await import('./terminal-prompts-v6.mjs')).MINI_LEDGER_V6_TURN_PROMPTS,
      publicVerifier: await import('../benchmark/challenges/mini-ledger-v6/public-verifier.mjs'),
      holdoutVerifier: await import('../benchmark/challenges/mini-ledger-v6/holdout-verifier.mjs'),
    }
  : version === 'v5'
  ? {
      prompts: (await import('./terminal-prompts-v5.mjs')).MINI_LEDGER_V5_TURN_PROMPTS,
      publicVerifier: await import('../benchmark/challenges/mini-ledger-v4/public-verifier.mjs'),
      holdoutVerifier: await import('../benchmark/challenges/mini-ledger-v4/holdout-verifier.mjs'),
    }
  : version === 'v4'
  ? {
      prompts: (await import('./terminal-prompts-v4.mjs')).MINI_LEDGER_V4_TURN_PROMPTS,
      publicVerifier: await import('../benchmark/challenges/mini-ledger-v4/public-verifier.mjs'),
      holdoutVerifier: await import('../benchmark/challenges/mini-ledger-v4/holdout-verifier.mjs'),
    }
  : version === 'v3'
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
